import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../xfactura-api/source/engine/db/database';
import { user } from '../../../xfactura-api/source/engine/db/schema';
import { LocalObjectStore } from '../../../xfactura-api/source/engine/adapters/object-store';
import { Engine } from '../../../xfactura-api/source/engine/engine';
import { createApp } from '../../../xfactura-api/source/engine/http/app';
import { wireError } from '../../../xfactura-api/source/engine/kernel/errors';
import type { Actor } from '../../../xfactura-api/source/engine/kernel/commands';
import type { ProposalView } from '../../../xfactura-api/source/engine/kernel/views';
import { Session, type OperationInfo } from '../agents/session';
import { bnrXml } from '../worlds/helpers';
import { plateKey, type World, type WorldDocument } from '../world/schema';
import { locate, render } from '../world/sources';

export const publicUrl = 'http://localhost:3000';
const secret = 'synthetic-eval-secret-at-least-32-characters';

/** What an agent may use: intake, bank, books, review and reference lookups. Approvals,
 * decisions, configuration and submissions are people's: no grant can name them. */
export const agentScopes = [
  'toolset:inbox',
  'toolset:bank',
  'toolset:books',
  'toolset:review',
  'toolset:reference',
];

export type DocumentView = {
  id: string;
  kind: string;
  number: string | null;
  date: string;
  partyId: string | null;
  currency: string;
  totals: { net: string; tax: string; gross: string } | null;
  evidenceId: string;
  authority: string;
  groupId: string | null;
  supersededBy: string | null;
};
export type Movement = {
  id: string;
  treasuryAccountId: string;
  bookingDate: string;
  amount: string;
  reference: string;
  state: string;
};
export type QuestionView = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  params: Record<string, unknown>;
  status: 'open' | 'answered' | 'withdrawn';
  agentId: string | null;
  answer: { value: unknown } | null;
};

/** A gold decision the engine refused: the world or the engine changed. */
export class GoldError extends Error {}

/** A failure of an engine call, with its wire code. */
export class CallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
  }
}

/**
 * One company's books on a fresh engine and database, set up as a world says, with its owner and
 * reviewer. People act through `engine.invoke` as the web does; the agent only through MCP.
 */
export class Books {
  /** Each file's evidence, by document key, and back. */
  readonly evidence = new Map<string, string>();
  readonly fileOf = new Map<string, string>();
  readonly treasury = new Map<string, string>();
  holder: string | null = null;
  private readonly partyKeys = new Map<string, string>();
  private readonly documentFiles = new Map<string, string | null>();
  readonly app: ReturnType<typeof createApp>['app'];

  private constructor(
    readonly world: World,
    readonly engine: Engine,
    readonly db: Database,
    private readonly directory: string,
    readonly owner: Actor,
    readonly reviewer: Actor,
    readonly yearId: string,
    /** The run's identifiers: the engine's records', its people's and the commands' keys. */
    private readonly ids: () => string,
  ) {
    this.app = createApp(engine, { publicUrl, authSecret: secret }).app;
  }

  /** Books whose engine runs at the world's clock and names everything with `ids` (seeded, so
   * that a run lists its records in the same order every time; `../ids.ts`). */
  static async open(world: World, ids: () => string): Promise<Books> {
    const directory = await mkdtemp(join(tmpdir(), 'xfactura-eval-'));
    const db = new Database(`file:${directory}/books.db`);
    await db.migrate();
    const clock = Date.parse(world.clock);
    const engine = new Engine(db, new LocalObjectStore(join(directory, 'objects')), secret, {
      clock: () => clock,
      ids,
    });
    const people = { owner: ids(), reviewer: ids() };
    const email = (name: string) => `${name}@${world.id}.eval.example`;
    await db.write((tx) =>
      tx.insert(user).values(
        Object.entries(people).map(([name, id]) => ({
          id,
          name,
          email: email(name),
          createdAt: new Date(clock),
          updatedAt: new Date(clock),
        })),
      ),
    );
    const company = await engine.companies.create(people.owner, ids(), {
      name: world.company.name,
      cui: world.company.cui,
      year: Number(world.period.slice(0, 4)),
    });
    const owner: Actor = { actorId: people.owner, companyId: company.id };
    const invitation = await engine.companies.invite(owner, ids(), {
      email: email('reviewer'),
      role: 'reviewer',
    });
    await engine.companies.accept(people.reviewer, invitation.token);
    const reviewer: Actor = { actorId: people.reviewer, companyId: company.id };
    const years = (await engine.invoke(owner, 'years.list', ids(), {})) as {
      items: { id: string; kind: string }[];
    };
    const year = years.items.find((item) => item.kind === 'financial')!;
    const books = new Books(world, engine, db, directory, owner, reviewer, year.id, ids);
    await books.setup();
    return books;
  }

  /** Runs an operation as a person (the owner unless named) and returns its output. */
  async invoke<T>(operation: string, input: unknown, actor: Actor = this.owner): Promise<T> {
    try {
      return (await this.engine.invoke(actor, operation, this.ids(), input)) as T;
    } catch (error) {
      const wire = wireError(error).error;
      throw new CallError(wire.code, wire.message, wire.details);
    }
  }

  /** Every item of a list operation, following its pages. */
  async list<T>(operation: string, input: Record<string, unknown> = {}): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.invoke<{ items: T[]; next: string | null }>(operation, {
        ...input,
        ...(after ? { after } : {}),
      });
      items.push(...result.items);
      if (!result.next) break;
      after = result.next;
    }
    return items;
  }

  private async file(filename: string, mediaType: string, bytes: Uint8Array | string) {
    const { id } = await this.invoke<{ id: string }>('evidence.record', {
      filename,
      mediaType,
      base64: Buffer.from(bytes).toString('base64'),
    });
    return id;
  }

  /** What people did before the agent starts. */
  private async setup() {
    const setup = this.world.setup;
    const certificate = await this.file(
      'certificat-inregistrare.pdf',
      'application/pdf',
      `Certificat de înregistrare ${this.world.company.name} (sintetic)`,
    );
    for (const fact of setup.facts)
      await this.invoke('profile.record', { ...fact, evidenceId: certificate });
    for (const account of setup.accounts)
      await this.invoke('accounts.create', {
        ...account,
        validFrom: `${this.world.period.slice(0, 4)}-01-01`,
      });
    for (const { key, ...account } of setup.treasury) {
      const created = await this.invoke<{ id: string }>('treasury.createAccount', account);
      this.treasury.set(key, created.id);
    }
    if (setup.opening) {
      const evidenceId = await this.file(
        'balanta-deschidere.pdf',
        'application/pdf',
        'Balanța de deschidere (sintetică)',
      );
      await this.book('ledger.general', {
        date: setup.opening.date,
        purpose: 'opening',
        reference: 'SOLD-INITIAL',
        description: 'Solduri inițiale',
        evidenceId,
        lines: setup.opening.lines,
      });
    }
    if (setup.bnr.length)
      await this.invoke('fx.importBnr', {
        evidenceId: await this.file('nbrfxrates.xml', 'application/xml', bnrXml(setup.bnr)),
      });
    if (setup.incomeSource)
      await this.invoke('pfa.sources.record', { ...setup.incomeSource, evidenceId: certificate });
    if (setup.holder)
      this.holder = (
        await this.invoke<{ id: string }>('parties.create', {
          kind: 'ro_individual',
          country: 'RO',
          name: setup.holder.name,
        })
      ).id;
  }

  /** A person drops a world file into the books. */
  async upload(document: WorldDocument) {
    const id = await this.file(document.filename, document.mediaType, render(document.source));
    this.evidence.set(document.key, id);
    this.fileOf.set(id, document.key);
    return id;
  }

  /** Issues the agent's grant and connects it over MCP, as an external client does. */
  async connectAgent(name = 'Agent de evaluare') {
    const grant = await this.invoke<{ token: string; scopes: string[] }>('agents.issue', {
      name,
      scopes: agentScopes,
      // Grants expire on the engine's clock, the world's.
      expiresAt: new Date(Date.parse(this.world.clock) + 7 * 86_400_000).toISOString(),
    });
    const operations = new Map<string, OperationInfo>(
      this.engine.operations
        .all()
        .map((operation) => [
          operation.id,
          { effect: operation.effect, approval: operation.approval, agent: operation.agent },
        ]),
    );
    const human = grant.scopes.filter((scope) => {
      const info = operations.get(scope);
      return !info || !info.agent || info.approval === 'human';
    });
    if (human.length) throw new Error(`The agent's grant names people's operations: ${human}`);
    return Session.connect({
      url: `${publicUrl}/api/accounting/v1/companies/${this.owner.companyId}/mcp`,
      token: grant.token,
      fetch: (request) => Promise.resolve(this.app.fetch(request)),
      granted: new Set(grant.scopes),
      operations,
      afterChange: () => this.project(),
    });
  }

  /** What the engine's worker does between requests: rechecks open proposals against the books
   * changed since (staleness) and moves the other consumers of the audit log forward. */
  async project() {
    for (let batch = 0; batch < 100 && (await this.engine.consumers.runOnce()); batch++);
  }

  // Reading the books, as a person.

  documents() {
    return this.list<DocumentView>('documents.list');
  }
  async documentsOf(key: string) {
    const evidenceId = this.evidence.get(key);
    return (await this.documents()).filter((document) => document.evidenceId === evidenceId);
  }
  /** The world file a document was recorded from, or null. */
  async fileOfDocument(id: string) {
    if (!this.documentFiles.has(id)) {
      const document = await this.invoke<DocumentView>('documents.get', { id }).catch(() => null);
      this.documentFiles.set(id, document ? (this.fileOf.get(document.evidenceId) ?? null) : null);
    }
    return this.documentFiles.get(id)!;
  }
  movements() {
    return this.list<Movement>('bank.movements');
  }
  proposals() {
    return this.list<ProposalView>('proposals.list', { limit: 200 });
  }
  questions() {
    return this.list<QuestionView>('questions.list', { limit: 200 });
  }
  /** A partner as reports compare them: its tax id without RO, or its name. */
  async partyKey(id: string) {
    if (!this.partyKeys.has(id)) {
      const party = await this.invoke<{ taxId: string | null; name: string }>('parties.get', {
        partyId: id,
      });
      this.partyKeys.set(
        id,
        party.taxId ? party.taxId.toUpperCase().replace(/^RO/, '') : `name:${party.name}`,
      );
    }
    return this.partyKeys.get(id)!;
  }
  /** Each proposal's latest input, read from the database by the harness (not by the agent). */
  async proposalInputs() {
    const result = await this.db.client.execute({
      sql: 'select proposal_id, version, input_json from acc_proposal_versions where company_id = ? order by version',
      args: [this.owner.companyId],
    });
    const inputs = new Map<string, Record<string, unknown>>();
    for (const row of result.rows)
      inputs.set(String(row.proposal_id), JSON.parse(String(row.input_json)));
    return inputs;
  }

  /** The world file a proposal is about, and a key that names the same decision in any engine:
   * `doc:<file>`, `deferral:<file>`, `movement:<date>:<amount>`, or `other:<treatment>:<subject>`. */
  async locate(
    proposal: Pick<ProposalView, 'subject' | 'treatment' | 'id'>,
    inputs: Map<string, Record<string, unknown>>,
  ): Promise<{ file: string | null; locator: string }> {
    const [kind, ...rest] = proposal.subject.split(':');
    const id = rest.join(':');
    if (kind === 'document') {
      const file = await this.fileOfDocument(id);
      return { file, locator: `doc:${file ?? id}` };
    }
    if (kind === 'deferral') {
      const file = this.fileOf.get(id.split(':')[0]!) ?? null;
      return { file, locator: `deferral:${file ?? id}` };
    }
    if (kind === 'movement') {
      const movement = (await this.movements()).find((item) => item.id === id);
      const statement = movement ? this.statementOf(movement.treasuryAccountId) : null;
      return {
        file: statement,
        locator: movement
          ? `movement:${movement.bookingDate}:${movement.amount}`
          : proposal.subject,
      };
    }
    const input = inputs.get(proposal.id) ?? {};
    const file =
      (typeof input.documentId === 'string' ? await this.fileOfDocument(input.documentId) : null) ??
      (typeof input.evidenceId === 'string' ? (this.fileOf.get(input.evidenceId) ?? null) : null);
    return { file, locator: `other:${proposal.treatment}:${proposal.subject}` };
  }
  private statementOf(treasuryAccountId: string) {
    const key = [...this.treasury].find(([, id]) => id === treasuryAccountId)?.[0];
    return this.world.documents.find((document) => document.statementOf === key)?.key ?? null;
  }

  // Gold: what people do so that the next step starts from correct books.

  /** Resolves `@` references in a gold input against these books. */
  async resolve(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.resolve(item)));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, item]) => [key, await this.resolve(item)]),
        ),
      );
    if (typeof value !== 'string' || !value.startsWith('@')) return value;
    const [kind, ...rest] = value.slice(1).split(':');
    const argument = rest.join(':');
    switch (kind) {
      case 'doc':
        return (await this.documentOf(argument)).id;
      case 'evidence':
        return this.need(this.evidence.get(argument), value);
      case 'party':
        return this.need((await this.documentOf(argument)).partyId, value);
      case 'openItem':
        return this.openItemOf(argument);
      case 'movement': {
        const [date, amount] = argument.split(':');
        const movement = (await this.movements()).find(
          (item) => item.bookingDate === date && item.amount === amount,
        );
        return this.need(movement?.id, value);
      }
      case 'treasury':
        return this.need(this.treasury.get(argument), value);
      case 'holder':
        return this.need(this.holder, value);
      case 'year':
        return this.yearId;
      default:
        throw new GoldError(`Unknown reference ${value}`);
    }
  }
  private need<T>(found: T | null | undefined, reference: string): T {
    if (found === null || found === undefined) throw new GoldError(`${reference} not found`);
    return found;
  }
  /** The document recorded from a world file: its group's root. */
  async documentOf(key: string) {
    const intake = this.world.documents.find((document) => document.key === key)?.gold.intake;
    const recorded = (await this.documentsOf(key)).filter(
      (document) =>
        !document.supersededBy &&
        (intake?.op !== 'documents.record' || document.kind === intake.kind),
    );
    const root = recorded.find((document) => !document.groupId) ?? recorded[0];
    if (!root) throw new GoldError(`No document recorded from ${key}`);
    return root;
  }
  private async openItemOf(key: string) {
    const document = await this.documentOf(key);
    for (const proposal of await this.proposals())
      if (proposal.status === 'posted')
        for (const item of proposal.effect?.openItems ?? [])
          if (item.documentId === document.id) return item.id;
    throw new GoldError(`No posted open item for ${key}`);
  }

  /** Records the file as the gold says, unless the agent already did; says who did. */
  async intake(document: WorldDocument): Promise<'agent' | 'person' | 'none'> {
    const intake = document.gold.intake;
    const evidenceId = this.evidence.get(document.key)!;
    switch (intake.op) {
      case 'none':
        return 'none';
      case 'invoices.import': {
        if ((await this.documentsOf(document.key)).length) return 'agent';
        await this.invoke('invoices.import', { evidenceId });
        return 'person';
      }
      case 'documents.record': {
        const citations = Object.fromEntries(
          Object.entries(intake.citations).flatMap(([field, text]) => {
            const found = locate(document, text);
            return found ? [[field, found]] : [];
          }),
        );
        const recorded = (await this.documentsOf(document.key)).filter(
          (item) => !item.supersededBy,
        );
        const read = recorded.find((item) => item.kind === intake.kind);
        if (!read) {
          // Nothing read, or read as another kind of document: a person records it, as the
          // file's next part when the agent's reading holds the first.
          await this.invoke('documents.record', {
            evidenceId,
            ...(recorded.length ? { part: recorded.length + 1 } : {}),
            kind: intake.kind,
            body: intake.body,
            citations,
          });
          return 'person';
        }
        // The agent read it: a person corrects what it misread before booking.
        const detail = await this.invoke<{ body: Record<string, unknown> }>('documents.get', {
          id: read.id,
        });
        if (!sameReading(detail.body, intake.body)) {
          await this.invoke('documents.supersede', {
            documentId: read.id,
            body: intake.body,
            citations,
          });
          return 'person';
        }
        return 'agent';
      }
      case 'bank.import':
      case 'bank.importCsv': {
        const before = (await this.movements()).length;
        const result = await this.invoke<{ statements: { added: number }[] }>(
          intake.op,
          intake.op === 'bank.import'
            ? { evidenceId, financialYearId: this.yearId }
            : {
                evidenceId,
                accountId: this.treasury.get(intake.account),
                mapping: intake.mapping,
                ...(intake.period ? { period: intake.period } : {}),
              },
        );
        const added = result.statements.reduce((sum, statement) => sum + statement.added, 0);
        return added === 0 && before > 0 ? 'agent' : 'person';
      }
    }
  }

  /** Asks and answers, as the owner, the questions the gold says the evidence cannot settle, so
   * the facts are in the books whether or not the agent asked. */
  async settleQuestions(document: WorldDocument) {
    for (const expected of document.gold.questions) {
      const [kind, about] = splitQuestion(expected);
      const request =
        kind === 'profile.fact'
          ? { kind, subject: { kind: 'profile', id: about }, params: { axis: about } }
          : kind === 'vehicle.use'
            ? { kind, subject: { kind: 'vehicle', id: about }, params: {} }
            : kind === 'deferral.schedule'
              ? { kind, subject: { kind: 'document', id: (await this.documentOf(about)).id } }
              : null;
      if (!request) throw new GoldError(`No way to ask ${expected}`);
      const asked = await this.invoke<QuestionView>('questions.ask', { params: {}, ...request });
      if (asked.status === 'open') {
        const value = hiddenAnswer(this.world, asked, about);
        if (!value) throw new GoldError(`The hidden facts do not answer ${expected}`);
        await this.invoke('questions.answer', { questionId: asked.id, value });
      }
    }
  }

  /** Proposes as the owner, approves as the reviewer (acknowledging its warnings) and posts. */
  async book(treatment: string, input: unknown): Promise<ProposalView> {
    const proposal = await this.invoke<ProposalView>(`${treatment}.propose`, input);
    if (proposal.status === 'posted') return proposal;
    if (proposal.status === 'blocked' || !proposal.effect)
      throw new GoldError(
        `${treatment} blocked: ${proposal.issues.map((issue) => `${issue.code} ${issue.message}`).join('; ')}`,
      );
    const approved = await this.approve(proposal);
    return this.post(approved);
  }
  approve(proposal: ProposalView) {
    return this.invoke<ProposalView>(
      'proposals.approve',
      {
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
        acknowledge: proposal.issues
          .filter((issue) => issue.severity === 'ack')
          .map((issue) => issue.code),
      },
      this.reviewer,
    );
  }
  post(proposal: ProposalView) {
    return this.invoke<ProposalView>(
      'ledger.post',
      { proposalId: proposal.id, version: proposal.version, effectHash: proposal.effectHash },
      this.reviewer,
    );
  }
  /** The gold decisions of a file, each posted before the next is resolved. */
  async postGold(document: WorldDocument) {
    const posted: { key: string; view: ProposalView }[] = [];
    for (const decision of document.gold.decisions) {
      try {
        const view = await this.book(decision.treatment, await this.resolve(decision.input));
        posted.push({ key: decision.key, view });
      } catch (error) {
        if (error instanceof GoldError || error instanceof CallError)
          throw new GoldError(`${this.world.id} ${decision.key}: ${error.message}`);
        throw error;
      }
    }
    return posted;
  }
  /** A person withdraws an unposted proposal. */
  async withdraw(proposal: ProposalView, reason: string) {
    if (proposal.status === 'posted' || proposal.status === 'withdrawn') return;
    await this.invoke('proposals.withdraw', { proposalId: proposal.id, reason });
  }
  /** A person closes what is left of a file the engine does not book, so that later work does
   * not keep returning to it. */
  async closeFile(document: WorldDocument, reason: string) {
    const ids = new Set([
      this.evidence.get(document.key),
      ...(await this.documentsOf(document.key)).map((item) => item.id),
    ]);
    const items = await this.list<{
      id: string;
      kind: string;
      subject: { id: string };
      fingerprint: string;
    }>('work.list', { kinds: ['document.unproposed', 'evidence.unused'], limit: 200 });
    for (const item of items)
      if (ids.has(item.subject.id))
        await this.invoke('work.dispose', {
          id: item.id,
          fingerprint: item.fingerprint,
          disposition: 'no_booking',
          reason,
        });
  }

  async dispose() {
    await this.db.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** `<kind>:<about>` of an expected question. */
export function splitQuestion(expected: string): [string, string] {
  const at = expected.indexOf(':');
  return [expected.slice(0, at), expected.slice(at + 1)];
}

/** What the owner answers from the hidden facts, or null when they do not say. */
export function hiddenAnswer(
  world: World,
  question: Pick<QuestionView, 'kind' | 'subject'>,
  file: string | null,
): unknown {
  switch (question.kind) {
    case 'profile.fact': {
      const fact = world.hidden.profile[question.subject.id];
      return fact ? { value: fact.value, effectiveFrom: fact.effectiveFrom } : null;
    }
    case 'vehicle.use': {
      const vehicle = world.hidden.vehicles[plateKey(question.subject.id)];
      return vehicle?.use === 'mixed' ? { use: 'mixed', from: vehicle.from } : null;
    }
    case 'deferral.schedule': {
      const document = world.documents.find((item) => item.key === file);
      return document?.hidden['deferral.schedule'] ?? null;
    }
    case 'evidence.missing':
      return { unavailable: true, reason: 'Proprietarul nu are alt document decât cel trimis.' };
    default:
      return null;
  }
}

/** Whether an agent's reading of a document agrees with the gold body on what matters: number,
 * dates, currency, partners and totals. */
export function sameReading(read: Record<string, unknown>, gold: Record<string, unknown>) {
  const at = (value: unknown, path: string) =>
    path
      .split('.')
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[key]
            : undefined,
        value,
      );
  const normal = (value: unknown, path: string) => {
    if (value === undefined || value === null) return null;
    const text = String(value);
    if (path.endsWith('taxId') || path === 'buyerTaxId')
      return text.toUpperCase().replace(/^RO/, '');
    if (path === 'number') return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (path.startsWith('totals.')) return Number(text).toFixed(2);
    return text;
  };
  const fields = [
    'number',
    'issueDate',
    'currency',
    'supplier.taxId',
    'customer.taxId',
    'seller.taxId',
    'buyerTaxId',
    'totals.net',
    'totals.tax',
    'totals.gross',
  ];
  return fields.every(
    (field) =>
      at(gold, field) === undefined ||
      normal(at(read, field), field) === normal(at(gold, field), field),
  );
}
