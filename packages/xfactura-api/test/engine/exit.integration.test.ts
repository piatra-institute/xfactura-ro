import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../../source/engine/http/app';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { ProposalView } from '../../source/engine/kernel/views';
import { FakeTaxpayers } from './fakes/anaf-taxpayers';
import { iban } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import { pdfDocument, show } from './fixtures/pdf';
import { scenario, secret, type Scenario } from './scenario';

/*
 * Phase 1's exit, joined: an MCP client holding a scoped agent grant keeps a small SRL's books
 * for four months by itself, from the worklist. People act only where the engine requires one:
 * they drop files in, answer a question, approve batches and reviewed actions, renew the grant,
 * and correct one automatic posting. Every party, number, text and amount is synthetic and
 * written by hand; the expected figures are worked in the comments, never by the engine.
 */

const publicUrl = 'http://localhost:3000';
const day = 86_400_000;

// Synthetic CUIs with valid control digits.
const COMPANY = '12345674';
/** The monthly supplier whose invoices graduate: hosting, e-mail and backups, all on 628. */
const CLOUD = '22334451';
/** The operating lease of the company car B-123-XFA, used for business and privately. */
const LEASING = '33445560';
/** Office supplies, invoiced on paper and scanned to a PDF with a text layer. */
const BIROTICA = '44556670';
const CLIENT = '55667789';
/** The stationer whose receipt arrives as a photo. */
const PAPETARIA = '66778898';

/** What only the owner knows: how the car is used (Codul fiscal art. 298). */
const vehicles: Record<string, { use: 'mixed'; from: string }> = {
  B123XFA: { use: 'mixed', from: '2026-01-01' },
};
const plateKey = (plate: string) => plate.toUpperCase().replace(/[\s-]/g, '');

// The MCP client.

type OperationInfo = { effect: string; approval: string; agent: boolean };
type ToolResult = {
  isError?: boolean;
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
};
/** One call the agent made, as the harness saw it. */
type Call = {
  seq: number;
  operation: string;
  tool: string;
  ok: boolean;
  code: string | null;
  /** Neither granted nor a discovery operation every grant has. */
  outsideGrant: boolean;
  /** An operation only a person may perform. */
  humanOnly: boolean;
  /** An approval or decision. */
  approval: boolean;
};

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`);
  }
}

function errorOf(result: ToolResult) {
  const text = result.content.find((block) => block.type === 'text');
  const parsed = JSON.parse(text && 'text' in text ? text.text : '{}') as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  return {
    code: parsed.error?.code ?? 'UNKNOWN',
    message: parsed.error?.message ?? '',
    details: parsed.error?.details,
  };
}

const discovery = new Set(['capabilities.list', 'capabilities.search', 'capabilities.describe']);
const approvals = /(^|\.)approve$|^actions\.reject$|^policies\.(create|revoke)$/;

/**
 * The agent's only way into the books: an MCP client over the API's Streamable HTTP route with a
 * bearer grant. Operations the server lists as tools are called directly, the others through
 * `capabilities.invoke`. Every call is logged with what the harness knows of it.
 */
class McpSession {
  private constructor(
    private readonly client: Client,
    readonly tools: ReadonlySet<string>,
    readonly granted: ReadonlySet<string>,
    private readonly operations: ReadonlyMap<string, OperationInfo>,
    private readonly calls: Call[],
    private readonly afterChange: () => Promise<void>,
  ) {}

  static async connect(options: {
    app: ReturnType<typeof createApp>['app'];
    companyId: string;
    token: string;
    granted: ReadonlySet<string>;
    operations: ReadonlyMap<string, OperationInfo>;
    calls: Call[];
    afterChange: () => Promise<void>;
  }) {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${publicUrl}/api/accounting/v1/companies/${options.companyId}/mcp`),
      {
        authProvider: { token: async () => options.token },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          request.headers.set('host', new URL(request.url).host);
          return options.app.fetch(request);
        },
      },
    );
    const client = new Client({ name: 'xfactura-exit-test', version: '1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return new McpSession(
      client,
      new Set(tools.map((tool) => tool.name)),
      options.granted,
      options.operations,
      options.calls,
      options.afterChange,
    );
  }

  async raw(operation: string, input: unknown): Promise<ToolResult> {
    const info = this.operations.get(operation);
    const mutating = info ? info.effect !== 'read' : true;
    const direct = this.tools.has(operation);
    const key = mutating ? { idempotencyKey: randomUUID() } : {};
    const record: Call = {
      seq: this.calls.length + 1,
      operation,
      tool: direct ? operation : 'capabilities.invoke',
      ok: false,
      code: null,
      outsideGrant: !this.granted.has(operation) && !discovery.has(operation),
      humanOnly: info ? !info.agent || info.approval === 'human' : false,
      approval: approvals.test(operation),
    };
    this.calls.push(record);
    const result = (await this.client.callTool({
      name: record.tool,
      arguments: direct ? { input, ...key } : { id: operation, input, ...key },
    })) as ToolResult;
    record.ok = !result.isError;
    if (result.isError) record.code = errorOf(result).code;
    else if (mutating) await this.afterChange();
    return result;
  }

  async call<T>(operation: string, input: unknown = {}): Promise<T> {
    const result = await this.raw(operation, input);
    if (result.isError) {
      const error = errorOf(result);
      throw new Refused(error.code, error.message, error.details);
    }
    return result.structuredContent as T;
  }

  close() {
    return this.client.close();
  }
}

// What the agent reads.

type Step = {
  operation: string;
  by: 'agent' | 'human';
  allowed: boolean;
  inputHint: Record<string, unknown>;
};
type WorkItem = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  severity: string;
  fingerprint: string;
  details: Record<string, unknown>;
  next: Step[];
};
type Party = { name: string; taxId: string | null; country: string };
type DocumentDetail = {
  id: string;
  kind: string;
  date: string;
  number: string | null;
  partyId: string | null;
  authority: string;
  body: {
    supplier: Party;
    customer: Party;
    lines: { description: string }[];
  };
  checks: { code: string; status: string }[] | null;
  citations: { items: { field: string; status: string }[] } | null;
};
type QuestionView = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  status: 'open' | 'answered' | 'withdrawn';
  agentId: string | null;
  answer: { value: Record<string, unknown> } | null;
};
type Line = { page: number; line: number; text: string };
type Imported = {
  statements: { from: string; to: string; opening: string; closing: string; added: number }[];
  mapping?: { version: number; saved: boolean };
  citations: { verified: number; unverified: string[] };
};
type TemplateView = {
  id: string;
  version: number;
  treatment: string;
  scope: { partyId?: string; documentKind?: string };
  mapping: Record<string, unknown>;
  revoked: boolean;
  paused: boolean;
};
/** What the agent's own vision model reads on a photo: the receipt and where it saw each field. */
type Reading = { body: Record<string, unknown>; citations: Record<string, Line> };

const decimal = (printed: string) => printed.replace(/\./g, '').replace(',', '.');
const folded = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
const monthEnd = (month: string) => {
  const [year, mm] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year!, mm!, 0)).getUTCDate()).padStart(2, '0')}`;
};
/** Expense accounts by supplier: the agent's own judgment, standing in for a model's. */
const expenseAccounts: Record<string, string> = {
  [CLOUD]: '628',
  [LEASING]: '612',
  [BIROTICA]: '604',
};
const deductionFor = (value: Record<string, unknown>) =>
  value.use === 'mixed' && !value.exception ? 'limited' : 'full';

/**
 * A scripted bookkeeper that works only from the worklist (`work.list`, `by: agent`) and takes
 * only the steps the engine marks `allowed` for it. It reads files with `evidence.read`, records
 * what it read with citations, proposes, asks, revises with a basis, gathers what needs no
 * acknowledgement into batches, executes what people approved, and requests templates, policies
 * and closes. It never approves anything.
 */
class Bookkeeper {
  session!: McpSession;
  readonly calls: Call[] = [];
  /** The worklist steps it took, by item kind. */
  readonly taken: { kind: string; operation: string; allowed: boolean }[] = [];
  readonly notes: string[] = [];
  /** Kinds it leaves to others: returns and yearly determinations belong to a tax agent or a
   * person, and settlements' templates to a later request. */
  readonly skipped = new Set<string>();
  /** Results kept for the assertions. */
  readonly imports: { operation: string; result: Imported }[] = [];
  readonly asked: (QuestionView & { reused: boolean })[] = [];
  readonly images: { mediaType: string; bytes: number }[] = [];
  readonly batches: string[] = [];

  constructor(private readonly vision: ReadonlyMap<string, Reading>) {}

  private call<T>(operation: string, input: unknown = {}) {
    return this.session.call<T>(operation, input);
  }

  private async take<T = unknown>(item: WorkItem, step: Step, input: unknown = step.inputHint) {
    this.taken.push({ kind: item.kind, operation: step.operation, allowed: step.allowed });
    return this.call<T>(step.operation, input);
  }

  async worklist() {
    const items: WorkItem[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.call<{ items: WorkItem[]; next: string | null }>('work.list', {
        by: 'agent',
        limit: 200,
        ...(after ? { after } : {}),
      });
      items.push(...result.items);
      if (!result.next) break;
      after = result.next;
    }
    return items;
  }

  /** Works the worklist until nothing it may do is left; returns how many steps it took. */
  async turn() {
    let actions = 0;
    const tried = new Set<string>();
    for (let pass = 0; pass < 200; pass++) {
      let acted = false;
      for (const item of await this.worklist()) {
        const key = `${item.id}|${item.fingerprint}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const steps = item.next.filter((step) => step.by === 'agent' && step.allowed);
        if (steps.length && (await this.handle(item, steps))) {
          actions += 1;
          acted = true;
          break;
        }
      }
      if (!acted) break;
    }
    if (await this.batch()) actions += 1;
    return actions;
  }

  private async handle(item: WorkItem, steps: Step[]): Promise<boolean> {
    const step = (operation: string) =>
      steps.find((candidate) => candidate.operation === operation);
    /** The worklist's step proposing a treatment: the operation called through MCP. */
    const proposing = (treatment: string) =>
      steps.find(
        (candidate) =>
          candidate.operation === 'proposals.propose' &&
          candidate.inputHint.treatment === treatment,
      );
    switch (item.kind) {
      case 'evidence.unused': {
        const read = step('evidence.read');
        if (!read) return false;
        this.taken.push({ kind: item.kind, operation: read.operation, allowed: read.allowed });
        return this.intake(item);
      }
      case 'close.finding': {
        // Bank findings are explained movement by movement (bank.unexplained).
        const check = step('parties.checkStatus');
        if (!check) return false;
        await this.take(item, check);
        return true;
      }
      case 'document.unproposed': {
        const propose = proposing('invoices.recognize');
        if (!propose) return false;
        const proposal = await this.recognize(propose);
        if (!proposal) return false;
        await this.take(item, propose, proposal);
        return true;
      }
      case 'question.needed': {
        const ask = step('questions.ask');
        if (ask) {
          this.asked.push(await this.take(item, ask));
          return true;
        }
        const revise = step('proposals.revise');
        if (!revise) return false;
        await this.take(item, revise, await this.answered(revise.inputHint));
        return true;
      }
      case 'proposal.stale':
      case 'proposal.approved':
      case 'action.approved':
      case 'template.graduation':
      case 'period.unclosed': {
        const [first] = steps.filter((candidate) => candidate.operation !== 'proposals.get');
        if (!first) return false;
        await this.take(item, first);
        return true;
      }
      case 'bank.unexplained': {
        const settle = proposing('bank.settle');
        if (!settle) return false;
        const proposal = await this.settle(settle);
        if (!proposal) return false;
        await this.take(item, settle, proposal);
        return true;
      }
      case 'template.candidate': {
        // It requests templates for documents only; the supplier's payments keep going through
        // batches.
        const request = step('templates.request');
        const scope = request?.inputHint.scope as { treatment?: string } | undefined;
        if (!request || scope?.treatment !== 'invoices.recognize') {
          this.skipped.add(`${item.kind} ${scope?.treatment}`);
          return false;
        }
        // The hint names the car when the bookings did: its deduction follows the owner's answer.
        const vehicle = (request.inputHint.mapping as { vehicle?: string } | undefined)?.vehicle;
        await this.take(item, request, {
          ...request.inputHint,
          name: vehicle
            ? `Leasing operațional autoturism ${vehicle}`
            : 'Servicii lunare de găzduire, e-mail și copii de siguranță',
        });
        return true;
      }
      case 'question.open':
        // Asked: it waits for a person's answer (withdrawing it is for a question no longer
        // needed).
        return false;
      case 'obligation.due':
      case 'determination.missing':
      case 'threshold.approaching':
        this.skipped.add(item.kind);
        return false;
      default:
        this.notes.push(`${item.kind} ${item.id}: left (${steps.map((s) => s.operation)})`);
        return false;
    }
  }

  // Intake.

  private async lines(id: string): Promise<Line[]> {
    const lines: Line[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 50; round++) {
      const read = await this.call<{
        pages: { page: number; lines: { line: number; text: string }[] }[];
        next: string | null;
      }>('evidence.read', { id, mode: 'text', ...(cursor ? { cursor } : {}) });
      for (const page of read.pages)
        for (const line of page.lines) lines.push({ page: page.page, ...line });
      if (!read.next) break;
      cursor = read.next;
    }
    return lines;
  }

  private async intake(item: WorkItem) {
    const id = item.subject.id;
    const meta = await this.call<{ format: string; encoding: string | null; reading: string }>(
      'evidence.read',
      { id, mode: 'meta' },
    );
    switch (meta.format) {
      case 'xml':
        await this.call('invoices.import', { evidenceId: id });
        return true;
      case 'csv':
        return this.csv(id, meta.encoding ?? 'utf-8');
      case 'pdf': {
        const lines = await this.lines(id);
        return lines[0]?.text.startsWith('EXTRAS DE CONT')
          ? this.statement(id, lines)
          : this.invoice(id, lines);
      }
      case 'image':
        return this.receipt(id);
      default:
        this.notes.push(`evidence ${id}: ${meta.format} not read`);
        return false;
    }
  }

  private async account(text: string) {
    const found = text.match(/RO\d{2}[A-Z]{4}[A-Z0-9]{16}/)?.[0];
    const accounts = await this.call<{ items: { id: string; iban: string | null }[] }>(
      'treasury.accounts',
    );
    return accounts.items.find((account) => account.iban === found)?.id;
  }

  /** A bank's CSV export: the account's mapping if it has one, else the one read off the file. */
  private async csv(id: string, encoding: string) {
    const lines = await this.lines(id);
    const texts = lines.map((line) => line.text);
    const accountId = await this.account(texts.join('\n'));
    const months = texts.flatMap((text) => text.match(/^\d{2}\.(\d{2})\.(\d{4});/) ?? []);
    const month = `${months[2]}-${months[1]}`;
    const input = {
      evidenceId: id,
      accountId,
      period: { from: `${month}-01`, to: monthEnd(month) },
    };
    try {
      this.imports.push({
        operation: 'bank.importCsv',
        result: await this.call<Imported>('bank.importCsv', input),
      });
    } catch (error) {
      if (!(error instanceof Refused) || error.code !== 'BANK_MAPPING_MISSING') throw error;
      const header = texts.findIndex((text) => text.startsWith('Data;'));
      // The export's own encoding gives ţ (cedilla) where the bank prints ț: read by folding.
      const opening = texts.findIndex((text) => folded(text).startsWith('SOLDINI'));
      const mapping = {
        separator: ';',
        encoding,
        dateFormat: 'DD.MM.YYYY',
        decimal: ',',
        headerRows: header + 1,
        footerRows: 1,
        columns: {
          date: 'Data',
          description: ['Descriere'],
          debit: 'Debit',
          credit: 'Credit',
          counterparty: 'Beneficiar / Plătitor',
        },
        balances: {
          from: 'cells',
          opening: { row: opening + 1, column: 4 },
          closing: { row: -1, column: 4 },
        },
      };
      this.imports.push({
        operation: 'bank.importCsv',
        result: await this.call<Imported>('bank.importCsv', { ...input, mapping }),
      });
    }
    return true;
  }

  /** A statement printed as a PDF, transcribed row by row with the line each amount is on. */
  private async statement(id: string, lines: Line[]) {
    const accountId = await this.account(lines.map((line) => line.text).join('\n'));
    const at = (line: Line, text: string) => ({ page: line.page, line: line.line, text });
    const balance = (prefix: string) => {
      const line = lines.find((candidate) => candidate.text.startsWith(prefix))!;
      const printed = line.text.match(/([\d.]+,\d{2}) RON$/)![1]!;
      return { amount: decimal(printed), citation: at(line, printed) };
    };
    const period = lines[1]!.text.match(/(\d{2})\.(\d{2})\.(\d{4}) - (\d{2})\.(\d{2})\.(\d{4})/)!;
    const entries = lines.flatMap((line) => {
      const row = line.text.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(.+?)\s+(-?[\d.]+,\d{2})$/);
      if (!row) return [];
      return [
        {
          date: `${row[3]}-${row[2]}-${row[1]}`,
          amount: decimal(row[5]!),
          description: row[4]!.replace(/\s+/g, ' '),
          citation: at(line, row[5]!),
        },
      ];
    });
    const result = await this.call<Imported>('bank.recordStatement', {
      evidenceId: id,
      accountId,
      statement: {
        number: lines[0]!.text.replace('EXTRAS DE CONT nr. ', 'EXTRAS '),
        from: `${period[3]}-${period[2]}-${period[1]}`,
        to: `${period[6]}-${period[5]}-${period[4]}`,
        opening: balance('Sold inițial'),
        closing: balance('Sold final'),
        entries,
      },
    });
    this.imports.push({ operation: 'bank.recordStatement', result });
    return true;
  }

  /** An invoice printed as a PDF: its fields and the lines that show them. */
  private async invoice(id: string, lines: Line[]) {
    const find = (pattern: RegExp) => {
      for (const line of lines) {
        const match = line.text.match(pattern);
        if (match) return { line, match };
      }
      throw new Error(`No line matches ${pattern}`);
    };
    const cite = (found: { line: Line }, text: string) => ({
      page: found.line.page,
      line: found.line.line,
      text,
    });
    const heading = find(/^Seria (\w+) nr\. (\d+) din (\d{2})\.(\d{2})\.(\d{4})$/);
    const supplier = find(/^Furnizor: (.+), CIF: (RO\d+)$/);
    const customer = find(/^Client: (.+), CUI: (RO\d+)$/);
    const net = find(/^Total fără TVA: ([\d.]+,\d{2}) lei$/);
    const tax = find(/^TVA (\d+)%: ([\d.]+,\d{2}) lei$/);
    const gross = find(/^Total de plată: ([\d.]+,\d{2}) lei$/);
    const item = lines[customer.line.line]!;
    const [, series, number, dd, mm, yyyy] = heading.match;
    const amounts = {
      net: decimal(net.match[1]!),
      tax: decimal(tax.match[2]!),
      gross: decimal(gross.match[1]!),
    };
    await this.call('documents.record', {
      evidenceId: id,
      kind: 'invoice.received',
      body: {
        number: `${series} ${number}`,
        issueDate: `${yyyy}-${mm}-${dd}`,
        currency: 'RON',
        supplier: { name: supplier.match[1], taxId: supplier.match[2], country: 'RO' },
        customer: { name: customer.match[1], taxId: customer.match[2], country: 'RO' },
        lines: [
          { description: item.text, net: amounts.net, vatCategory: 'S', vatRate: tax.match[1] },
        ],
        taxes: [{ base: amounts.net, tax: amounts.tax, category: 'S', rate: tax.match[1] }],
        totals: amounts,
      },
      citations: {
        number: cite(heading, `${series} nr. ${number}`),
        issueDate: cite(heading, `${dd}.${mm}.${yyyy}`),
        'supplier.taxId': cite(supplier, `CIF: ${supplier.match[2]}`),
        'customer.taxId': cite(customer, customer.match[2]!),
        'totals.net': cite(net, net.match[1]!),
        'totals.tax': cite(tax, tax.match[2]!),
        'totals.gross': cite(gross, `Total de plată: ${gross.match[1]}`),
      },
    });
    return true;
  }

  /** A photo: no text layer, so the image goes to the agent's own vision model. */
  private async receipt(id: string) {
    const result = await this.session.raw('evidence.read', { id, mode: 'image' });
    if (result.isError) throw new Refused(errorOf(result).code, errorOf(result).message);
    const image = result.content.find((block) => block.type === 'image');
    if (!image || image.type !== 'image') throw new Error('No image block');
    const bytes = Buffer.from(image.data, 'base64');
    this.images.push({ mediaType: image.mimeType, bytes: bytes.length });
    const reading = this.vision.get(createHash('sha256').update(bytes).digest('hex'));
    if (!reading) {
      this.notes.push(`evidence ${id}: the photo could not be read`);
      return false;
    }
    await this.call('documents.record', {
      evidenceId: id,
      kind: 'receipt.received',
      body: reading.body,
      citations: reading.citations,
    });
    return true;
  }

  // Bookings.

  private async templates() {
    return (await this.call<{ items: TemplateView[] }>('templates.list')).items;
  }

  /** The answered `vehicle.use` question about a plate, if a person already answered one. */
  private async answeredVehicle(plate: string) {
    const questions = await this.call<{ items: QuestionView[] }>('questions.list', {
      kind: 'vehicle.use',
      status: 'answered',
      limit: 200,
    });
    return questions.items.find((question) => plateKey(question.subject.id) === plate);
  }

  /** What the agent proposes for a document, from the worklist's step: the treatment, the input
   * it starts from completed by the agent's judgment, and the basis it cites. */
  private async recognize(step: Step) {
    const start = step.inputHint.input as { documentId: string };
    const documentId = start.documentId;
    const document = await this.call<DocumentDetail>('documents.get', { id: documentId });
    if (!['invoice.received', 'invoice.issued'].includes(document.kind)) return null;
    const sale = document.kind === 'invoice.issued';
    const counterparty = (sale ? document.body.customer : document.body.supplier).taxId ?? '';
    const template = (await this.templates()).find(
      (candidate) =>
        candidate.treatment === 'invoices.recognize' &&
        !candidate.revoked &&
        candidate.scope.partyId === document.partyId &&
        candidate.scope.documentKind === document.kind,
    );
    let input: Record<string, unknown> = { ...start };
    let basis: { answers: string[]; template?: string } | undefined;
    if (template) {
      // What the template makes of the document, citing it; a car's deduction is the owner's
      // answer, which the engine cites with the template.
      input = { ...input, ...template.mapping };
      if (typeof input.vehicle === 'string') {
        const answered = await this.answeredVehicle(plateKey(input.vehicle));
        if (!answered?.answer) return null;
        input.deduction = deductionFor(answered.answer.value);
      }
      basis = { answers: [], template: template.id };
    } else {
      input.account = sale ? '704' : (expenseAccounts[counterparty.replace(/^RO/, '')] ?? '628');
      const text = document.body.lines.map((line) => line.description).join(' ');
      const plate = sale ? null : text.match(/\b[A-Z]{1,2}[- ]?\d{2,3}[- ]?[A-Z]{3}\b/)?.[0];
      if (plate) {
        input.vehicle = plate;
        // A car a person already spoke for: the answer holds until it changes, so the question
        // is asked again only to cite it; the engine returns it without asking anyone.
        if (await this.answeredVehicle(plateKey(plate))) {
          const asked = await this.call<QuestionView & { reused: boolean }>('questions.ask', {
            kind: 'vehicle.use',
            subject: { kind: 'vehicle', id: plate },
            params: { documentId, date: document.date },
          });
          this.asked.push(asked);
          input.deduction = deductionFor(asked.answer!.value);
          basis = { answers: [asked.id] };
        }
      }
    }
    return { treatment: 'invoices.recognize', input, ...(basis ? { basis } : {}) };
  }

  /** A revision citing the answers, with the deduction each `vehicle.use` answer allows. */
  private async answered(hint: Record<string, unknown>) {
    const basis = hint.basis as { answers: string[] };
    const questions = (
      await this.call<{ items: QuestionView[] }>('questions.list', { limit: 200 })
    ).items.filter((question) => basis.answers.includes(question.id));
    const input = { ...(hint.input as Record<string, unknown>) };
    for (const question of questions)
      if (question.kind === 'vehicle.use' && question.answer)
        input.deduction = deductionFor(question.answer.value);
    return { ...hint, input };
  }

  /** A movement paying or collecting the one open item whose document it names. */
  private async settle(step: Step) {
    const { movementId } = step.inputHint.input as { movementId: string };
    const movements = await this.call<{
      items: { id: string; amount: string; reference: string; counterparty: string | null }[];
    }>('bank.movements', { state: 'unexplained' });
    const movement = movements.items.find((item) => item.id === movementId);
    if (!movement) return null;
    // Only what is still open: a booking reversed and made again leaves a cleared item behind.
    const items = await this.call<{ items: { id: string; document: string | null }[] }>(
      'openItems.list',
      { openOnly: true },
    );
    const text = folded(`${movement.reference} ${movement.counterparty ?? ''}`);
    const matches = items.items.filter(
      (item) => item.document && text.includes(folded(item.document)),
    );
    if (matches.length !== 1) {
      this.notes.push(`movement ${movementId}: ${matches.length} open items match`);
      return null;
    }
    return {
      treatment: 'bank.settle',
      input: {
        movementId,
        allocations: [{ openItem: matches[0]!.id, amount: movement.amount.replace(/^-/, '') }],
      },
    };
  }

  /** Its proposals that need no acknowledgement, not yet in a batch, approved together. */
  private async batch() {
    const proposed = await this.call<{ items: ProposalView[] }>('proposals.list', {
      status: 'proposed',
      limit: 200,
    });
    const pending = new Set<string>();
    for (const status of ['requested', 'approved'])
      for (const action of (
        await this.call<{ items: ActionView[] }>('actions.list', {
          kind: 'proposals.batch',
          status,
          limit: 200,
        })
      ).items)
        for (const member of (action.preview as { members: { proposalId: string }[] }).members)
          pending.add(member.proposalId);
    const ready = proposed.items.filter(
      (proposal) =>
        proposal.agentId !== null &&
        !pending.has(proposal.id) &&
        proposal.issues.every((issue) => issue.severity === 'info'),
    );
    if (!ready.length) return false;
    const request = await this.call<ActionView>('proposals.batch.request', {
      members: ready.map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    this.batches.push(request.id);
    return true;
  }
}

// The company's files, as the owner drops them in.

type File = { filename: string; mediaType: string; bytes: Uint8Array | string };
const xml = (filename: string, input: Parameters<typeof invoiceXml>[0]): File => ({
  filename,
  mediaType: 'application/xml',
  bytes: invoiceXml({ company: COMPANY, ...input }),
});
/** The monthly supplier's three invoices of a month: 121.00 + 60.50 + 96.80 = 278.30 lei. */
const cloud = (month: string, date: '05' | '12' | '19') => {
  const lines = {
    '05': { net: '100.00', tax: '21.00', gross: '121.00', name: 'Găzduire servere' },
    '12': { net: '50.00', tax: '10.50', gross: '60.50', name: 'Servicii e-mail' },
    '19': { net: '80.00', tax: '16.80', gross: '96.80', name: 'Copii de siguranță' },
  }[date];
  const number = `CS-${month.slice(5)}${date}`;
  return xml(`${number}.xml`, {
    number,
    date: `${month}-${date}`,
    counterparty: CLOUD,
    net: lines.net,
    tax: lines.tax,
    gross: lines.gross,
    lines: [{ rate: '21', net: lines.net, name: lines.name }],
  });
};
/** The car's monthly operating lease: 1,500.00 + 315.00 VAT; half the VAT deductible. */
const lease = (month: string) =>
  xml(`AL-${month.slice(5)}01.xml`, {
    number: `AL-${month.slice(5)}01`,
    date: `${month}-05`,
    counterparty: LEASING,
    net: '1500.00',
    tax: '315.00',
    gross: '1815.00',
    lines: [
      {
        rate: '21',
        net: '1500.00',
        name: `Rată leasing operațional autoturism B-123-XFA, ${month}`,
      },
    ],
  });
const sale = xml('PS-0001.xml', {
  number: 'PS-0001',
  date: '2026-01-15',
  direction: 'sale',
  counterparty: CLIENT,
  net: '5000.00',
  tax: '1050.00',
  gross: '6050.00',
  lines: [{ rate: '21', net: '5000.00', name: 'Dezvoltare aplicație, ianuarie 2026' }],
});
/** A paper invoice scanned with a text layer: 200.00 + 42.00 = 242.00 lei. */
const birotica: File = {
  filename: 'factura-BIR-17.pdf',
  mediaType: 'application/pdf',
  bytes: pdfDocument([
    {
      content: [
        show(72, 780, 'FACTURĂ FISCALĂ', 14),
        show(72, 750, 'Seria BIR nr. 17 din 12.01.2026'),
        show(72, 730, `Furnizor: Birotica SRL, CIF: RO${BIROTICA}`),
        show(72, 710, `Client: Pilot SRL, CUI: RO${COMPANY}`),
        show(72, 680, 'Hârtie și toner pentru birou'),
        show(72, 650, 'Total fără TVA: 200,00 lei'),
        show(72, 630, 'TVA 21%: 42,00 lei'),
        show(72, 610, 'Total de plată: 242,00 lei'),
      ].join('\n'),
    },
  ]),
};
/** A PNG's signature and header (1200 × 1600), as a phone photo starts; nothing decodes it. */
const photo = (() => {
  const bytes = new Uint8Array(96);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 1200);
  new DataView(bytes.buffer).setUint32(20, 1600);
  bytes.set(Buffer.from('bon fiscal 0042 Papetaria'), 40);
  return bytes;
})();
const receipt: File = { filename: 'bon-0042.png', mediaType: 'image/png', bytes: photo };
/** What a vision model reads on that photo. */
const receiptReading: Reading = {
  body: {
    seller: { name: 'Papetăria SRL', taxId: `RO${PAPETARIA}`, country: 'RO' },
    buyerTaxId: COMPANY,
    number: '0042',
    register: '4400012345',
    issueDate: '2026-03-04',
    time: '14:22',
    currency: 'RON',
    lines: [{ description: 'Hârtie A4', gross: '24.20', vatRate: '21' }],
    taxes: [{ rate: '21', gross: '24.20', tax: '4.20' }],
    totals: { gross: '24.20', tax: '4.20' },
    payment: 'card',
  },
  citations: { 'totals.gross': { page: 1, line: 6, text: 'TOTAL 24,20' } },
};

/** Windows-1250 for the letters the bank's exports use; the rest is ASCII. */
const cp1250: Record<string, number> = { ă: 0xe3, â: 0xe2, î: 0xee, ș: 0xba, ț: 0xfe, Î: 0xce };
const windows1250 = (text: string) =>
  new Uint8Array([...text].map((character) => cp1250[character] ?? character.charCodeAt(0)));
/** The bank's CSV export: debit and credit columns, decimal commas, balances on lines of their
 * own. */
const csvStatement = (filename: string, opening: string, rows: string[], closing: string) => ({
  filename,
  mediaType: 'text/csv',
  bytes: windows1250(
    [
      `Extras de cont;${iban};;;`,
      `Sold inițial;;;${opening};`,
      'Data;Descriere;Debit;Credit;Beneficiar / Plătitor',
      ...rows,
      `Sold final;;;${closing};`,
      '',
    ].join('\r\n'),
  ),
});
// January: 10,000.00 − 121.00 (CS-0105) − 242.00 (BIR 17) = 9,637.00.
const january = csvStatement(
  'extras-ianuarie.csv',
  '10.000,00',
  [
    '25.01.2026;Plata factura CS-0105;121,00;;CloudServ SRL',
    '28.01.2026;Plata factura BIR 17;242,00;;Birotica SRL',
  ],
  '9.637,00',
);
// February, printed: 9,637.00 + 6,050.00 (PS-0001) − 60.50 (CS-0112) − 96.80 (CS-0119)
// − 1,815.00 (AL-0201) = 13,714.70.
const february: File = {
  filename: 'extras-februarie.pdf',
  mediaType: 'application/pdf',
  bytes: pdfDocument([
    {
      content: [
        show(72, 790, 'EXTRAS DE CONT nr. 2/2026', 12),
        show(72, 770, `IBAN ${iban}   Perioada 01.02.2026 - 28.02.2026`),
        show(72, 740, 'Sold inițial la 01.02.2026: 9.637,00 RON'),
        show(72, 720, '12.02.2026   Incasare factura PS-0001 Client SRL   6.050,00'),
        show(72, 700, '20.02.2026   Plata factura CS-0112 CloudServ SRL   -60,50'),
        show(72, 680, '20.02.2026   Plata factura CS-0119 CloudServ SRL   -96,80'),
        show(72, 660, '26.02.2026   Plata factura AL-0201 AutoLeasing SRL   -1.815,00'),
        show(72, 630, 'Sold final la 28.02.2026: 13.714,70 RON'),
      ].join('\n'),
    },
  ]),
};
// March: 13,714.70 − 121.00 (CS-0205) − 60.50 (CS-0212) = 13,533.20.
const march = csvStatement(
  'extras-martie.csv',
  '13.714,70',
  [
    '25.03.2026;Plata factura CS-0205;121,00;;CloudServ SRL',
    '25.03.2026;Plata factura CS-0212;60,50;;CloudServ SRL',
  ],
  '13.533,20',
);

// The run.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

describe('Phase 1 exit: an MCP agent keeps four months of books, people approve', () => {
  let now = Date.parse('2026-01-02T09:00:00Z');
  const taxpayers = new FakeTaxpayers();
  for (const cui of [CLOUD, LEASING, BIROTICA, CLIENT, PAPETARIA]) taxpayers.taxpayer(cui);
  const vision = new Map<string, Reading>([
    [createHash('sha256').update(photo).digest('hex'), receiptReading],
  ]);
  const agent = new Bookkeeper(vision);
  const grants: string[] = [];
  /** What people did, beyond dropping files in. */
  const people = { answers: 0, decisions: [] as string[], approvals: [] as string[][] };
  let s: Scenario;
  let app: ReturnType<typeof createApp>['app'];
  let operations: Map<string, OperationInfo>;

  /** The worker: the audit log's consumers and the queued jobs, until nothing is left. */
  const worker = async () => {
    for (let round = 0; round < 200; round++) {
      const projected = await s.engine.consumers.runOnce();
      const ran = await s.engine.jobs.runOne();
      if (!projected && !ran) return;
    }
    throw new Error('The worker did not settle.');
  };

  /** The owner issues the agent's grant (at most 90 days) and the agent connects over MCP. */
  const connect = async () => {
    const grant = await s.invoke<{ id: string; token: string; scopes: string[] }>(
      s.owner,
      'agents.issue',
      {
        name: 'Agent contabil MCP',
        scopes: [
          'toolset:inbox',
          'toolset:bank',
          'toolset:books',
          'toolset:review',
          'toolset:close',
          'toolset:reference',
          'templates.request',
          'policies.request',
          'parties.checkStatus',
        ],
        expiresAt: new Date(now + 89 * day).toISOString(),
      },
    );
    // No operation a person must perform is in it.
    expect(
      grant.scopes.filter((scope) => {
        const info = operations.get(scope);
        return !info || !info.agent || info.approval === 'human';
      }),
    ).toEqual([]);
    await agent.session?.close();
    agent.session = await McpSession.connect({
      app,
      companyId: s.company.id,
      token: grant.token,
      granted: new Set(grant.scopes),
      operations,
      calls: agent.calls,
      afterChange: worker,
    });
    grants.push(grant.id);
  };

  /** People, where the engine needs one: the owner answers what only the owner knows; the
   * reviewer decides reviewed actions on their previews and approves alone each proposal whose
   * warning a person must acknowledge, after comparing it with the original. */
  const persons = async () => {
    let count = 0;
    for (const question of await s.list<QuestionView>(s.owner, 'questions.list', {
      status: 'open',
      limit: 200,
    })) {
      const fact = question.kind === 'vehicle.use' && vehicles[plateKey(question.subject.id)];
      if (!fact) continue;
      await s.invoke(s.owner, 'questions.answer', { questionId: question.id, value: fact });
      people.answers += 1;
      count += 1;
    }
    for (const action of await s.list<ActionView>(s.reviewer, 'actions.list', {
      status: 'requested',
      limit: 200,
    })) {
      const preview = action.preview as {
        findings?: unknown[];
        report?: { met: boolean };
        backtest?: { differing: number };
      };
      // Every finding was resolved through the worklist before anyone was asked to decide.
      expect(preview.findings ?? [], `${action.operation} ${action.id}`).toEqual([]);
      if (preview.report) expect(preview.report.met).toBe(true);
      if (preview.backtest) expect(preview.backtest.differing).toBe(0);
      await s.invoke(s.reviewer, 'actions.approve', {
        id: action.id,
        previewHash: action.previewHash,
      });
      people.decisions.push(action.operation);
      count += 1;
    }
    for (const proposal of await s.list<ProposalView>(s.reviewer, 'proposals.list', {
      status: 'proposed',
      limit: 200,
    })) {
      const warnings = proposal.issues
        .filter((issue) => issue.severity === 'ack')
        .map((issue) => issue.code);
      if (!proposal.agentId || !warnings.length) continue;
      // Only an extraction is acknowledged, after looking at the PDF.
      expect(warnings).toEqual(['SOURCE_EXTRACTED']);
      await s.approve(proposal, s.reviewer, warnings);
      people.approvals.push(warnings);
      count += 1;
    }
    if (count) await worker();
    return count;
  };

  /** A day: the clock moves, the owner drops the day's files in, then the agent and the people
   * take turns until neither has anything left to do. */
  const on = async (date: string, files: File[] = []) => {
    now = Date.parse(`${date}T09:00:00Z`);
    for (const file of files)
      await s.invoke(s.owner, 'evidence.record', {
        filename: file.filename,
        mediaType: file.mediaType,
        base64: Buffer.from(file.bytes).toString('base64'),
      });
    await worker();
    for (let round = 0; round < 30; round++) {
      const acted = (await agent.turn()) + (await persons());
      if (!acted) return;
    }
    throw new Error(`${date}: the agent and the people did not settle`);
  };

  const proposals = () => s.list<ProposalView>(s.owner, 'proposals.list', { limit: 200 });
  const documentNamed = async (number: string) => {
    const found = (
      await s.list<{ id: string; number: string | null; partyId: string | null }>(
        s.owner,
        'documents.list',
        {},
      )
    ).find((document) => document.number === number);
    if (!found) throw new Error(`No document ${number}`);
    return found;
  };
  const proposalFor = async (number: string) => {
    const document = await documentNamed(number);
    const found = (await proposals()).find(
      (proposal) => proposal.subject === `document:${document.id}`,
    );
    if (!found) throw new Error(`No proposal for ${number}`);
    return found;
  };
  const closed = async () =>
    (await s.list<{ month: string; state: string }>(s.owner, 'periods.list', {}))
      .filter((period) => period.state === 'closed')
      .map((period) => period.month);
  const ownerWork = async (kinds: string[]) =>
    (await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', { kinds, limit: 200 })).items;

  test('setup: people configure the company and grant a scoped agent, which connects over MCP', async () => {
    s = await scenario({ cui: COMPANY, clock: () => now, taxpayers });
    open.push(s);
    app = createApp(s.engine, { publicUrl, authSecret: secret }).app;
    operations = new Map(
      s.engine.operations
        .all()
        .map((operation) => [
          operation.id,
          { effect: operation.effect, approval: operation.approval, agent: operation.agent },
        ]),
    );
    // What only people configure: the VAT registration, the bank account and the opening
    // balance (10,000.00 lei paid-in capital in the bank).
    const { id: certificate } = await s.evidence('certificat-tva.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: certificate,
    });
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const { id: opening } = await s.evidence('balanta-deschidere.pdf');
    await s.book('ledger.general', {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'SOLD-INITIAL',
      description: 'Solduri inițiale',
      evidenceId: opening,
      lines: [
        { account: '5121', side: 'D', amount: '10000.00' },
        { account: '1012', side: 'C', amount: '10000.00' },
      ],
    });
    await connect();
    // A grant this wide lists its intake and review core as tools; the rest goes through
    // capabilities.invoke, under the same checks.
    expect(agent.session.tools).toContain('work.list');
    expect(agent.session.tools).toContain('capabilities.invoke');
    expect(agent.session.tools).not.toContain('proposals.approve');
    expect(agent.session.tools).not.toContain('actions.approve');
  });

  test('January: e-Factura, a PDF read with citations and a CSV statement, approved in batches', async () => {
    await on('2026-01-06', [cloud('2026-01', '05')]);
    await on('2026-01-13', [cloud('2026-01', '12'), birotica]);
    await on('2026-01-16', [sale]);
    await on('2026-01-20', [cloud('2026-01', '19')]);
    await on('2026-01-30', [january]);

    // The PDF: recorded by the agent from its text layer, every cited field verified.
    const read = await s.invoke<DocumentDetail>(s.owner, 'documents.get', {
      id: (await documentNamed('BIR 17')).id,
    });
    expect(read.authority).toBe('extracted');
    expect(read.citations!.items.map((item) => item.status)).toEqual(Array(7).fill('verified'));
    expect(
      Object.fromEntries(read.checks!.map((check) => [check.code, check.status])),
    ).toMatchObject({
      COMPANY_PARTY: 'passed',
      TOTALS: 'passed',
      TAX_IDS: 'passed',
      CITATIONS: 'passed',
    });
    // Its booking carried the extraction warning: a person approved it alone.
    const extracted = await proposalFor('BIR 17');
    expect(extracted).toMatchObject({
      status: 'posted',
      approval: { approverId: s.reviewer.actorId },
    });
    expect(extracted.approval!.batchId).toBeUndefined();
    expect(people.approvals).toEqual([['SOURCE_EXTRACTED']]);
    // The routine bookings were approved in batches the agent requested.
    for (const number of ['CS-0105', 'CS-0112', 'CS-0119', 'PS-0001'])
      expect((await proposalFor(number)).approval?.batchId).toEqual(expect.any(String));
    // The CSV export, with the mapping the agent read off the file, kept for the account.
    expect(agent.imports[0]).toMatchObject({
      operation: 'bank.importCsv',
      result: {
        statements: [{ opening: '10000.00', closing: '9637.00', added: 2 }],
        mapping: { version: 1, saved: true },
      },
    });
    expect(
      agent.calls.filter((call) => !call.ok).map((call) => `${call.operation} ${call.code}`),
    ).toEqual(['bank.importCsv BANK_MAPPING_MISSING']);
    const movements = await s.list<{ state: string }>(s.owner, 'bank.movements', {});
    expect(movements.map((movement) => movement.state)).toEqual(['settled', 'settled']);
    expect(agent.batches.length).toBeGreaterThanOrEqual(3);
    // The books start on 1 January 2026: no return of 2025 is asked about, and an SRL owes no
    // D212.
    const returns = await ownerWork(['obligation.due']);
    expect(returns.filter((item) => item.subject.id.split('|')[1]!.startsWith('2025'))).toEqual([]);
    expect(returns.filter((item) => item.subject.id.startsWith('D212|'))).toEqual([]);
  });

  test('February: the car asks a question, a template is made from the hint, a PDF statement', async () => {
    // January is closed on the 3rd, once it has ended.
    await on('2026-02-03');
    expect(await closed()).toEqual(['2026-01']);

    await on('2026-02-06', [cloud('2026-02', '05'), lease('2026-02')]);
    // The lease names the car: the treatment asked how it is used; the worklist sent the agent
    // to ask, the owner answered, and the agent revised citing the answer.
    const car = await proposalFor('AL-0201');
    const vehicle = await s.list<QuestionView>(s.owner, 'questions.list', {
      kind: 'vehicle.use',
    });
    expect(vehicle).toHaveLength(1);
    expect(vehicle[0]).toMatchObject({
      subject: { kind: 'vehicle', id: 'B123XFA' },
      status: 'answered',
      agentId: grants[0],
      answer: { value: { use: 'mixed', from: '2026-01-01' } },
    });
    expect(
      agent.taken.filter((step) => step.kind === 'question.needed').map((step) => step.operation),
    ).toEqual(['questions.ask', 'proposals.revise']);
    expect(car).toMatchObject({ status: 'posted', version: 2 });
    // The plate as the invoice prints it; the engine asked about it in one spelling.
    expect(
      (await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: car.id })).input,
    ).toMatchObject({ account: '612', vehicle: 'B-123-XFA', deduction: 'limited' });
    expect(car.basis?.answers.map((answer) => answer.questionId)).toEqual([vehicle[0]!.id]);
    // Mixed use: half of the 315.00 lei VAT is deducted, the other half stays in 612.
    expect(car.effect?.taxEntries).toMatchObject([
      { code: 'S-21', base: '1500.00', amount: '315.00', deductible: '157.50' },
    ]);
    expect(car.approval?.batchId).toEqual(expect.any(String));

    // Three January bookings and one in February: the worklist suggested a template, the agent
    // requested it from the hint, the reviewer approved it on its backtest.
    expect(
      agent.taken
        .filter((step) => step.kind === 'template.candidate')
        .map((step) => step.operation),
    ).toEqual(['templates.request']);
    const [template] = await s.list<TemplateView>(s.owner, 'templates.list', {});
    expect(template).toMatchObject({
      treatment: 'invoices.recognize',
      scope: { documentKind: 'invoice.received' },
      mapping: { account: '628', deduction: 'full' },
    });

    await on('2026-02-13', [cloud('2026-02', '12')]);
    await on('2026-02-20', [cloud('2026-02', '19')]);
    for (const number of ['CS-0212', 'CS-0219'])
      expect(await proposalFor(number)).toMatchObject({
        status: 'posted',
        basis: { template: { id: template!.id, version: 1 } },
      });

    await on('2026-02-27', [february]);
    expect(agent.imports.at(-1)).toMatchObject({
      operation: 'bank.recordStatement',
      result: {
        statements: [{ opening: '9637.00', closing: '13714.70', added: 4 }],
        citations: { verified: 6, unverified: [] },
      },
    });
  });

  test('March: the same car reuses the answer, a receipt photo stops, the CSV mapping is reused', async () => {
    await on('2026-03-03');
    expect(await closed()).toEqual(['2026-01', '2026-02']);

    await on('2026-03-06', [cloud('2026-03', '05'), lease('2026-03'), receipt]);
    // The second invoice for the car: nobody is asked again.
    const reuse = agent.asked.at(-1)!;
    expect(reuse).toMatchObject({ reused: true, status: 'answered' });
    expect(await s.list(s.owner, 'questions.list', { kind: 'vehicle.use' })).toHaveLength(1);
    expect(people.answers).toBe(1);
    const car = await proposalFor('AL-0301');
    // Its proposal never raised the question, and checking the month's new suppliers at ANAF
    // made nothing stale: the first version was posted.
    expect(car).toMatchObject({ status: 'posted', version: 1 });
    expect(car.issues.map((issue) => issue.code)).not.toContain('VEHICLE_USE');
    expect(agent.taken.filter((step) => step.kind === 'question.needed')).toHaveLength(2);
    expect(car.effect?.taxEntries).toMatchObject([{ amount: '315.00', deductible: '157.50' }]);

    // The photo went to the agent's vision model as an image; what it read is recorded, its
    // citations unverifiable. The worklist offers its booking (receipts.recognize), which this
    // agent, booking invoices only, leaves to a person: it waits.
    expect(agent.images).toEqual([{ mediaType: 'image/png', bytes: photo.length }]);
    const [read] = await s.list<{ id: string; authority: string }>(s.owner, 'documents.list', {
      kinds: ['receipt.received'],
    });
    expect(read).toMatchObject({ authority: 'extracted' });
    const detail = await s.invoke<DocumentDetail>(s.owner, 'documents.get', { id: read!.id });
    expect(detail.citations!.items.map((item) => item.status)).toEqual(['unverified']);
    const [waiting] = (await ownerWork(['document.unproposed'])).filter(
      (item) => item.subject.id === read!.id,
    );
    expect(waiting).toMatchObject({ severity: 'warn' });
    expect(waiting!.next.filter((step) => step.by === 'agent')).toMatchObject([
      { operation: 'proposals.propose', inputHint: { treatment: 'receipts.recognize' } },
    ]);
    expect(
      (await proposals()).some((proposal) => proposal.subject === `document:${read!.id}`),
    ).toBe(false);

    await on('2026-03-13', [cloud('2026-03', '12')]);
    await on('2026-03-20', [cloud('2026-03', '19')]);
    await on('2026-03-28', [march]);
    // The second export of the same bank: the account's mapping, nothing proposed again.
    expect(agent.imports.at(-1)).toMatchObject({
      operation: 'bank.importCsv',
      result: {
        statements: [{ opening: '13714.70', closing: '13533.20', added: 2 }],
        mapping: { version: 1, saved: false },
      },
    });

    // A grant lasts at most 90 days: before it ends, the owner issues the next one.
    now = Date.parse('2026-03-30T09:00:00Z');
    await connect();
    expect(grants).toHaveLength(2);
  });

  test('April: the template graduates and posts by itself beside the car; a reversal demotes it and the invoice is booked again', async () => {
    await on('2026-04-02');
    expect(await closed()).toEqual(['2026-01', '2026-02', '2026-03']);

    await on('2026-04-06', [cloud('2026-04', '05')]);
    const [template] = await s.list<TemplateView>(s.owner, 'templates.list', {});
    const performance = await s.invoke<{ versions: { months: unknown[] }[] }>(
      s.owner,
      'templates.performance',
      { templateId: template!.id },
    );
    // Six correct predictions across three months: two in February, three in March, one in April.
    expect(performance.versions[0]!.months).toEqual([
      { month: '2026-02', correct: 2, corrected: 0, rejected: 0, pending: 0 },
      { month: '2026-03', correct: 3, corrected: 0, rejected: 0, pending: 0 },
      { month: '2026-04', correct: 1, corrected: 0, rejected: 0, pending: 0 },
    ]);
    expect(
      agent.taken
        .filter((step) => step.kind === 'template.graduation')
        .map((step) => step.operation),
    ).toEqual(['policies.request']);
    const [policy] = await s.list<{
      id: string;
      requestId: string | null;
      paused: boolean;
      validFrom: string;
    }>(s.owner, 'policies.list', {});
    expect(policy).toMatchObject({ paused: false, validFrom: '2026-04-01' });
    expect(policy!.requestId).toEqual(expect.any(String));

    // The car's lease arrives beside the hosting invoice: another supplier, outside the hosting
    // template's scope, so the policy goes on posting by itself.
    await on('2026-04-13', [cloud('2026-04', '12'), lease('2026-04')]);
    expect(await proposalFor('AL-0401')).toMatchObject({
      status: 'posted',
      approval: { batchId: expect.any(String) },
    });
    await on('2026-04-20', [cloud('2026-04', '19')]);
    for (const number of ['CS-0412', 'CS-0419'])
      expect(await proposalFor(number)).toMatchObject({
        status: 'posted',
        approval: null,
        entry: { policyId: policy!.id },
      });
    expect((await s.list<{ paused: boolean }>(s.owner, 'policies.list', {}))[0]).toMatchObject({
      paused: false,
    });
    // Three leases in three months: the car gets a template of its own, from the worklist's hint,
    // naming the car; what it deducts follows the owner's answer.
    const lessor = await documentNamed('AL-0401');
    const car = (await s.list<TemplateView>(s.owner, 'templates.list', {})).find(
      (item) => item.scope.partyId === lessor.partyId,
    );
    expect(car).toMatchObject({
      treatment: 'invoices.recognize',
      mapping: { account: '612', vehicle: 'B-123-XFA' },
    });

    // A person finds one automatic posting premature and reverses it; the worker demotes the
    // policy in the system's name and the worklist asks a person to look.
    now = Date.parse('2026-04-22T09:00:00Z');
    const wrong = await proposalFor('CS-0419');
    const { id: note } = await s.invoke<{ id: string }>(s.reviewer, 'evidence.record', {
      filename: 'nota-storno-CS-0419.pdf',
      mediaType: 'application/pdf',
      base64: Buffer.from('Notă de stornare CS-0419 (sintetic)').toString('base64'),
    });
    const reversal = await s.invoke<ProposalView>(s.reviewer, 'ledger.reverse.propose', {
      entryId: wrong.entry!.id,
      date: '2026-04-22',
      reason:
        'Contabilizată automat înainte ca furnizorul să confirme serviciul: se stornează și se înregistrează din nou.',
      evidenceId: note,
      method: 'red',
    });
    await s.post(await s.approve(reversal, s.owner), s.owner);
    await worker();
    const [demoted] = await s.list<{ id: string; paused: boolean }>(s.owner, 'policies.list', {});
    expect(demoted).toMatchObject({ id: policy!.id, paused: true });
    const [attention] = await ownerWork(['automation.paused']);
    expect(attention).toMatchObject({
      subject: { kind: 'policy', id: policy!.id },
      details: { trigger: 'reversal', system: true },
    });
    expect(attention!.next.map((step) => `${step.operation}/${step.by}`)).toEqual([
      'automation.resume/human',
      'policies.revoke/human',
    ]);
    // The reversal frees the invoice: the worklist sends the agent to book it again, and with the
    // policy paused a person approves it in a batch.
    await on('2026-04-22');
    const bookings = (await proposals()).filter((proposal) => proposal.subject === wrong.subject);
    expect(bookings.map((proposal) => proposal.status)).toEqual(['posted', 'posted']);
    expect(bookings[1]).toMatchObject({
      agentId: expect.any(String),
      approval: { batchId: expect.any(String) },
      entry: { policyId: null },
      basis: { template: { id: template!.id, version: 1 } },
    });
  });

  test('May: April is closed, and the four months hold together', async () => {
    await on('2026-05-04');
    expect(await closed()).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(people.decisions.filter((operation) => operation === 'periods.close')).toHaveLength(4);
    await agent.session.close();

    // The agent: only MCP, only its grant, never an approval, only the steps it was allowed.
    const calls = agent.calls;
    expect(calls.filter((call) => call.outsideGrant).map((call) => call.operation)).toEqual([]);
    expect(
      calls.filter((call) => call.approval || call.humanOnly).map((call) => call.operation),
    ).toEqual([]);
    expect(agent.taken.filter((step) => !step.allowed)).toEqual([]);
    expect(
      calls.filter((call) => !call.ok).map((call) => `${call.operation} ${call.code}`),
    ).toEqual(['bank.importCsv BANK_MAPPING_MISSING']);
    expect(agent.notes).toEqual([]);
    // Left to others: the tax returns and yearly determinations, and a template for the
    // supplier's payments.
    expect(
      [...agent.skipped].filter(
        (kind) =>
          ![
            'obligation.due',
            'determination.missing',
            'threshold.approaching',
            'template.candidate bank.settle',
          ].includes(kind),
      ),
    ).toEqual([]);

    // The audit log: everything the agent did is under its grants; people did only what the
    // engine requires of a person (configuration, files, an answer, approvals, the correction).
    const events: { operation: string; actor?: { userId: string; agentId: string | null } }[] = [];
    let after = 0;
    for (let page = 0; page < 50; page++) {
      const feed = await s.invoke<{ items: typeof events; next: string | null }>(
        s.owner,
        'events.since',
        { after, limit: 500 },
      );
      events.push(...feed.items);
      if (!feed.next) break;
      after = Number(feed.next);
    }
    const byAgent = new Set(
      events.filter((event) => event.actor?.agentId).map((event) => event.operation),
    );
    for (const operation of [
      'invoices.import',
      'documents.record',
      'bank.importCsv',
      'bank.recordStatement',
      'questions.ask',
      // A proposal is recorded under its treatment's own operation, whichever form proposed it.
      'invoices.recognize.propose',
      'invoices.recognize.revise',
      'bank.settle.propose',
      'proposals.batch.request',
      'actions.execute',
      'templates.request',
      'policies.request',
      'periods.close.request',
      'parties.checkStatus',
    ])
      expect(byAgent).toContain(operation);
    expect(
      events
        .filter((event) => event.actor?.agentId)
        .every((event) => grants.includes(event.actor!.agentId!)),
    ).toBe(true);
    const byPeople = new Set(
      events
        .filter((event) => event.actor && !event.actor.agentId && event.actor.userId !== 'system')
        .map((event) => event.operation),
    );
    expect(
      [...byPeople].filter(
        (operation) =>
          ![
            'company.create',
            'company.invite',
            'company.acceptInvitation',
            'profile.record',
            'treasury.createAccount',
            'evidence.record',
            'ledger.general.propose',
            'ledger.reverse.propose',
            'proposals.approve',
            'ledger.post',
            'agents.issue',
            'questions.answer',
            'actions.approve',
          ].includes(operation),
      ),
    ).toEqual([]);
    // Every booking of a document or a movement was the agent's.
    for (const proposal of await proposals())
      if (/^(invoices|bank)\./.test(proposal.treatment))
        expect(proposal.agentId, proposal.subject).toEqual(expect.any(String));

    // The books balance, and the bank account agrees with the last statement.
    const balance = await s.trialBalance();
    const totals = Object.values(balance.totals);
    expect(totals.length).toBeGreaterThan(0);
    for (const total of totals) expect(total.debit).toBe(total.credit);
    const bank = balance.rows.find((row) => row.account === '5121')!;
    expect(bank.closing).toEqual({ debit: '13533.20', credit: '0.00' });

    // The VAT journals list each invoice of the four months as its document states it: the
    // car's VAT half deducted, the reversed invoice mirrored and booked again, the receipt
    // absent.
    type Row = { taxPeriod: string; document: string | null; vat: string; deductible: string };
    const journal = async (direction: 'input' | 'output') =>
      (
        await s.invoke<{ rows: Row[] }>(s.owner, 'vat.journal', {
          direction,
          from: '2026-01',
          to: '2026-04',
        })
      ).rows
        .map((row) => `${row.taxPeriod} ${row.document} ${row.vat} ${row.deductible}`)
        .sort();
    const documents = await s.list<{
      kind: string;
      number: string;
      date: string;
      partyId: string;
      totals: { tax: string } | null;
    }>(s.owner, 'documents.list', {});
    const leasing = await documentNamed('AL-0201');
    const expected = { input: [] as string[], output: [] as string[] };
    for (const document of documents) {
      if (!document.kind.startsWith('invoice.')) continue;
      const tax = document.totals!.tax;
      const period = document.date.slice(0, 7);
      if (document.kind === 'invoice.issued')
        expected.output.push(`${period} ${document.number} ${tax} 0.00`);
      else {
        const half = (Number(tax) / 2).toFixed(2);
        const deductible = document.partyId === leasing.partyId ? half : tax;
        expected.input.push(`${period} ${document.number} ${tax} ${deductible}`);
        if (document.number === 'CS-0419')
          expected.input.push(
            `${period} ${document.number} -${tax} -${deductible}`,
            `${period} ${document.number} ${tax} ${deductible}`,
          );
      }
    }
    // Twelve monthly invoices, the scanned one, three leases, the reversal and the new booking.
    expect(expected.input).toHaveLength(18);
    expect(await journal('input')).toEqual(expected.input.sort());
    expect(await journal('output')).toEqual(expected.output.sort());
    expect(await journal('output')).toEqual(['2026-01 PS-0001 1050.00 0.00']);
  });
});
