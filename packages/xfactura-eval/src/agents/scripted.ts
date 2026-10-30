import type { Agent, AgentFactory, Outcome } from './agent';
import { errorOf, type Session } from './session';

/*
 * The scripted agent: a deterministic baseline with no model. It follows the worklist through
 * MCP and decides with simple rules (accounts by keyword, a PDF read by its labels, a CSV mapping
 * guessed from its header), so that CI exercises the whole harness and the scores have a floor.
 * It cannot read photos, and it never calls an operation its grant does not list.
 */

type WorkItem = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  fingerprint: string;
  details?: Record<string, unknown>;
  next: { operation: string; by: 'agent' | 'human'; inputHint: Record<string, unknown> }[];
};
type Proposal = {
  id: string;
  version: number;
  status: string;
  treatment: string;
  issues: { code: string; severity: string; details?: { question?: unknown } }[];
};
type Party = { name: string; taxId: string; country: string };
type InvoiceBody = {
  number: string;
  issueDate: string;
  currency: string;
  supplier: Party;
  customer: Party;
  lines: { description: string }[];
  taxes: { category: string }[];
  totals: { net: string };
};
type Line = { page: number; line: number; text: string };

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Text without diacritics or case, for keyword rules. */
const folded = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Expense accounts by keyword, the first match winning; 628 otherwise. */
const expenseRules: [RegExp, string][] = [
  [/internet|telefon|telecom|mobil|fibra/, '626'],
  [/chirie|rent|leasing|coworking/, '612'],
  [/asigur|insurance|rca|casco/, '613'],
  [/combustibil|benzina|motorina|carburant|fuel/, '6022'],
  [/energie|electric|gaze|apa /, '605'],
  [/comision|bancar/, '627'],
];
const yearly = /abonament anual|annual|yearly|12 luni/;
/** A proposal blocked for a reason no answer settles (not a question): a person takes it up. */
const refused = (proposal: Proposal) =>
  proposal.issues.some((issue) => issue.severity === 'block' && !issue.details?.question);
const plate = /\b([A-Z]{1,2})[- ]?(\d{2,3})[- ]?([A-Z]{3})\b/;

/** A decimal amount printed either way (1.234,56 or 1,234.56) as 1234.56. */
function amountOf(text: string): string | null {
  const match = /-?\d[\d.,]*/.exec(text);
  if (!match) return null;
  let value = match[0];
  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma > dot) value = value.replace(/\./g, '').replace(',', '.');
  else value = value.replace(/,/g, '');
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

class ScriptedAgent implements Agent {
  private session!: Session;
  private calls = 0;
  private granted: Set<string> | null = null;
  /** Items handled, by id and fingerprint; those waiting on a person are tried again later. */
  private readonly done = new Set<string>();
  private readonly waiting = new Set<string>();

  async run(session: Session): Promise<Outcome> {
    this.session = session;
    this.granted ??= new Set(
      (await this.call<{ items: { id: string }[] }>('capabilities.search', {})).items.map(
        (item) => item.id,
      ),
    );
    for (const key of this.waiting) this.done.delete(key);
    this.waiting.clear();
    for (let step = 0; step < 300; step++) {
      const items = await this.work();
      const item = items.find((candidate) => !this.done.has(this.key(candidate)));
      if (!item) return { status: 'done' };
      this.done.add(this.key(item));
      try {
        // Work waiting on a person (an open question) is taken up again in the next round.
        if ((await this.handle(item)) === 'wait') this.waiting.add(this.key(item));
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
    }
    return { status: 'done', note: 'step limit' };
  }

  private key(item: WorkItem) {
    return `${item.id}|${item.fingerprint}`;
  }

  /** Runs an operation through its own tool, or through capabilities.invoke. */
  private async call<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    if (this.granted && !this.granted.has(operation))
      throw new Refused('NOT_GRANTED', `${operation} is not in the grant`);
    const idempotencyKey = `scripted-${String(++this.calls).padStart(6, '0')}`;
    const direct = this.session.tools.some((tool) => tool.name === operation);
    const result = direct
      ? await this.session.call(operation, { input, idempotencyKey })
      : await this.session.call('capabilities.invoke', { id: operation, input, idempotencyKey });
    if (result.isError) {
      const error = errorOf(result);
      throw new Refused(error.code, error.message);
    }
    if (result.structuredContent) return result.structuredContent as T;
    const text = result.content.find((block) => block.type === 'text');
    return JSON.parse(text && 'text' in text ? text.text : '{}') as T;
  }

  private async all<T>(operation: string, input: Record<string, unknown> = {}) {
    const items: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.call<{ items: T[]; next: string | null }>(operation, {
        ...input,
        ...(after ? { after } : {}),
      });
      items.push(...result.items);
      if (!result.next) break;
      after = result.next;
    }
    return items;
  }

  private work() {
    return this.all<WorkItem>('work.list', { by: 'agent', limit: 200 });
  }

  private async handle(item: WorkItem): Promise<'wait' | void> {
    const step = item.next.find((candidate) => candidate.by === 'agent');
    switch (item.kind) {
      case 'evidence.unused':
        await this.file(item.subject.id);
        return;
      case 'document.unproposed':
        return this.document(item.subject.id);
      case 'question.needed':
        if (step?.operation === 'questions.ask') {
          await this.call('questions.ask', step.inputHint);
          return 'wait';
        }
        if (step?.operation === 'proposals.revise') await this.reviseWithAnswers(step);
        return;
      case 'proposal.stale':
        if (step?.operation === 'proposals.revise')
          await this.call('proposals.revise', step.inputHint);
        return;
      case 'proposal.approved':
        if (step?.operation === 'ledger.post') await this.call('ledger.post', step.inputHint);
        return;
      case 'bank.unexplained':
        return this.movement(item.subject.id);
      default:
        return;
    }
  }

  // Files.

  private async lines(id: string): Promise<Line[]> {
    const lines: Line[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const read: {
        pages?: { page: number; lines: { line: number; text: string }[] }[];
        next: string | null;
      } = await this.call('evidence.read', { id, mode: 'text', ...(cursor ? { cursor } : {}) });
      for (const item of read.pages ?? [])
        for (const line of item.lines) lines.push({ page: item.page, ...line });
      cursor = read.next;
      if (!cursor) break;
    }
    return lines;
  }

  private async file(id: string) {
    const meta = await this.call<{ format: string; reading: string; encoding: string | null }>(
      'evidence.read',
      { id, mode: 'meta' },
    );
    if (meta.reading !== 'text') return; // A photo: no vision here; a person reads it.
    const lines = await this.lines(id);
    const text = lines.map((line) => line.text).join('\n');
    if (meta.format === 'xml') {
      if (/<(Invoice|CreditNote)\b/.test(text))
        return this.call('invoices.import', { evidenceId: id });
      if (/camt\.053/.test(text))
        return this.call('bank.import', { evidenceId: id, financialYearId: await this.year() });
      return;
    }
    if (/^:20:/m.test(text) && /^:60F:/m.test(text))
      return this.call('bank.import', { evidenceId: id, financialYearId: await this.year() });
    if (meta.format === 'csv') return this.csv(id, lines, meta.encoding ?? 'utf-8');
    if (meta.format === 'pdf') return this.pdf(id, lines);
  }

  private async year() {
    const years = await this.all<{ id: string; kind: string }>('years.list');
    return years.find((year) => year.kind === 'financial')!.id;
  }

  /** A bank CSV: the header row named Data/Debit/Credit, balances on rows of their own. */
  private async csv(id: string, lines: Line[], encoding: string) {
    const rows = lines.map((line) => line.text).filter((text) => text.trim());
    const separator =
      (rows[0]!.match(/;/g)?.length ?? 0) >= (rows[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
    const cells = rows.map((row) => row.split(separator));
    const header = cells.findIndex((row) => row.some((cell) => /^data$/i.test(cell.trim())));
    if (header < 0) return;
    const titles = cells[header]!.map((cell) => cell.trim());
    const find = (pattern: RegExp) => titles.find((title) => pattern.test(folded(title)));
    const data = cells
      .slice(header + 1)
      .filter((row) => /^\d{2}[./-]\d{2}[./-]\d{4}/.test(row[0]!.trim()));
    const last = cells.indexOf(data.at(-1)!);
    const balanceCell = (pattern: RegExp, index: number) => {
      const row = cells[index];
      if (!row || !pattern.test(folded(row[0] ?? ''))) return null;
      const column = row.findIndex((cell, at) => at > 0 && amountOf(cell) !== null);
      return column < 0 ? null : { row: index + 1, column: column + 1 };
    };
    const opening = balanceCell(/sold (initial|anterior)/, header - 1);
    const closing = balanceCell(/sold final/, last + 1);
    const accounts = await this.all<{ id: string; iban: string | null; kind: string }>(
      'treasury.accounts',
    );
    const account =
      accounts.find((candidate) => candidate.iban && rows.join(' ').includes(candidate.iban)) ??
      accounts.find((candidate) => candidate.kind === 'bank');
    if (!account) return;
    const mapping = {
      separator,
      encoding,
      dateFormat: /^\d{2}\.\d{2}\.\d{4}/.test(data[0]?.[0] ?? '') ? 'DD.MM.YYYY' : 'DD/MM/YYYY',
      decimal: data.some((row) => row.some((cell) => /\d,\d{2}$/.test(cell.trim()))) ? ',' : '.',
      headerRows: header + 1,
      footerRows: cells.length - 1 - last,
      columns: {
        date: titles[0],
        description: [find(/descriere|detalii|description/)].filter(Boolean),
        ...(find(/^debit/) ? { debit: find(/^debit/) } : {}),
        ...(find(/^credit/) ? { credit: find(/^credit/) } : {}),
        ...(find(/beneficiar|platitor|counterparty/)
          ? { counterparty: find(/beneficiar|platitor|counterparty/) }
          : {}),
      },
      ...(opening && closing
        ? { balances: { from: 'cells', opening, closing: { row: -1, column: closing.column } } }
        : {}),
    };
    const dates = data.map((row) => row[0]!.trim().split(/[./-]/).reverse().join('-')).sort();
    const month = dates[0]!.slice(0, 7);
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
      .toISOString()
      .slice(0, 10);
    await this.call('bank.importCsv', {
      evidenceId: id,
      accountId: account.id,
      mapping,
      period: { from: `${month}-01`, to: lastDay },
    });
  }

  /** An invoice printed with labels, in English or Romanian. */
  private async pdf(id: string, lines: Line[]) {
    const citations: Record<string, Line> = {};
    const find = (field: string, pattern: RegExp) => {
      for (const line of lines) {
        const match = pattern.exec(line.text);
        if (match) {
          citations[field] = { page: line.page, line: line.line, text: match[0] };
          return match;
        }
      }
      return null;
    };
    const number =
      find('number', /invoice (?:number|no\.?):?\s*(\S+)/i)?.[1] ??
      (() => {
        const match = find('number', /seria\s+(\S+)\s+nr\.?\s*(\S+)/i);
        return match ? `${match[1]} ${match[2]}` : null;
      })();
    const iso = find('issueDate', /invoice date:?\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
    const romanian = iso ? null : find('issueDate', /(\d{2})\.(\d{2})\.(\d{4})/);
    const issueDate = iso ?? (romanian ? `${romanian[3]}-${romanian[2]}-${romanian[1]}` : null);
    const net = find('totals.net', /(?:subtotal|valoare|total f[aă]r[aă] tva):?\s*([\d.,]+)/i)?.[1];
    const tax = find('totals.tax', /(?:vat amount|tva):?\s*([\d.,]+)/i)?.[1];
    const gross = find('totals.gross', /(?:total due|total de plat[aă]):?\s*([\d.,]+)/i)?.[1];
    const supplierVat =
      find('supplier.taxId', /^vat id:?\s*([A-Z]{2}[0-9A-Z]+)/i)?.[1] ??
      find('supplier.taxId', /furnizor:.*?(?:cif|cui):?\s*((?:RO)?\d+)/i)?.[1];
    const customerVat =
      find('customer.taxId', /customer vat id:?\s*([A-Z]{2}[0-9A-Z]+)/i)?.[1] ??
      find('customer.taxId', /(?:cump[aă]r[aă]tor|client):.*?(?:cif|cui):?\s*((?:RO)?\d+)/i)?.[1];
    if (!number || !issueDate || !net || !gross || !supplierVat || !customerVat) return;
    const all = lines.map((line) => line.text).join('\n');
    const supplierName = /furnizor:\s*([^,]+),/i.exec(all)?.[1] ?? lines[0]!.text.trim();
    const customerName =
      /(?:bill to|cump[aă]r[aă]tor|client):\s*([^,]+)/i.exec(all)?.[1] ?? 'Client';
    const description =
      /description:\s*(.+)/i.exec(all)?.[1] ??
      lines.find(
        (line) => !line.text.includes(':') && /servicii|services|abonament/i.test(line.text),
      )?.text ??
      'Servicii';
    const country = (taxId: string) =>
      /^[A-Z]{2}/.test(taxId) && !taxId.startsWith('RO') ? taxId.slice(0, 2) : 'RO';
    const currency = /\bEUR\b/.test(all) ? 'EUR' : /\bUSD\b/.test(all) ? 'USD' : 'RON';
    const netAmount = amountOf(net)!;
    const taxAmount = tax ? amountOf(tax)! : '0.00';
    const category =
      Number(taxAmount) > 0 ? 'S' : /reverse charge|taxare invers/i.test(all) ? 'AE' : 'O';
    const rate =
      category === 'S'
        ? String(Math.round((Number(taxAmount) / Number(netAmount)) * 100))
        : category === 'AE'
          ? '0'
          : null;
    const party = (name: string, taxId: string) => ({
      name: name.trim(),
      taxId,
      country: country(taxId),
    });
    const body = (kind: string) => ({
      evidenceId: id,
      kind,
      body: {
        number,
        issueDate,
        currency,
        supplier: party(supplierName, supplierVat),
        customer: party(customerName, customerVat),
        lines: [
          { description: description.trim(), net: netAmount, vatCategory: category, vatRate: rate },
        ],
        taxes: [{ base: netAmount, tax: taxAmount, category, rate }],
        totals: { net: netAmount, tax: taxAmount, gross: amountOf(gross)! },
      },
      citations,
    });
    try {
      await this.call('documents.record', body('invoice.received'));
    } catch (error) {
      if (!(error instanceof Refused) || error.code !== 'COUNTERPARTY') throw error;
      await this.call('documents.record', body('invoice.issued'));
    }
  }

  // Documents and their bookings.

  private async document(id: string): Promise<'wait' | void> {
    const document = await this.call<{
      kind: string;
      date: string;
      partyId: string;
      evidenceId: string;
      body: InvoiceBody;
    }>('documents.get', { id });
    if (!['invoice.received', 'invoice.issued'].includes(document.kind)) return;
    const sale = document.kind === 'invoice.issued';
    const body = document.body;
    const counterparty = sale ? body.customer : body.supplier;
    const text = body.lines.map((line) => line.description).join(' ');
    const words = folded(text);
    const account = sale
      ? '704'
      : (expenseRules.find(([pattern]) => pattern.test(words))?.[1] ?? '628');
    if (counterparty.country !== 'RO') {
      await this.call('proposals.propose', {
        treatment: 'invoices.crossBorder',
        input: { documentId: id, account, supply: 'services_general_rule' },
      });
      return;
    }
    const input: Record<string, unknown> = { documentId: id, account };
    const answers: string[] = [];
    const vehicle = sale ? null : plate.exec(text);
    if (vehicle) {
      const asked = await this.call<{
        id: string;
        status: string;
        answer: { value: { use: string } } | null;
      }>('questions.ask', {
        kind: 'vehicle.use',
        subject: { kind: 'vehicle', id: `${vehicle[1]}-${vehicle[2]}-${vehicle[3]}` },
        params: { documentId: id, date: document.date },
      });
      // A person answers between turns; the document comes back then.
      if (!asked.answer) return 'wait';
      // The vehicle named, its deduction is the answer's (art. 298).
      input.vehicle = `${vehicle[1]}-${vehicle[2]}-${vehicle[3]}`;
      input.deduction = asked.answer.value.use === 'mixed' ? 'limited' : 'full';
      answers.push(asked.id);
    }
    let proposal = await this.call<Proposal>('proposals.propose', {
      treatment: 'invoices.recognize',
      input,
      ...(answers.length ? { basis: { answers } } : {}),
    });
    if (proposal.issues.some((issue) => issue.code === 'DEDUCTION'))
      proposal = await this.call<Proposal>('proposals.revise', {
        proposalId: proposal.id,
        version: proposal.version,
        input: { ...input, deduction: 'none' },
      });
    // Only the deferral of an expense the engine will book: one whose recognition it refused
    // (an unsupported VAT category, say) is left to a person whole.
    if (!sale && yearly.test(words) && !refused(proposal))
      await this.call('proposals.propose', {
        treatment: 'deferrals.defer',
        input: {
          date: document.date,
          account,
          amount: body.totals.net,
          partyId: document.partyId,
          documentId: id,
          evidenceId: document.evidenceId,
        },
      });
  }

  /** Revises a proposal citing the answers, with what the answers settle in its input. */
  private async reviseWithAnswers(step: { inputHint: Record<string, unknown> }) {
    const hint = step.inputHint as {
      proposalId: string;
      version: number;
      input: Record<string, unknown>;
      basis: { answers: string[] };
    };
    const questions = await this.all<{
      id: string;
      kind: string;
      answer: { value: Record<string, unknown> } | null;
    }>('questions.list', { limit: 200 });
    const input = { ...hint.input };
    for (const id of hint.basis.answers) {
      const value = questions.find((question) => question.id === id)?.answer?.value;
      const kind = questions.find((question) => question.id === id)?.kind;
      if (!value) continue;
      if (kind === 'deferral.schedule')
        Object.assign(input, { from: value.from, months: value.months });
      if (kind === 'vehicle.use') input.deduction = value.use === 'mixed' ? 'limited' : 'full';
      if (
        kind === 'profile.fact' &&
        value.value === 'non_vat' &&
        typeof input.documentId === 'string'
      ) {
        const document = await this.call<{ kind: string }>('documents.get', {
          id: input.documentId,
        });
        if (document.kind === 'invoice.received' && 'account' in input) input.deduction = 'none';
      }
    }
    await this.call('proposals.revise', { ...hint, input });
  }

  // Bank.

  /** Explains a movement; one matching nothing yet is tried again once more is posted. */
  private async movement(id: string): Promise<'wait' | void> {
    const movements = await this.all<{ id: string; amount: string; reference: string }>(
      'bank.movements',
      {
        state: 'unexplained',
      },
    );
    const movement = movements.find((item) => item.id === id);
    if (!movement) return;
    const amount = movement.amount.replace(/^-/, '');
    const reference = folded(movement.reference);
    if (/comision|commission|fee|taxa/.test(reference)) {
      await this.call('proposals.propose', {
        treatment: 'bank.settle',
        input: { movementId: id, lines: [{ account: '627', amount }] },
      });
      return;
    }
    if (/aport/.test(reference) && !movement.amount.startsWith('-')) {
      const people = (await this.all<{ id: string; kind: string }>('parties.list')).filter(
        (party) => party.kind === 'ro_individual',
      );
      if (people.length !== 1) return;
      await this.call('proposals.propose', {
        treatment: 'bank.settle',
        input: { movementId: id, opens: [{ account: '4551', partyId: people[0]!.id, amount }] },
      });
      return;
    }
    const items = await this.all<{ id: string; balance: string; document: string | null }>(
      'openItems.list',
    );
    const payment = movement.amount.startsWith('-');
    const candidates = items.filter(
      (item) =>
        item.balance.replace(/^-/, '') === amount && item.balance.startsWith('-') === payment,
    );
    const named = candidates.filter(
      (item) => item.document && reference.includes(folded(item.document)),
    );
    const chosen = named.length === 1 ? named[0] : candidates.length === 1 ? candidates[0] : null;
    if (!chosen) return 'wait';
    await this.call('proposals.propose', {
      treatment: 'bank.settle',
      input: { movementId: id, allocations: [{ openItem: chosen.id, amount }] },
    });
  }
}

export const scripted: AgentFactory = {
  name: 'scripted',
  async prepare() {
    return { agent: new ScriptedAgent() };
  },
};
