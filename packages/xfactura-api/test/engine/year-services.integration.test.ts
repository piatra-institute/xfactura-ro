import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
} from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import { FakeTaxpayers } from './fakes/anaf-taxpayers';
import { camtEntry } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

/*
 * Two services SRLs kept for the whole of FY2026, January to December, before the product phase:
 * every regime module working together over a year. An agent (a scoped grant, through
 * `engine.invoke`) imports the files, proposes every booking, settles the statements, requests
 * batches and the closes and prepares every return; people record the facts, answer questions,
 * prepare the payroll, approve the exact versions and decide the reviewed actions. Every party,
 * document and amount is synthetic and written by hand; the expected figures are worked in the
 * comments, never read off the engine; a person pays the state what was declared, and the
 * amounts the books declare are held to those worked by hand. Each return is prepared from the
 * books and run through ANAF's own validators (DUKIntegrator, and the SAF-T kit for D406) when
 * they are installed; a format the engine does not write is asserted as the explicit
 * FORMAT_GAP (S1005 for FY2026).
 */

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const root = path.join(import.meta.dir, '../../../..');
const dist = path.join(root, '.validators/anaf/dist');
const saftDist = path.join(root, '.validators/anaf-saft/duk_SAFT_an_luna/dist');
/** Both kits and Java: the returns are then validated by ANAF, never assumed valid. */
const installed =
  DukIntegrator.available(dist) && DukIntegrator.available(saftDist) && Bun.which('java') !== null;
const kits = () =>
  new AnafKits({
    general: new DukIntegrator(dist),
    saft: new DukIntegrator(saftDist, saftKitId),
  });
if (!installed)
  console.warn(
    "year-services: ANAF's validators are not installed; the returns are checked as prepared only (bun run validators:fetch).",
  );

const day = 86_400_000;
const months = Array.from(
  { length: 12 },
  (_, index) => `2026-${String(index + 1).padStart(2, '0')}`,
);
const monthEnd = (month: string) => {
  const [year, mm] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year!, mm!, 0)).getUTCDate()).padStart(2, '0')}`;
};
const nextMonth = (month: string) => {
  const [year, mm] = month.split('-').map(Number);
  return mm === 12 ? `${year! + 1}-01` : `${year}-${String(mm! + 1).padStart(2, '0')}`;
};
const quarterOf = (month: string) =>
  `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`;
const isQuarterEnd = (month: string) => Number(month.slice(5)) % 3 === 0;
const cents = (amount: string) =>
  BigInt(amount.replace('-', '').replace('.', '')) * (amount.startsWith('-') ? -1n : 1n);
const lei = (bani: bigint) => {
  const sign = bani < 0n ? '-' : '';
  const value = bani < 0n ? -bani : bani;
  return `${sign}${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};

/** A deadline of the 25th moved off the weekend (25 April 2026 is a Saturday: April's taxes are
 * due on Monday 27), and 25 December's to the 21st, a Monday in 2026 (Codul de procedură fiscală
 * art. 155 alin. (2), as the engine's deadline shift cites it). */
const deadline = (date: string) => {
  if (date.endsWith('-12-25')) return `${date.slice(0, 4)}-12-21`;
  let at = Date.parse(date);
  while ([0, 6].includes(new Date(at).getUTCDay())) at += day;
  return new Date(at).toISOString().slice(0, 10);
};

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}
/** A Romanian IBAN with a valid check, for a synthetic bank code and account. */
function ibanOf(bank: string, account: string) {
  const bban = `${bank}${account}`;
  const digits = `${bban}RO00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return `RO${String(check).padStart(2, '0')}${bban}`;
}

/**
 * BNR's reference rates for every weekday from 29.12.2025 to 15.01.2027, synthetic: EUR at
 * 5.0800 at the end of 2025, then 5.08m0 in month m of 2026 (5.0810 in January … 5.0920 in
 * December), 5.0930 in January 2027. One rate a month keeps every conversion by hand.
 */
const eurRate = (date: string) =>
  date < '2026-01-01'
    ? '5.0800'
    : date >= '2027-01-01'
      ? '5.0930'
      : `5.0${800 + 10 * Number(date.slice(5, 7))}`;
const bnr = (() => {
  const cubes: string[] = [];
  for (let at = Date.parse('2025-12-29'); at <= Date.parse('2027-01-15'); at += day) {
    const date = new Date(at).toISOString().slice(0, 10);
    const weekday = new Date(at).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    cubes.push(`<Cube date="${date}"><Rate currency="EUR">${eurRate(date)}</Rate></Cube>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2027-01-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${cubes.join('\n')}
</Body></DataSet>`;
})();

/** A camt.053 statement of one account, in its currency. */
function camtStatement(input: {
  iban: string;
  currency: string;
  id: string;
  from: string;
  to: string;
  opening: string;
  closing: string;
  entries: { date: string; amount: string; ref: string; text: string }[];
}) {
  const balance = (code: string, amount: string, date: string) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${input.currency}">${amount.replace('-', '')}</Amt><CdtDbtInd>${amount.startsWith('-') ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>
<GrpHdr><MsgId>${input.id}</MsgId><CreDtTm>${input.to}T23:30:00+02:00</CreDtTm></GrpHdr>
<Stmt><Id>${input.id}</Id><ElctrncSeqNb>1</ElctrncSeqNb>
<Acct><Id><IBAN>${input.iban}</IBAN></Id><Ccy>${input.currency}</Ccy></Acct>
${balance('OPBD', input.opening, input.from)}
${balance('CLBD', input.closing, input.to)}
${input.entries
  .map((entry) =>
    camtEntry({
      amount: entry.amount.replace('-', ''),
      direction: entry.amount.startsWith('-') ? 'DBIT' : 'CRDT',
      bankRef: entry.ref,
      date: entry.date,
      text: entry.text,
    }).replace(/Ccy="RON"/g, `Ccy="${input.currency}"`),
  )
  .join('')}
</Stmt></BkToCstmrStmt></Document>`;
}

/** A bank's CSV export (UTF-8): debit and credit columns, decimal commas, balances apart. */
function csvStatement(input: {
  iban: string;
  opening: string;
  closing: string;
  entries: { date: string; amount: string; ref: string; text: string }[];
}) {
  const comma = (amount: string) => amount.replace('-', '').replace('.', ',');
  const ro = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
  return [
    `Extras de cont;${input.iban};;;`,
    `Sold initial;;;${comma(input.opening)};`,
    'Data;Descriere;Debit;Credit;Referinta',
    ...input.entries.map(
      (entry) =>
        `${ro(entry.date)};${entry.text};${entry.amount.startsWith('-') ? comma(entry.amount) : ''};${entry.amount.startsWith('-') ? '' : comma(entry.amount)};${entry.ref}`,
    ),
    `Sold final;;;${comma(input.closing)};`,
    '',
  ].join('\r\n');
}
const csvMapping = {
  separator: ';',
  encoding: 'utf-8',
  dateFormat: 'DD.MM.YYYY',
  decimal: ',',
  headerRows: 3,
  footerRows: 1,
  columns: {
    date: 'Data',
    description: ['Descriere'],
    debit: 'Debit',
    credit: 'Credit',
    reference: 'Referinta',
  },
  balances: { from: 'cells', opening: { row: 2, column: 4 }, closing: { row: -1, column: 4 } },
};

type Artifact = {
  id: string;
  kind: string;
  period: string;
  state: string;
  xmlHash: string;
  steps: { state: string; actor: string | null; detail: string | null }[];
};
type Row = {
  account: string;
  opening: { debit: string; credit: string };
  current: { debit: string; credit: string };
  closing: { debit: string; credit: string };
};
type TrialBalance = { rows: Row[]; totals: Record<string, { debit: string; credit: string }> };
type Movement = {
  id: string;
  amount: string;
  currency: string;
  bookingDate: string;
  reference: string;
  description?: string;
  counterparty: string | null;
};
type OpenItem = {
  id: string;
  kind: string;
  partyId: string;
  account: string;
  document: string | null;
  balance: string;
  currency: string;
  dueDate: string | null;
};
/** A statement's movement as the test writes it, and how the agent explains it. */
type Entry = { date: string; amount: string; ref: string; text: string };
type Settle = (movement: Movement) => Promise<unknown>;
type WorkItem = {
  id: string;
  kind: string;
  severity: string;
  subject: { kind: string; id: string };
  message: string;
};
type Close = { findings: { code: string; severity: string; message: string }[] };

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`) ?? [];
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const acks = (proposal: ProposalView) =>
  proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code);
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail ?? 'null');

/** The return reached ANAF's validator and passed it; without the kits, it is prepared only. */
function validated(artifact: Artifact) {
  expect(
    [artifact.kind, artifact.period, artifact.state, artifact.steps.at(-1)?.detail ?? null],
    `${artifact.kind} ${artifact.period}`,
  ).toEqual([artifact.kind, artifact.period, installed ? 'validated_official' : 'prepared', null]);
}

/**
 * One company's year: the engine on a clock the test moves, the people of `scenario`, and the
 * agent's grant renewed before it expires. The agent proposes and requests; the reviewer
 * approves exact versions (alone where a warning needs acknowledging, otherwise in batches).
 */
class Books {
  readonly clock = { now: Date.parse('2026-01-02T09:00:00Z') };
  s!: Scenario;
  agent!: Actor;
  private grantUntil = 0;
  private pending: ProposalView[] = [];
  readonly returns: Artifact[] = [];
  readonly closes: { month: string; findings: Close['findings']; blocking: WorkItem[] }[] = [];
  readonly approvals = { single: 0, batched: 0, batches: 0 };
  readonly taxpayers = new FakeTaxpayers();

  async start(cui: string, name: string) {
    this.s = await scenario({
      cui,
      name,
      clock: () => this.clock.now,
      taxpayers: this.taxpayers,
      ...(installed ? { declarationValidator: kits() } : {}),
    });
    open.push(this.s);
    await this.renew();
    return this;
  }

  /** The engine's day; the owner renews the agent's grant (at most 90 days) when it runs out. */
  async at(date: string) {
    this.clock.now = Date.parse(`${date}T09:00:00Z`);
    if (this.clock.now > this.grantUntil - 5 * day) await this.renew();
  }

  private async renew() {
    const grant = await this.s.invoke<{ token: string }>(this.s.owner, 'agents.issue', {
      name: 'Agent contabil',
      scopes: [
        'toolset:inbox',
        'toolset:bank',
        'toolset:books',
        'toolset:review',
        'toolset:close',
        'toolset:tax',
        'toolset:payroll',
        'toolset:reference',
      ],
      expiresAt: new Date(this.clock.now + 85 * day).toISOString(),
    });
    this.grantUntil = this.clock.now + 85 * day;
    this.agent = await this.s.engine.agents.authenticate(grant.token, this.s.company.id);
  }

  invoke<T = unknown>(operation: string, input: unknown = {}) {
    return this.s.invoke<T>(this.agent, operation, input);
  }
  list<T = unknown>(operation: string, input: unknown = {}) {
    return this.s.list<T>(this.agent, operation, input);
  }

  /** The owner drops a file in. */
  async file(filename: string, content: string, mediaType = 'application/xml') {
    return (
      await this.s.invoke<{ id: string }>(this.s.owner, 'evidence.record', {
        filename,
        mediaType,
        base64: Buffer.from(content).toString('base64'),
      })
    ).id;
  }
  /** A scanned paper the owner keeps: contracts, decisions, statements of account. */
  async paper(filename: string) {
    return this.file(filename, `${filename} ${this.clock.now}`, 'application/pdf');
  }
  /** A dated company fact with its document, recorded by the owner. */
  async fact(axis: string, value: string, effectiveFrom = '2026-01-01') {
    await this.s.invoke(this.s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: await this.paper(`${axis}-${value}.pdf`),
    });
  }

  /** An e-Factura XML the owner downloads from the SPV, imported by the agent. */
  async efactura(number: string, xml: string) {
    return this.invoke<{ id: string; partyId: string; evidenceId: string }>('invoices.import', {
      evidenceId: await this.file(`${number}.xml`, xml),
    });
  }

  /** The agent proposes; a block fails the test, a warning goes to the reviewer alone. */
  async propose(treatment: string, input: unknown, basis?: { answers: string[] }) {
    return this.invoke<ProposalView>('proposals.propose', {
      treatment,
      input,
      ...(basis ? { basis } : {}),
    });
  }
  async book(treatment: string, input: unknown, basis?: { answers: string[] }) {
    return this.settle(await this.propose(treatment, input, basis));
  }
  /** Proposed, approved and posted at once: for a treatment that reads what the next one will
   * change (a payment to the state reads every obligation of the authority). */
  async bookAlone(treatment: string, input: unknown) {
    const proposal = await this.propose(treatment, input);
    return this.settle(proposal, [], true);
  }
  /** Approves what the agent proposed: alone if it has warnings to acknowledge (the reviewer
   * names each), else queued for the next batch. */
  async settle(proposal: ProposalView, expected: string[] = [], alone = false) {
    expect(
      proposal.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code),
      `${proposal.treatment} ${proposal.subject}`,
    ).toEqual([]);
    const warnings = acks(proposal);
    if (expected.length) expect(warnings).toEqual(expected);
    if (!warnings.length && proposal.status === 'proposed' && !alone) {
      this.pending.push(proposal);
      return proposal;
    }
    const approved = await this.s.approve(proposal, this.s.reviewer, warnings);
    this.approvals.single += 1;
    return this.invoke<ProposalView>('ledger.post', {
      proposalId: approved.id,
      version: approved.version,
      effectHash: approved.effectHash,
    });
  }
  /** The batch of what waits: requested by the agent, decided by the reviewer on its preview,
   * executed by the agent. */
  async flush() {
    if (!this.pending.length) return [];
    const members = this.pending.splice(0);
    const request = await this.invoke<ActionView>('proposals.batch.request', {
      members: members.map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    expect((request.preview as { findings: unknown[] }).findings).toEqual([]);
    await this.s.invoke(this.s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await this.invoke<ActionView>('actions.execute', { id: request.id }).catch(
      (error) => {
        const conflict = (error as { details?: { proposalId?: string } }).details?.proposalId;
        const member = members.find((item) => item.id === conflict);
        throw new Error(
          `${(error as Error).message} ${member?.treatment} ${member?.subject} in [${members.map((item) => item.treatment).join(', ')}]`,
        );
      },
    );
    expect(executed.status).toBe('executed');
    this.approvals.batched += members.length;
    this.approvals.batches += 1;
    return members;
  }

  /** Asks what only a person knows, as the issue names it, and has the owner answer. */
  async answer(
    question: { kind: string; subject: { kind: string; id: string }; params: unknown },
    value: unknown,
  ) {
    const asked = await this.invoke<{ id: string; status: string }>('questions.ask', question);
    if (asked.status !== 'answered')
      await this.s.invoke(this.s.reviewer, 'questions.answer', { questionId: asked.id, value });
    return asked.id;
  }
  questionOf(proposal: ProposalView, code: string) {
    const issue = proposal.issues.find((item) => item.code === code);
    expect(issue, `${code} on ${proposal.treatment}`).toBeDefined();
    return (
      issue!.details as {
        question: { kind: string; subject: { kind: string; id: string }; params: unknown };
      }
    ).question;
  }

  async movements(treasuryAccountId: string) {
    return this.list<Movement>('bank.movements', { treasuryAccountId, state: 'unexplained' });
  }
  async openItems() {
    return this.list<OpenItem>('openItems.list', { openOnly: true });
  }

  trialBalance(from?: string, to?: string) {
    return this.invoke<TrialBalance>('ledger.trialBalance', {
      financialYearId: this.s.year.id,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  /** Prepares a return as the agent, from the books; ANAF's validator runs at once. */
  async prepare(kind: string, period: string, options: Record<string, unknown>) {
    const artifact = await this.invoke<Artifact>('declarations.prepare', { kind, period, options });
    this.returns.push(artifact);
    return artifact;
  }

  /** Every proposal of the company, page by page. */
  async proposals() {
    const all: ProposalView[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.s.invoke<{ items: ProposalView[]; next: string | null }>(
        this.s.owner,
        'proposals.list',
        { limit: 200, ...(after ? { after } : {}) },
      );
      all.push(...result.items);
      if (!result.next) break;
      after = result.next;
    }
    return all;
  }

  /** The year was kept by the agent: it proposed every booking and posted it, each on a
   * person's approval of its exact version (alone or in a reviewed batch), none withdrawn but
   * the late entry refused by the lock. */
  async keptByTheAgent() {
    const all = await this.proposals();
    expect(
      all.filter((proposal) => proposal.agentId === null).map((proposal) => proposal.subject),
    ).toEqual([]);
    const posted = all.filter((proposal) => proposal.status === 'posted');
    expect(
      posted.filter((proposal) => !proposal.approval || proposal.entry?.agentId === null),
    ).toEqual([]);
    expect(posted.filter((proposal) => proposal.approval?.batchId).length).toBe(
      this.approvals.batched,
    );
    expect(this.closes).toHaveLength(12);
    return { proposals: all.length, posted: posted.length, ...this.approvals };
  }

  /** The worklist's blocking items, read by the agent. */
  async blocking() {
    return (await this.list<WorkItem>('work.list', { severity: 'block', limit: 200 })).filter(
      (item) => item.severity === 'block',
    );
  }

  /**
   * The agent requests the close, the reviewer decides it, the agent executes it. Before it, the
   * worklist holds no blocking item but those `explained` names (each a reported gap), and the
   * close's snapshot of closing balances is the trial balance's, account by account.
   */
  async close(month: string, explained: (item: WorkItem) => string | null = () => null) {
    await this.flush();
    const blocking = await this.blocking();
    expect(
      blocking
        .filter((item) => !explained(item))
        .map((item) => `${item.kind} ${item.subject.id}: ${item.message}`),
      `the worklist's blocking items at the close of ${month}`,
    ).toEqual([]);
    const request = await this.invoke<ActionView>('periods.close.request', { month });
    const preview = request.preview as Close & {
      balances: { account: string; currency: string; closing: string }[];
    };
    const findings = preview.findings;
    this.closes.push({ month, findings, blocking });
    expect(
      findings.filter((finding) => finding.severity === 'block'),
      `close ${month}`,
    ).toEqual([]);
    const snapshot = new Map<string, bigint>();
    for (const row of preview.balances)
      snapshot.set(row.account, (snapshot.get(row.account) ?? 0n) + cents(row.closing));
    const books = new Map<string, bigint>();
    for (const row of (await this.trialBalance(`${month.slice(0, 4)}-01-01`, monthEnd(month))).rows)
      books.set(
        row.account,
        (books.get(row.account) ?? 0n) + cents(row.closing.debit) - cents(row.closing.credit),
      );
    const nonzero = (map: Map<string, bigint>) =>
      Object.fromEntries(
        [...map].filter(([, bani]) => bani !== 0n).map(([key, bani]) => [key, lei(bani)]),
      );
    expect(nonzero(snapshot), `the closing balances of ${month}`).toEqual(nonzero(books));
    await this.s.invoke(this.s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await this.invoke<ActionView>('actions.execute', { id: request.id });
    expect(executed.status).toBe('executed');
    return { request, blocking };
  }
}

type Question = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  params: Record<string, unknown>;
  status: string;
};

/** The micro-enterprise conditions only the owner knows (art. 47), with the trade register's
 * certificate and the shareholders' register. */
const microConditions = (evidence: string) => ({
  stateOwned: false,
  dissolution: false,
  excludedActivity: false,
  shareholders: 'no_holder_over_25',
  statementsOnTime: 'yes',
  mandate: true,
  established: null,
  lateStatementsFrom: null,
  linked: [],
  evidenceIds: [evidence],
});

/**
 * The year's determinations: the agent opens the questions (`determinations.propose`), a person
 * answers each from what the company knows, until nothing is asked; returns what is recorded.
 */
async function determine(b: Books, year: number, answer: (question: Question) => unknown) {
  for (let round = 0; round < 6; round++) {
    const proposed = await b.invoke<{
      asked: { kind: string; subject: { id: string }; questionId: string; reused: boolean }[];
    }>('determinations.propose', { year });
    const open = await b.list<Question>('questions.list', { status: 'open', limit: 200 });
    const pending = proposed.asked.filter((item) =>
      open.some((question) => question.id === item.questionId),
    );
    if (!pending.length) break;
    for (const item of pending) {
      const question = open.find((candidate) => candidate.id === item.questionId)!;
      const value = answer(question);
      expect(value, `${question.kind} ${question.subject.id}`).toBeDefined();
      await b.s.invoke(b.s.owner, 'questions.answer', { questionId: question.id, value });
    }
  }
  const evaluated = await b.invoke<{
    determinations: {
      axis: string;
      status: string;
      value: string | null;
      recorded: { agrees: boolean | null; confirmed: boolean };
    }[];
  }>('determinations.evaluate', { year });
  return Object.fromEntries(
    evaluated.determinations.map((item) => [
      item.axis,
      item.recorded.agrees === true || (item.recorded.confirmed && item.recorded.agrees !== false)
        ? item.value
        : `${item.status}:${item.value}`,
    ]),
  );
}

/** The trial balance of a range balances, in every total it gives. */
async function balanced(b: Books, from: string, to: string) {
  const balance = await b.trialBalance(from, to);
  expect(Object.keys(balance.totals).length).toBeGreaterThan(0);
  for (const [name, total] of Object.entries(balance.totals))
    expect(total.debit, `${from}–${to} ${name}`).toBe(total.credit);
  return balance;
}
const turnoverOf = (balance: TrialBalance, account: string, side: 'debit' | 'credit') =>
  balance.rows
    .filter((row) => row.account === account)
    .reduce((sum, row) => sum + cents(row.current[side]), 0n);
/** Half up to the leu, as D300 rounds its rows. */
const leu = (bani: bigint) => Number((bani + 50n) / 100n);

type Journal = {
  rows: unknown[];
  totals: { code: string; base: string; vat: string; deductible: string }[];
};
/**
 * D300 = the VAT journals = 4426/4427's movement, for a VAT period: each rate's base and VAT on
 * its rows (rd. 9 and 10 collected, 22 and 23 deducted, 26 exempt purchases), the deduction on
 * rd. 28, the journals' VAT equal to 4427's credit and 4426's debit, and the settlement leaving
 * both at nil.
 */
async function vatCrossCheck(b: Books, period: string, from: string, to: string) {
  const balance = await b.trialBalance(from, to);
  const output = await b.invoke<Journal>('vat.journal', {
    direction: 'output',
    from: period,
    to: period,
  });
  const input = await b.invoke<Journal>('vat.journal', {
    direction: 'input',
    from: period,
    to: period,
  });
  const d300 = b.returns.find((item) => item.kind === 'D300' && item.period === period);
  expect(d300, `D300 ${period}`).toBeDefined();
  const rows = summary(d300!).rows as Record<string, number>;
  const total = (journal: Journal, code: string, field: 'base' | 'vat') =>
    cents(journal.totals.find((row) => row.code === code)?.[field] ?? '0.00');
  const sum = (journal: Journal, field: 'vat' | 'deductible') =>
    journal.totals.reduce((all, row) => all + cents(row[field]), 0n);
  for (const [journal, code, row] of [
    [output, 'S-21', 'R9'],
    [output, 'S-11', 'R10'],
    [input, 'S-21', 'R22'],
    [input, 'S-11', 'R23'],
  ] as const)
    expect([rows[`${row}_1`] ?? 0, rows[`${row}_2`] ?? 0], `${period} ${row}`).toEqual([
      leu(total(journal, code, 'base')),
      leu(total(journal, code, 'vat')),
    ]);
  expect(rows.R26_1 ?? 0, `${period} R26`).toBe(leu(total(input, 'EX-IN', 'base')));
  expect(rows.R28_2 ?? 0, `${period} R28`).toBe(leu(sum(input, 'deductible')));
  expect(sum(output, 'vat'), `${period} 4427`).toBe(turnoverOf(balance, '4427', 'credit'));
  expect(sum(input, 'deductible'), `${period} 4426`).toBe(turnoverOf(balance, '4426', 'debit'));
  expect(turnoverOf(balance, '4427', 'debit')).toBe(turnoverOf(balance, '4427', 'credit'));
  expect(turnoverOf(balance, '4426', 'credit')).toBe(turnoverOf(balance, '4426', 'debit'));
  return { collected: sum(output, 'vat'), deducted: sum(input, 'deductible') };
}

/** D112 = the payroll's postings of the month: each obligation's amount owed (CAS 412, CASS 432,
 * the salary tax 602, CAM 480) equal to 4315's, 4316's, 444's and 436's credit, and the gross
 * pay to 421's credit and the vouchers handed over (6422). */
async function payrollCrossCheck(b: Books, month: string) {
  const artifact = b.returns.find((item) => item.kind === 'D112' && item.period === month);
  expect(artifact, `D112 ${month}`).toBeDefined();
  const xml = (await b.s.objects.get(b.s.company.id, artifact!.xmlHash)).toString();
  const owed = Object.fromEntries(
    [...xml.matchAll(/<angajatorA A_codOblig="(\d+)"[^>]*? A_datorat="(\d+)"/g)].map((match) => [
      match[1],
      lei(BigInt(match[2]!) * 100n),
    ]),
  );
  const balance = await b.trialBalance(`${month}-01`, monthEnd(month));
  expect(owed, `D112 ${month}`).toEqual({
    '412': lei(turnoverOf(balance, '4315', 'credit')),
    '432': lei(turnoverOf(balance, '4316', 'credit')),
    '602': lei(turnoverOf(balance, '444', 'credit')),
    '480': lei(turnoverOf(balance, '436', 'credit')),
  });
  expect(lei(BigInt(xml.match(/B_brutSalarii="(\d+)"/)![1]!) * 100n), `D112 ${month} gross`).toBe(
    lei(turnoverOf(balance, '421', 'credit') + turnoverOf(balance, '6422', 'debit')),
  );
  return owed;
}

// =============================================================================================
// Profile 1: a micro-enterprise services SRL, normal VAT, monthly VAT period.
// =============================================================================================

const P1 = {
  cui: '18547290',
  name: 'Servicii Micro SRL',
  /** Customers: monthly development work in lei, and one job invoiced in euro. */
  client: '14399840',
  euroClient: '26000004',
  /** Suppliers. */
  cloud: '22334451',
  leasing: '33445560',
  books: '44556670',
  insurer: '55667789',
  hardware: '26000039',
  fuel: '29031773',
  bank: '12345674',
  plate: 'B-123-XFA',
};
const p1Bank = ibanOf('BREL', '0000000000100001');
const p1Euro = ibanOf('BREL', '0000000000100002');
/** The company's own invoicer numbers its sales MS-0001, MS-0002, …: one a month in lei, and
 * the euro job of March after March's (MS-0004). */
const saleNumber = (m: number) => `MS-${String(m <= 3 ? m : m + 1).padStart(4, '0')}`;
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const contact = { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' };
const d300Options = (account: string) => ({
  declarant,
  caen: '6201',
  bank: 'Banca Exemplu',
  account,
});
const d394Options = {
  caen: '6201',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați, Str. Lungă 10' },
  preparer: {
    kind: 'company',
    cui: '14399840',
    name: 'Contabil Exemplu SRL',
    capacity: 'Împuternicit',
  },
  consultation: true,
  affiliates: false,
};
const d112Options = { declarant, caen: '6201', phone: '0236000000' };
/** The microentity's statements, as a person states what the books do not hold. */
const s1005Options = (caen: string) => ({
  entity: {
    tradeRegister: 'J17/123/2010',
    ownership: 35,
    caen,
    caenActual: caen,
    caenVersion: 2025,
    largeTaxpayer: false,
    branch: false,
    economicInterestGroup: false,
    netAssetsBelowHalfCapital: false,
    phone: '0236000000',
  },
  administrator: 'Popescu Ana',
  preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '14399840' },
  approved: true,
  rows: {},
});

describe('profile 1: a micro-enterprise services SRL, monthly VAT, through FY2026', () => {
  const b = new Books();
  let anaf: string;
  let ron: string;
  let euro: string;
  const contracts: Record<string, string> = {};
  const partyOf: Record<string, string> = {};
  let lender: string;
  let shareholder: string;
  let vehicle: string;

  beforeAll(async () => {
    await b.start(P1.cui, P1.name);
    for (const cui of Object.values(P1).filter((value) => /^\d{8}$/.test(value)))
      b.taxpayers.taxpayer(cui);
  });

  test('January: the company, its facts, its people and the opening balance', async () => {
    const { s } = b;
    await b.at('2026-01-02');
    // The facts the year's determinations and treatments read, each with its document.
    for (const [axis, value, from] of [
      ['entity.form', 'srl', '2020-01-01'],
      ['activity.goods', 'no', '2020-01-01'],
      ['regime.excluded', 'none', '2020-01-01'],
      ['vat.status', 'normal_vat', '2020-01-01'],
      ['vat.cash', 'no', '2020-01-01'],
      ['vat.period', 'monthly', '2026-01-01'],
      ['income_tax', 'micro', '2020-01-01'],
      ['employer', 'yes', '2020-01-01'],
      ['tax.facilities', 'none', '2026-01-01'],
    ] as const)
      await b.fact(axis, value, from);
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: P1.name,
        vatId: `RO${P1.cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    await b.invoke('fx.importBnr', { evidenceId: await b.file('nbrfxrates2026.xml', bnr) });
    ron = (
      await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name: 'Cont curent lei',
        iban: p1Bank,
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: '2026-01-01',
      })
    ).id;
    euro = (
      await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name: 'Cont curent euro',
        iban: p1Euro,
        currency: 'EUR',
        ledgerAccount: '5124',
        openedOn: '2026-01-01',
      })
    ).id;
    anaf = (
      await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_public_institution',
        country: 'RO',
        name: 'ANAF',
      })
    ).id;
    shareholder = (
      await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_individual',
        country: 'RO',
        name: 'Popescu Ana',
      })
    ).id;
    await s.invoke(s.owner, 'parties.recordCnp', {
      partyId: shareholder,
      cnp: cnp('285072217002'),
    });

    // The two employees, full time at their main job, above the personal deduction's band.
    for (const [last, first, code, salary] of [
      ['Ionescu', 'Dan', cnp('190010117002'), '8000'],
      ['Marin', 'Elena', cnp('291030417002'), '7000'],
    ] as const) {
      const employee = await s.invoke<{ id: string; partyId: string }>(
        s.owner,
        'payroll.employees.record',
        {
          lastName: last,
          firstName: first,
          cnp: code,
          healthFund: 'RO-GL',
        },
      );
      contracts[last] = (
        await s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
          employeeId: employee.id,
          number: `CIM-${last}`,
          startDate: '2024-03-01',
          effectiveFrom: '2024-03-01',
          dailyHours: 8,
          mainJob: true,
          occupation: '251201',
          baseSalary: salary,
        })
      ).contractId;
      partyOf[contracts[last]!] = employee.partyId;
      // Its start was sent to REGES-ONLINE before the first day, with the receipt kept.
      await s.invoke(s.owner, 'payroll.reges.record', {
        contractId: contracts[last],
        termsSeq: 1,
        event: 'start',
        transmittedOn: '2024-02-28',
        evidenceId: await b.paper(`recipisa-reges-${last}.pdf`),
      });
    }
    lender = (
      await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_legal_entity',
        country: 'RO',
        name: 'Banca Exemplu SA',
        taxId: P1.bank,
      })
    ).id;

    // The opening balance of 1 January, from 2025's closing balance: 80,000.00 lei in the bank
    // against the capital (1,000.00), the legal reserve already at 20% of it (200.00) and the
    // profit retained (78,800.00).
    const opening = await b.book('ledger.general', {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'DESCHIDERE-2026',
      description: 'Soldurile de deschidere din balanța la 31.12.2025',
      evidenceId: await b.paper('balanta-2025.pdf'),
      lines: [
        { account: '5121', side: 'D', amount: '80000.00' },
        { account: '1012', side: 'C', amount: '1000.00' },
        { account: '1061', side: 'C', amount: '200.00' },
        { account: '1171', side: 'C', amount: '78800.00' },
      ],
    });
    expect(lines(opening)).toEqual([
      'D 5121 80000.00',
      'C 1012 1000.00',
      'C 1061 200.00',
      'C 1171 78800.00',
    ]);
    await b.flush();
    const balance = await b.trialBalance();
    expect(balance.rows.find((row) => row.account === '1171')?.closing.credit).toBe('78800.00');
  });

  test("January: the year's determinations from 2025's figures and the owner's answers, confirmed by a person", async () => {
    const figures = await b.paper('situatii-financiare-2025.pdf');
    const answers = (question: Question): unknown => {
      switch (question.kind) {
        case 'year.figures': {
          // 2025, filed: 420,000.00 lei of turnover, under 100,000 € × 5.0800 = 508,000.00 lei
          // (micro, art. 47), with goods bought from another Member State (monthly VAT, art. 322
          // alin. (1)) and an average of three employees (D112 monthly, art. 80 alin. (2)).
          const all: Record<string, string> = {
            turnover: '420000.00',
            netTurnover: '420000.00',
            totalRevenue: '421000.00',
            vatTurnover: '420000.00',
            exemptionTurnover: '420000.00',
            totalAssets: '150000.00',
            averageEmployees: '3',
            euGoodsAcquisitions: 'yes',
            distanceTurnover: '0.00',
            intrastatArrivals: '0.00',
            intrastatDispatches: '0.00',
          };
          const asked = (question.params as { figures: string[] }).figures;
          return {
            values: Object.fromEntries(asked.map((name) => [name, all[name]])),
            evidenceIds: [figures],
          };
        }
        case 'micro.conditions':
          return microConditions(figures);
        case 'profile.fact':
          if (question.subject.id.startsWith('size.category/'))
            return { value: 'micro', effectiveFrom: `${question.subject.id.slice(-4)}-01-01` };
          return undefined;
        case 'determination.confirm':
          return { confirm: true };
        default:
          return undefined;
      }
    };
    const confirmed = await determine(b, 2026, answers);
    expect(confirmed).toMatchObject({
      income_tax: 'micro',
      'vat.period': 'monthly',
      'payroll.period': 'monthly',
      'size.category': 'micro',
    });
  });

  for (const month of months)
    test(`${month}: documents, payroll, the bank, the month's end, the returns and the close`, async () => {
      await p1Month(month);
    }, 60_000);

  test("December: the year-end in full, December's returns and close, the year's close and lock", async () => {
    const { s } = b;
    const end = '2026-12-31';
    const review = () =>
      b.invoke<{ closed: boolean; items: { id: string; check: string; severity: string }[] }>(
        'yearend.review',
        { financialYearId: s.year.id },
      );
    // What the year's end waits on: the inventory, the provisions, the result.
    expect(new Set((await review()).items.map((item) => item.check))).toEqual(
      new Set(['inventory.lists', 'provisions', 'result']),
    );

    // The inventory of 31 December, transcribed from the signed lists: the server found, the
    // bank balances as the statements show them (RON as booked; 2,420.00 €).
    const printed = [
      'Liste de inventariere la 31.12.2026',
      'Decizia de inventariere nr. 12 din 01.12.2026',
      'MF-1 Server rack 2U - gasit',
      `5121 RON sold extras ${ronClosing}`,
      '5124 EUR sold extras 2420.00',
    ];
    const cite = (line: number, text: string) => ({ page: 1, line, text });
    const list = await b.invoke<{ id: string; checks: { code: string; status: string }[] }>(
      'documents.record',
      {
        evidenceId: await b.file('liste-inventariere-2026.txt', printed.join('\n'), 'text/plain'),
        kind: 'inventory.list',
        citations: {
          date: cite(1, '31.12.2026'),
          'commission.decision': cite(2, 'nr. 12'),
          'assets.0.number': cite(3, 'MF-1'),
          'bank.0.balance': cite(4, ronClosing),
          'bank.1.balance': cite(5, '2420.00'),
        },
        body: {
          title: 'Liste de inventariere la 31.12.2026',
          company: { name: P1.name, taxId: P1.cui },
          date: end,
          commission: {
            decision: '12',
            decisionDate: '2026-12-01',
            members: ['Popescu Ana', 'Ionescu Dan'],
          },
          assets: [{ number: 'MF-1', name: 'Server rack 2U', found: true }],
          bank: [
            { account: '5121', currency: 'RON', balance: ronClosing },
            { account: '5124', currency: 'EUR', balance: '2420.00' },
          ],
        },
      },
    );
    expect(list.checks.filter((check) => check.status !== 'passed')).toEqual([]);
    const compared = await b.invoke<{ differences: unknown[]; gaps: unknown[] }>(
      'inventory.compare',
      {
        date: end,
      },
    );
    expect(compared).toMatchObject({ differences: [], gaps: [] });

    // Provisions: the leave not taken, measured on the payroll (Marin, 4 days: 1,333.33 lei and
    // CAM 2.25%, 30.00), a debt to the staff (641 = 4281); no other obligation at the year's end.
    const leave = await b.answer(
      {
        kind: 'leave.untaken',
        subject: { kind: 'company', id: 'company' },
        params: { year: 2026 },
      },
      {
        days: 4,
        amount: '1333.33',
        contributions: '30.00',
        measured: true,
        evidenceId: await b.paper('calcul-concedii-neefectuate-2026.pdf'),
      },
    );
    const debt = await b.book(
      'provisions.record',
      {
        date: end,
        kind: 'leave',
        reference: 'concedii-2026',
        amount: '1363.33',
        evidenceId: await b.paper('decizie-provizioane-2026.pdf'),
      },
      { answers: [leave] },
    );
    expect(lines(debt)).toEqual(['D 641 1363.33', 'C 4281 1363.33']);
    await b.answer(
      {
        kind: 'provisions.review',
        subject: { kind: 'company', id: 'company' },
        params: { year: 2026 },
      },
      { none: true, evidenceIds: [await b.paper('analiza-obligatii-2026.pdf')] },
    );
    await b.flush();
    // The result alone is left; the closing journal closes it into 121.
    expect(
      (await review()).items.filter((item) => item.severity === 'block').map((item) => item.id),
    ).toEqual(['result|close']);
    const closing = await b.book('year.closeResult', {
      yearEnd: end,
      evidenceId: await b.paper('nota-inchidere-2026.pdf'),
    });
    await b.flush();
    // The year's result, by hand. Revenue 250,387.78: 704 12 × 20,000.00 + 10,166.00 = 250,166.00,
    // 7588 200.00 (the gift), 7651 2.42 + 8 × 2.42 = 21.78. Expenses 230,975.39: 641 11 ×
    // 15,000.00 + October's 14,137.00 + 200.00 + the leave's 1,363.33 = 180,700.33; 646 10 × 338
    // + 342 + 318 = 4,040.00; 612 12 × 1,657.50 = 19,890.00; 6422 7,200.00; 628 6,000.00; 666
    // 580.00 + 576.45 + 550.22 + 526.39 + 500.81 + 475.30 + 451.31 + 425.35 + 401.27 = 4,487.10
    // (the periods of April–November in full, 4,100.00, and 30 of December's 31 days of 400.00,
    // 387.10); 6811 10 × 250.00 = 2,500.00; 698 704 + 3 × 600 = 2,504.00; 613 2,400.00; 6458
    // 500.00; 6028 300.00; 6022 273.96; 627 12 × 15.00 = 180.00. Profit: 19,412.39.
    expect(closing.effect!.lines.find((line) => line.account === '121')).toMatchObject({
      side: 'C',
      amount: '19412.39',
    });
    expect((await review()).items.filter((item) => item.severity === 'block')).toEqual([]);

    // December's returns, its checks and its close; then the year.
    await p1Returns('2026-12');
    await p1Checks('2026-12');
    await b.close('2026-12');
    const request = await b.invoke<ActionView>('years.close.request', {
      financialYearId: s.year.id,
    });
    const preview = request.preview as {
      findings: { code: string; severity: string }[];
      snapshot: { hash: string; accounts: number; items: number; assets: number };
      closing: { accounts: { account: string; currency: string; bani: string }[] };
    };
    expect(preview.findings.filter((item) => item.severity === 'block')).toEqual([]);
    expect(preview.snapshot.assets).toBe(1);
    // The snapshot is the trial balance's closing, account by account.
    const balance = await b.trialBalance();
    const books = new Map<string, bigint>();
    for (const row of balance.rows)
      books.set(
        row.account,
        (books.get(row.account) ?? 0n) + cents(row.closing.debit) - cents(row.closing.credit),
      );
    const snapshot = new Map<string, bigint>();
    for (const row of preview.closing.accounts)
      snapshot.set(row.account, (snapshot.get(row.account) ?? 0n) + BigInt(row.bani));
    expect(
      Object.fromEntries(
        [...snapshot].filter(([, bani]) => bani !== 0n).map(([a, v]) => [a, lei(v)]),
      ),
    ).toEqual(
      Object.fromEntries([...books].filter(([, bani]) => bani !== 0n).map(([a, v]) => [a, lei(v)])),
    );
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await b.invoke<ActionView>('actions.execute', { id: request.id });
    expect(executed.result).toMatchObject({ yearEnd: end, snapshotHash: preview.snapshot.hash });
    expect((await review()).closed).toBe(true);
    // The lock: nothing posts into 2026 any more.
    const late = await b.propose('ledger.general', {
      date: '2026-12-31',
      purpose: 'general',
      reference: 'TARZIU',
      description: 'O înregistrare după închiderea exercițiului',
      evidenceId: await b.paper('nota-tarzie.pdf'),
      lines: [
        { account: '627', side: 'D', amount: '1.00' },
        { account: '5121', side: 'C', amount: '1.00' },
      ],
    });
    expect(codes(late).length).toBeGreaterThan(0);
    await b.invoke('proposals.withdraw', { proposalId: late.id, reason: 'Exercițiul este închis' });
  }, 120_000);

  test('2027: the opening equals the closing; the annual returns; the obligation closure', async () => {
    const { s } = b;
    await b.at('2027-01-08');
    // The 2027 opening is 2026's closing snapshot, per account, open item and asset.
    const next = await s.invoke<{ id: string }>(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    expect(
      await b.invoke<{ matches: boolean; differences: unknown[]; closed: boolean }>(
        'years.opening',
        {
          financialYearId: next.id,
        },
      ),
    ).toMatchObject({ closed: true, matches: true, differences: [] });

    // The year's totals, by hand (above): interest, micro tax, exchange gains.
    const year = await b.trialBalance();
    const moved = (account: string) =>
      lei(turnoverOf(year, account, 'debit') - turnoverOf(year, account, 'credit'));
    expect(moved('666')).toBe('0.00');
    expect(lei(turnoverOf(year, '666', 'debit'))).toBe('4487.10');
    expect(accruedInterest.reduce((sum, amount) => sum + cents(amount), 0n)).toBe(448_710n);
    expect(lei(turnoverOf(year, '698', 'debit'))).toBe('2504.00');
    expect(lei(turnoverOf(year, '7651', 'credit'))).toBe('21.78');
    // What 2027 inherits: December's taxes and salaries, the loan, the leave owed, the euro.
    const closing = (account: string) => {
      const row = year.rows.filter((item) => item.account === account);
      return lei(
        row.reduce((sum, item) => sum + cents(item.closing.credit) - cents(item.closing.debit), 0n),
      );
    };
    expect(closing('1621')).toBe('40000.00');
    expect(closing('4281')).toBe('1363.33');
    expect(closing('121')).toBe('19412.39');
    expect(closing('1171')).toBe('58800.00');
    expect(closing('5124')).toBe('-12322.64');

    // The annual returns: D205 for the dividend paid, the D406 assets file; S1005 for FY2026 waits
    // on ANAF's package.
    const d205 = await b.prepare('D205', '2026', { declarant, paidAs: 'gross' });
    validated(d205);
    expect(summary(d205)).toEqual({ year: '2026', individuals: 1, companies: 0 });
    validated(await b.prepare('D406', '2026', { contact }));
    expect(
      (
        await s.refused(
          b.invoke('declarations.prepare', {
            kind: 'S1005',
            period: '2026',
            options: s1005Options('6201'),
          }),
        )
      )?.code,
    ).toBe('FORMAT_GAP');

    // The obligation closure of 2026: every return the year owes, from the facts, the yearly
    // determinations and the books, and nothing outside what the engine covers.
    const closure = await b.invoke<{
      status: string;
      obligations: { kind: string; period: string; state: string }[];
      needs: unknown[];
      unsupported: unknown[];
    }>('closure.evaluate', { from: '2026-01', to: '2026-12' });
    expect({
      status: closure.status,
      needs: closure.needs,
      unsupported: closure.unsupported,
    }).toEqual({
      status: 'ELIGIBLE',
      needs: [],
      unsupported: [],
    });
    const owed = closure.obligations.filter((item) => item.state === 'applies');
    const count = (kind: string) => owed.filter((item) => item.kind === kind).length;
    expect({
      D300: count('D300'),
      D394: count('D394'),
      D112: count('D112'),
      D406: count('D406'),
      D100: count('D100'),
      D205: count('D205'),
      D390: count('D390'),
      S1005: count('S1005'),
    }).toEqual({ D300: 12, D394: 12, D112: 12, D406: 13, D100: 5, D205: 1, D390: 0, S1005: 1 });
    // Each return the closure lists for 2026 was prepared, but S1005 (FORMAT_GAP).
    const prepared = new Set(b.returns.map((item) => `${item.kind}|${item.period}`));
    expect(
      owed.map((item) => `${item.kind}|${item.period}`).filter((key) => !prepared.has(key)),
    ).toEqual(['S1005|2026']);
    for (const artifact of b.returns) validated(artifact);
    // 12 D300, 12 D394, 12 D112, 12 D406, 4 D100, D205 and the assets file: 54, each validated.
    expect(b.returns).toHaveLength(54);
    await b.keptByTheAgent();
    expect(statementsRead.map((item) => item.format)).toEqual(
      months.map((month) => (Number(month.slice(5)) % 2 ? 'camt.053' : 'csv')),
    );
  }, 120_000);

  /** One month of profile 1, done early the next month. */
  async function p1Month(month: string) {
    const m = Number(month.slice(5));
    const mm = month.slice(5);
    const end = monthEnd(month);
    await b.at(`${nextMonth(month)}-05`);

    // Purchases and sales from the SPV.
    const hosting = await b.efactura(
      `H-${mm}`,
      invoiceXml({
        company: P1.cui,
        number: `H-${mm}`,
        date: `${month}-05`,
        counterparty: `RO${P1.cloud}`,
        net: '500.00',
        tax: '105.00',
        gross: '605.00',
        lines: [{ rate: '21', net: '500.00', name: `Găzduire și copii de siguranță ${month}` }],
      }),
    );
    await b.book('invoices.recognize', { documentId: hosting.id, account: '628' });
    // The car's operating lease: half its VAT deductible for a car used privately too (art. 298).
    const lease = await b.efactura(
      `L-${mm}`,
      invoiceXml({
        company: P1.cui,
        number: `L-${mm}`,
        date: `${month}-05`,
        counterparty: `RO${P1.leasing}`,
        net: '1500.00',
        tax: '315.00',
        gross: '1815.00',
        lines: [
          {
            rate: '21',
            net: '1500.00',
            name: `Rată leasing operațional autoturism ${P1.plate}, ${month}`,
          },
        ],
      }),
    );
    const leaseInput = {
      documentId: lease.id,
      account: '612',
      vehicle: P1.plate,
      deduction: 'limited',
    };
    if (!vehicle) {
      const asked = await b.propose('invoices.recognize', leaseInput);
      expect(asked.status).toBe('blocked');
      vehicle = await b.answer(b.questionOf(asked, 'VEHICLE_USE'), {
        use: 'mixed',
        from: '2026-01-01',
      });
      const revised = await b.invoke<ProposalView>('proposals.revise', {
        proposalId: asked.id,
        version: asked.version,
        input: leaseInput,
        basis: { answers: [vehicle] },
      });
      // 315.00 × 50% = 157.50 deducted, 157.50 into the expense.
      expect(lines(revised)).toEqual(['D 612 1657.50', 'D 4426 157.50', 'C 401 1815.00']);
      await b.settle(revised);
    } else await b.book('invoices.recognize', leaseInput, { answers: [vehicle] });
    const sale = await b.efactura(
      saleNumber(m),
      invoiceXml({
        company: P1.cui,
        direction: 'sale',
        number: saleNumber(m),
        date: `${month}-10`,
        counterparty: `RO${P1.client}`,
        net: '20000.00',
        tax: '4200.00',
        gross: '24200.00',
        lines: [{ rate: '21', net: '20000.00', name: `Dezvoltare software ${month}` }],
      }),
    );
    await b.book('invoices.recognize', { documentId: sale.id, account: '704' });
    await p1Extras(month);
    await b.flush();
    await recordDetails();

    // Payroll: a person computes the month; the agent proposes its booking.
    await p1Payroll(month);
    await b.flush();

    // The bank, from the statements.
    await p1Statements(month);
    await b.flush();

    // The month's end: vouchers handed over, the insurance released, depreciation, interest,
    // the euro account at the closing rate.
    await b.book('ledger.general', {
      date: end,
      purpose: 'general',
      reference: `TICHETE-${mm}`,
      description: `Tichete de masă acordate ${month}`,
      evidenceId: await b.paper(`stat-tichete-${month}.pdf`),
      lines: [
        { account: '6422', side: 'D', amount: '600.00' },
        { account: '5328', side: 'C', amount: '600.00' },
      ],
    });
    await b.book('deferrals.release', { month });
    if (m >= 3) {
      const depreciation = await b.book('assets.depreciate', { month });
      // 9,000.00 over 36 months from March.
      expect(lines(depreciation)).toEqual(['D 6811 250.00', 'C 2814 250.00']);
    }
    if (m >= 4) {
      const accrued = await b.book('loans.accrue', { month });
      // Interest accrues by the days elapsed in each period: in April, 29 of the first period's
      // 30 days (1 April to 30 April), 600.00 × 29 / 30 = 580.00; in May the rest of April's
      // period (20.00) and 30 of May's 31 days at 575.00 (556.45): 576.45.
      expect(lines(accrued)).toEqual([`D 666 ${accrual(month)}`, `C 1682 ${accrual(month)}`]);
      if (m === 4) expect(accrual(month)).toBe('580.00');
      if (m === 5) expect(accrual(month)).toBe('576.45');
      accruedInterest.push(accrued.effect!.lines.find((line) => line.account === '666')!.amount);
    }
    if (m >= 5) {
      // The euro account at the month's closing rate: 2,420.00 € × 0.0010 = 2.42 lei a month.
      const revalued = await b.book('fx.revalue', { date: end });
      expect(lines(revalued)).toEqual(['D 5124 2.42', 'C 7651 2.42']);
    }
    await b.flush();
    // The VAT of the month into 4423.
    await b.book('vat.settle', {
      period: month,
      date: end,
      authorityId: anaf,
      evidenceId: await b.paper(`decont-${month}.pdf`),
    });
    if (isQuarterEnd(month)) await p1Micro(month);
    await b.flush();

    // December's returns and close wait for the year-end entries.
    if (month === '2026-12') return;
    await p1Returns(month);
    await p1Checks(month);
    // Nothing blocks the close that the books can't clear: the month just begun is checked once
    // it ends; 2027's returns wait for the rules of 2027 without blocking; FY2026's statements'
    // answers are information while ANAF has no format for them.
    await b.close(month);
  }

  /** The quarters' micro tax, by hand (p1Micro). */
  const micro = {
    '2026-Q1': '704.00',
    '2026-Q2': '600.00',
    '2026-Q3': '600.00',
    '2026-Q4': '600.00',
  };
  /**
   * What the company pays the state each month for the month before, by hand. Payroll: Ionescu
   * 8,000 lei (CAS 2,000, CASS 800, tax 10% × 5,200 = 520, net 4,680, CAM 180) and Marin 7,000
   * lei with 600 lei of meal vouchers (CAS 1,750, CASS 10% × 7,600 = 760, tax 10% × 5,090 = 509,
   * net 3,981), CAM 2.25% × 15,000 = 337.50 → 338: 6,339 to the single account. March: Marin's
   * gift adds 200 lei in every base (CAS 1,800, CASS 780, tax 522, net 3,898; CAM 342): 6,422.
   * October: Marin ill 5–9 October (17 of 22 days worked: 7,000 × 17 / 22 → 5,409; the
   * employer's 4 days at 55% of 42,000 / 127 days (April–September) = 330.70 → 4 × 330.70 ×
   * 55% = 727.54 → 728): 6,137 lei, CAS 1,534, CASS 674, tax 10% × 4,529 = 453, net 3,476, CAM
   * 2.25% × 14,137 = 318: 5,981. VAT: 4,200 collected less 105 + 157.50 deducted; February
   * deducts the bookshop's 53 and the server's 1,890 too, March collects the euro job's 2,134.86
   * too, May deducts the fuel's 26.04 too. The quarter's micro tax and June's 3,200 of dividend
   * tax join the single account on the 25th after.
   */
  const payments: Record<string, { single: string; cam: string; vat: string }> = {
    '2026-02': { single: '6339.00', cam: '338.00', vat: '3937.50' },
    '2026-03': { single: '6339.00', cam: '338.00', vat: '1994.50' },
    '2026-04': { single: '7126.00', cam: '342.00', vat: '6072.36' },
    '2026-05': { single: '6339.00', cam: '338.00', vat: '3937.50' },
    '2026-06': { single: '6339.00', cam: '338.00', vat: '3911.46' },
    '2026-07': { single: '10139.00', cam: '338.00', vat: '3937.50' },
    '2026-08': { single: '6339.00', cam: '338.00', vat: '3937.50' },
    '2026-09': { single: '6339.00', cam: '338.00', vat: '3937.50' },
    '2026-10': { single: '6939.00', cam: '338.00', vat: '3937.50' },
    '2026-11': { single: '5981.00', cam: '318.00', vat: '3937.50' },
    '2026-12': { single: '6339.00', cam: '338.00', vat: '3937.50' },
  };
  /** The loan's interest booked at a month's end: what accrued by its last day, the periods
   * ended in full plus the running one's days elapsed (the month's days less one), less what
   * was booked before. */
  const accrual = (month: string) => {
    const cumulative = (m: number) => {
      if (m < 4) return 0n;
      let total = 0n;
      for (let k = 4; k < m; k++) total += BigInt(60_000 - 2_500 * Math.max(0, k - 4));
      const days = BigInt(new Date(Date.UTC(2026, m, 0)).getUTCDate());
      const running = BigInt(60_000 - 2_500 * Math.max(0, m - 4));
      // running × (days − 1) / days, in bani, half up.
      return total + (2n * running * (days - 1n) + days) / (2n * days);
    };
    const m = Number(month.slice(5));
    return lei(cumulative(m) - cumulative(m - 1));
  };
  const accruedInterest: string[] = [];
  /** Interest of the loan's period that starts on the first of `month`: 1% of what is still
   * owed, 60,000.00 less 2,500.00 for each instalment paid since May. */
  function interest(month: string) {
    const paid = Math.max(0, Number(month.slice(5)) - 4);
    return lei(BigInt(60_000 - 2_500 * paid));
  }

  /** The partners' invoicing details, as D406 reports them, for each new partner. */
  const detailed = new Set<string>();
  async function recordDetails() {
    const parties = await b.list<{ id: string; name: string; taxId: string | null; kind: string }>(
      'parties.list',
    );
    for (const party of parties) {
      if (party.kind !== 'ro_legal_entity' || !party.taxId || detailed.has(party.id)) continue;
      detailed.add(party.id);
      await b.invoke('parties.recordDetails', {
        partyId: party.id,
        details: {
          name: party.name,
          vatId: `RO${party.taxId.replace(/^RO/, '')}`,
          address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
        },
      });
    }
  }

  const payrollPosted = new Map<string, ProposalView>();
  const runs = new Map<string, { lines: { contractId: string; net: string; cash: string }[] }>();
  async function p1Payroll(month: string) {
    const { s } = b;
    const m = Number(month.slice(5));
    const vouchers = { kind: 'meal_vouchers', amount: '600', label: 'Tichete de masă' };
    const entries: Record<string, unknown>[] = [
      {
        contractId: contracts.Marin,
        ...(m === 10
          ? {
              // Ill 5–9 October: the first day unpaid, four days paid by the employer at 55%;
              // 17 of October's 22 working days worked, 7,000 × 17 / 22 = 5,409.09 → 5,409 lei.
              items: [{ kind: 'salary', amount: '5409', label: 'Salariu zile lucrate' }, vouchers],
              sickLeave: [
                {
                  series: 'CCMAM',
                  number: '1001',
                  code: '01',
                  issued: '2026-10-05',
                  from: '2026-10-05',
                  to: '2026-10-09',
                  place: 'family_doctor',
                  diagnosis: '101',
                },
              ],
            }
          : { items: [{ kind: 'salary', amount: '7000', label: 'Salariu de bază' }, vouchers] }),
        ...(m === 3
          ? {
              // A gift of 500.00 lei for 8 March: 300 lei a person and occasion are exempt (art.
              // 76 alin. (4) lit. a)), 200.00 lei is income in kind in every base (E3_44).
              benefits: [
                {
                  kind: 'gift',
                  label: 'Cadou 8 martie',
                  occasion: 'march_8',
                  persons: [{ recipient: 'employee', value: '500.00' }],
                  evidenceId: await b.paper('decizie-cadouri-8-martie.pdf'),
                },
              ],
            }
          : {}),
      },
    ];
    const run = await s.invoke<{
      id: string;
      round: number;
      issues: number;
      lines: { contractId: string; net: string; cash: string; issues: { code: string }[] }[];
    }>(s.owner, 'payroll.runs.prepare', { month, entries });
    expect(run.lines.flatMap((line) => line.issues.map((issue) => issue.code))).toEqual([]);
    // The net pay, by hand (payments): Ionescu 4,680; Marin 3,981, 3,898 in March, 3,476 in
    // October.
    expect(Object.fromEntries(run.lines.map((line) => [line.contractId, line.net])), month).toEqual(
      {
        [contracts.Ionescu!]: '4680.00',
        [contracts.Marin!]: m === 3 ? '3898.00' : m === 10 ? '3476.00' : '3981.00',
      },
    );
    runs.set(month, run);
    const posted = await b.book('payroll.recognize', {
      runId: run.id,
      month,
      round: run.round,
      authorityId: anaf,
    });
    payrollPosted.set(month, posted);
    return posted;
  }

  /** The open item of a document, by its number. */
  async function itemOf(document: string) {
    // The invoice's receivable or payable: a deferral of the same invoice (471) is no money owed.
    const item = (await b.openItems()).find(
      (candidate) =>
        candidate.document === document && ['receivable', 'payable'].includes(candidate.kind),
    );
    expect(item, `the open item of ${document}`).toBeDefined();
    return item!;
  }

  let distribution: ProposalView | undefined;
  /** The documents of a month beyond the recurring ones. */
  async function p1Extras(month: string) {
    if (month === '2026-01') {
      // The car's insurance for 2026, exempt (art. 292 alin. (2) lit. b), VATEX-EU-135-1), on 613
      // and spread over its twelve months: 2,400.00 / 12 = 200.00 a month.
      const policy = await b.efactura(
        'POL-2026',
        invoiceXml({
          company: P1.cui,
          number: 'POL-2026',
          date: '2026-01-05',
          counterparty: `RO${P1.insurer}`,
          category: 'E',
          rate: '0',
          tax: '0.00',
          net: '2400.00',
          gross: '2400.00',
          lines: [{ rate: '0', net: '2400.00', name: `Asigurare CASCO ${P1.plate} 2026` }],
        }).replace(
          /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>E<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
          '$1<cbc:TaxExemptionReasonCode>VATEX-EU-135-1</cbc:TaxExemptionReasonCode>',
        ),
      );
      const insured = await b.book('invoices.recognize', { documentId: policy.id, account: '613' });
      expect(lines(insured)).toEqual(['D 613 2400.00', 'C 401 2400.00']);
      await b.flush();
      await b.book('deferrals.defer', {
        date: '2026-01-05',
        account: '613',
        amount: '2400.00',
        from: '2026-01',
        months: 12,
        partyId: policy.partyId,
        documentId: policy.id,
        evidenceId: policy.evidenceId,
      });
    }
    if (month === '2026-02') {
      // Books at 11% and stationery at 21% on one invoice: 100.00 + 11.00 and 200.00 + 42.00.
      const bookshop = await b.efactura(
        'LIB-77',
        invoiceXml({
          company: P1.cui,
          number: 'LIB-77',
          date: '2026-02-12',
          counterparty: `RO${P1.books}`,
          net: '300.00',
          tax: '53.00',
          gross: '353.00',
          taxes: [
            { rate: '21', net: '200.00', tax: '42.00' },
            { rate: '11', net: '100.00', tax: '11.00' },
          ],
        }),
      );
      const booked = await b.settle(
        await b.propose('invoices.recognize', {
          documentId: bookshop.id,
          allocations: [
            { account: '6028', vat: 'S-21', amount: '200.00' },
            { account: '6028', vat: 'S-11', amount: '100.00' },
          ],
        }),
        ['REDUCED_RATE'],
      );
      expect(lines(booked)).toEqual([
        'D 6028 200.00',
        'D 6028 100.00',
        'D 4426 42.00',
        'D 4426 11.00',
        'C 401 353.00',
      ]);
      // A server, a fixed asset on 404: 9,000.00 + 1,890.00, in use from 15 February.
      const server = await b.efactura(
        'SRV-1',
        invoiceXml({
          company: P1.cui,
          number: 'SRV-1',
          date: '2026-02-12',
          counterparty: `RO${P1.hardware}`,
          net: '9000.00',
          tax: '1890.00',
          gross: '10890.00',
          lines: [{ rate: '21', net: '9000.00', name: 'Server rack 2U' }],
        }),
      );
      const bought = await b.book('invoices.recognize', { documentId: server.id, account: '214' });
      expect(lines(bought)).toEqual(['D 214 9000.00', 'D 4426 1890.00', 'C 404 10890.00']);
      await b.invoke('assets.register', {
        number: 'MF-1',
        name: 'Server rack 2U',
        catalogCode: '2.2.9',
        account: '214',
        depreciationAccount: '2814',
        value: '9000.00',
        lifeMonths: 36,
        fiscalLifeMonths: 36,
        commissionedOn: '2026-02-15',
        evidenceId: await b.paper('pv-punere-in-functiune-MF-1.pdf'),
        documentId: server.id,
      });
    }
    if (month === '2026-03') {
      // A job invoiced in euro: 2,000.00 € + 420.00 € VAT at March's 5.0830, the VAT in lei
      // stated on the invoice (BT-111): 420.00 × 5.0830 = 2,134.86; the revenue 10,166.00.
      const euroSale = await b.efactura(
        'MS-0004',
        invoiceXml({
          company: P1.cui,
          direction: 'sale',
          currency: 'EUR',
          number: 'MS-0004',
          date: '2026-03-16',
          counterparty: `RO${P1.euroClient}`,
          net: '2000.00',
          tax: '420.00',
          gross: '2420.00',
          lines: [{ rate: '21', net: '2000.00', name: 'Integrare API, martie 2026' }],
        })
          .replace(
            '</cbc:DocumentCurrencyCode>',
            '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
          )
          .replace(
            '<cac:LegalMonetaryTotal>',
            '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">2134.86</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>',
          ),
      );
      const booked = await b.book('invoices.recognize', {
        documentId: euroSale.id,
        account: '704',
      });
      expect(lines(booked)).toEqual(['D 4111 12300.86', 'C 704 10166.00', 'C 4427 2134.86']);
    }
    if (month === '2026-05') {
      // Fuel for the car, a receipt photographed with the company's code: 300.00 lei with
      // 52.07 VAT (300 × 21 / 121), half deducted, 26.04 (26.035 half up); paid by card.
      const receipt = await b.invoke<{ id: string }>('documents.record', {
        evidenceId: await b.file('bon-0815.png', 'photo of receipt 0815', 'image/png'),
        kind: 'receipt.received',
        body: {
          seller: { name: 'Benzinăria Exemplu SRL', taxId: `RO${P1.fuel}`, country: 'RO' },
          buyerTaxId: `RO${P1.cui}`,
          number: '0815',
          register: '4400012345',
          issueDate: '2026-05-18',
          currency: 'RON',
          lines: [{ description: 'Motorină standard', gross: '300.00', vatRate: '21' }],
          taxes: [{ rate: '21', gross: '300.00', tax: '52.07' }],
          totals: { gross: '300.00', tax: '52.07' },
          payment: 'card',
        },
      });
      const fuel = await b.settle(
        await b.propose(
          'receipts.recognize',
          {
            documentId: receipt.id,
            account: '6022',
            vehicle: P1.plate,
            deduction: 'limited',
            payment: { method: 'card' },
          },
          { answers: [vehicle] },
        ),
        ['SOURCE_EXTRACTED'],
      );
      expect(lines(fuel)).toEqual(['D 6022 273.96', 'D 4426 26.04', 'C 401 300.00']);
      // The general meeting distributes 20,000.00 lei of 2025's profit to the sole associate.
      distribution = await b.book('dividends.distribute', {
        date: '2026-05-20',
        evidenceId: await b.paper('hotarare-aga-dividende.pdf'),
        shareholders: [{ partyId: shareholder, amount: '20000.00' }],
      });
      expect(lines(distribution)).toEqual(['D 1171 20000.00', 'C 457 20000.00']);
    }
    if (month === '2026-06') {
      // Paid on 10 June: 16% withheld (art. 97 alin. (7)), 3,200.00; 16,800.00 paid.
      const [item] = distribution!.effect!.openItems;
      const withheld = await b.book('dividends.withhold', {
        distributionEntryId: (
          await b.invoke<ProposalView>('proposals.get', { id: distribution!.id })
        ).entry!.id,
        openItem: item!.id,
        date: '2026-06-10',
        gross: '20000.00',
        authorityId: anaf,
      });
      expect(lines(withheld)).toEqual(['D 457 3200.00', 'C 446 3200.00']);
    }
  }

  /** What the authority is owed, by account, for items due on `due`. */
  async function owed(due: string, accounts: string[]) {
    // What falls due in the month, on the day worked out by hand. The items of VAT, the micro
    // tax and the dividend tax carry no due date: their returns' deadlines are the tax
    // account's, the 25th after the month or the quarter they were booked in, just ended.
    const items = (await b.openItems()).filter(
      (item) =>
        item.partyId === anaf &&
        accounts.includes(item.account) &&
        (item.dueDate?.slice(0, 7) === due.slice(0, 7) ||
          (['4423', '4418', '446'].includes(item.account) && item.dueDate === null)),
    );
    for (const item of items)
      if (item.dueDate !== null) expect(item.dueDate, `${item.account} due`).toBe(due);
    return items.reduce((sum, item) => sum - cents(item.balance), 0n);
  }
  let ronClosing = '80000.00';
  const statementsRead: { month: string; account: string; format: string; added: number }[] = [];

  async function p1Statements(month: string) {
    const m = Number(month.slice(5));
    const mm = month.slice(5);
    const previous = m > 1 ? `2026-${String(m - 1).padStart(2, '0')}` : null;
    const entries: (Entry & { settle: Settle })[] = [];
    const allocate =
      (openItem: () => Promise<OpenItem>, amount: string) => async (movement: Movement) =>
        b.book('bank.settle', {
          movementId: movement.id,
          allocations: [{ openItem: (await openItem()).id, amount }],
        });
    // The bank prints the payment's reference in its details, where the agent reads it.
    const add = (date: string, amount: string, ref: string, text: string, settle: Settle) =>
      entries.push({ date, amount, ref, text: `${text} ${ref}`, settle });

    if (m === 4)
      // A bank loan of 60,000.00 lei at 12%, 24 equal principal parts from 1 May.
      add('2026-04-01', '60000.00', 'CREDIT-60', 'Tragere credit investitii', async (movement) =>
        b.book('loans.receive', {
          movementId: movement.id,
          account: '1621',
          partyId: lender,
          evidenceId: await b.paper('contract-credit.pdf'),
          terms: { method: 'linear', rate: '12', months: 24, firstDue: '2026-05-01' },
        }),
      );
    if (m >= 5) {
      const due = interest(previous!);
      add(
        `${month}-01`,
        `-${lei(250_000n + cents(due))}`,
        `RATA-${mm}`,
        'Rata credit',
        async (movement) => {
          const items = (await b.openItems()).filter((item) => item.partyId === lender);
          const loan = items.find((item) => item.account === '1621')!;
          const accrued = items.find((item) => item.account === '1682')!;
          return b.book('bank.settle', {
            movementId: movement.id,
            allocations: [
              { openItem: loan.id, amount: '2500.00' },
              { openItem: accrued.id, amount: due },
            ],
          });
        },
      );
    }
    add(`${month}-03`, '-600.00', `TICHETE-${mm}`, 'Plata tichete de masa', (movement) =>
      b.book('bank.settle', {
        movementId: movement.id,
        lines: [{ account: '5328', amount: '600.00' }],
      }),
    );
    if (previous) {
      // Last month's salaries, net of what was withheld, each on its employee's item.
      const run = runs.get(previous)!;
      const posted = payrollPosted.get(previous)!;
      for (const [index, line] of run.lines.entries()) {
        const item = posted.effect!.openItems.find(
          (candidate) =>
            candidate.controlAccount === '421' && candidate.partyId === partyOf[line.contractId],
        );
        add(
          `${month}-10`,
          `-${line.net}`,
          `SAL-${previous.slice(5)}-${index + 1}`,
          `Salariu ${previous}`,
          async (movement) =>
            b.book('bank.settle', {
              movementId: movement.id,
              allocations: [{ openItem: item!.id, amount: line.net }],
            }),
        );
      }
    }
    if (m === 6)
      add(
        '2026-06-10',
        '-16800.00',
        'DIVIDEND-2025',
        'Plata dividende nete Popescu Ana',
        async (movement) =>
          b.book('bank.settle', {
            movementId: movement.id,
            allocations: [{ openItem: distribution!.effect!.openItems[0]!.id, amount: '16800.00' }],
          }),
      );
    if (m === 3)
      // The gift card bought for 8 March, a social expense.
      add('2026-03-06', '-500.00', 'CADOU-8M', 'Card cadou 8 martie', (movement) =>
        b.book('bank.settle', {
          movementId: movement.id,
          lines: [{ account: '6458', amount: '500.00' }],
        }),
      );
    if (m === 5)
      add(
        '2026-05-19',
        '-300.00',
        'POS-0815',
        'Plata card POS Benzinaria Exemplu',
        allocate(() => itemOf('0815'), '300.00'),
      );
    add(
      `${month}-20`,
      '-605.00',
      `PLATA-H-${mm}`,
      `Plata factura H-${mm}`,
      allocate(() => itemOf(`H-${mm}`), '605.00'),
    );
    add(
      `${month}-20`,
      '-1815.00',
      `PLATA-L-${mm}`,
      `Plata factura L-${mm}`,
      allocate(() => itemOf(`L-${mm}`), '1815.00'),
    );
    if (m === 1)
      add(
        '2026-01-20',
        '-2400.00',
        'PLATA-POL',
        'Plata polita POL-2026',
        allocate(() => itemOf('POL-2026'), '2400.00'),
      );
    if (m === 2) {
      add(
        '2026-02-20',
        '-353.00',
        'PLATA-LIB',
        'Plata factura LIB-77',
        allocate(() => itemOf('LIB-77'), '353.00'),
      );
      add(
        '2026-02-20',
        '-10890.00',
        'PLATA-SRV',
        'Plata factura SRV-1',
        allocate(() => itemOf('SRV-1'), '10890.00'),
      );
    }
    add(
      `${month}-25`,
      '24200.00',
      `INCASARE-${mm}`,
      `Incasare factura ${saleNumber(m)}`,
      allocate(() => itemOf(saleNumber(m)), '24200.00'),
    );
    if (previous) {
      // The previous month's taxes, as declared, on their due date: the single account (the
      // salary taxes, the quarter's micro tax, the dividend tax), CAM and VAT apart.
      const due = deadline(`${month}-25`);
      // The quarter's micro tax in the month after the quarter, June's dividend tax in July.
      const singleAccounts = [
        '4315',
        '4316',
        '444',
        ...(m % 3 === 1 ? ['4418'] : []),
        ...(m === 7 ? ['446'] : []),
      ];
      const single = await owed(due, singleAccounts);
      const cam = await owed(due, ['436']);
      const vat = await owed(due, ['4423']);
      // Each payment is distributed by the engine as the law distributes it; paid in full, it
      // settles every item it is for.
      const pay = (to: string, accounts: string[]) => async (movement: Movement) => {
        const paid = await b.bookAlone('tax.pay', {
          movementId: movement.id,
          authorityId: anaf,
          to,
        });
        expect(
          paid
            .effect!.lines.filter((line) => line.side === 'D')
            .map((line) => line.account)
            .sort(),
          `${month} ${to}`,
        ).toEqual(expect.arrayContaining(accounts));
        return paid;
      };
      add(
        due,
        `-${lei(single)}`,
        `CONT-UNIC-${mm}`,
        `Plata obligatii cont unic CUI ${P1.cui}`,
        pay('single', singleAccounts),
      );
      add(due, `-${lei(cam)}`, `CAM-${mm}`, `Plata CAM CUI ${P1.cui}`, pay('cam', ['436']));
      add(due, `-${lei(vat)}`, `TVA-${mm}`, `Plata TVA CUI ${P1.cui}`, pay('vat', ['4423']));
      expect({ single: lei(single), cam: lei(cam), vat: lei(vat) }, month).toEqual(
        payments[month]!,
      );
    }
    add(`${month}-28`, '-15.00', `COMISION-${mm}`, 'Comision administrare cont', (movement) =>
      b.book('bank.settle', {
        movementId: movement.id,
        lines: [{ account: '627', amount: '15.00' }],
      }),
    );

    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const opening = ronClosing;
    const closing = lei(entries.reduce((sum, entry) => sum + cents(entry.amount), cents(opening)));
    // Odd months come as camt.053, even months as the bank's CSV export.
    if (m % 2) {
      const imported = await b.invoke<{ statements: { added: number }[] }>('bank.import', {
        evidenceId: await b.file(
          `extras-${month}.xml`,
          camtStatement({
            iban: p1Bank,
            currency: 'RON',
            id: `RON-${month}`,
            from: `${month}-01`,
            to: monthEnd(month),
            opening,
            closing,
            entries,
          }),
        ),
        financialYearId: b.s.year.id,
      });
      statementsRead.push({
        month,
        account: 'RON',
        format: 'camt.053',
        added: imported.statements[0]!.added,
      });
    } else {
      const imported = await b.invoke<{
        statements: { added: number }[];
        mapping?: { saved: boolean };
      }>('bank.importCsv', {
        evidenceId: await b.file(
          `extras-${month}.csv`,
          csvStatement({ iban: p1Bank, opening, closing, entries }),
          'text/csv',
        ),
        accountId: ron,
        period: { from: `${month}-01`, to: monthEnd(month) },
        ...(m === 2 ? { mapping: csvMapping } : {}),
      });
      statementsRead.push({
        month,
        account: 'RON',
        format: 'csv',
        added: imported.statements[0]!.added,
      });
    }
    ronClosing = closing;
    const movements = await b.movements(ron);
    expect(movements).toHaveLength(entries.length);
    for (const entry of entries) {
      const movement = movements.find((candidate) => candidate.reference.includes(entry.ref));
      expect(movement, entry.ref).toBeDefined();
      await entry.settle(movement!);
      // Each payment needs the item it settles to stand first.
      if (entry.ref.startsWith('RATA') || entry.ref.startsWith('CREDIT')) await b.flush();
    }

    if (m === 4) {
      // The euro customer pays MS-0004 into the euro account on 15 April, at 5.0840: the item's
      // 12,300.86 lei released, 2,420.00 × 5.0840 = 12,303.28 lei in, 2.42 lei gained.
      await b.invoke('bank.import', {
        evidenceId: await b.file(
          'extras-eur-2026-04.xml',
          camtStatement({
            iban: p1Euro,
            currency: 'EUR',
            id: 'EUR-2026-04',
            from: '2026-04-01',
            to: '2026-04-30',
            opening: '0.00',
            closing: '2420.00',
            entries: [
              {
                date: '2026-04-15',
                amount: '2420.00',
                ref: 'INCASARE-EUR',
                text: 'Incasare factura MS-0004 INCASARE-EUR',
              },
            ],
          }),
        ),
        financialYearId: b.s.year.id,
      });
      const [movement] = await b.movements(euro);
      const collected = await b.book('bank.settle', {
        movementId: movement!.id,
        allocations: [{ openItem: (await itemOf('MS-0004')).id, amount: '2420.00' }],
      });
      expect(lines(collected)).toEqual(['D 5124 12303.28', 'C 4111 12300.86', 'C 7651 2.42']);
      // The receivable leaves at the rate it is carried at, its invoice's (2,420.00 € × 5.0830 =
      // 12,300.86): the line's lei are its euro at its rate, as the SAF-T line states them; the
      // bank's at the day's 5.0840; the gain in lei only.
      expect(
        collected.effect!.lines.map((line) => [
          line.account,
          line.currency?.amount ?? null,
          line.currency?.rate ?? null,
        ]),
      ).toEqual([
        ['5124', '2420.00', '5.0840'],
        ['4111', '2420.00', '5.0830'],
        ['7651', null, null],
      ]);
    }
  }

  /** The quarter's micro tax (art. 53): 1% of the quarter's revenues, less FX gains (765), plus,
   * in the fourth quarter, the year's net favorable FX difference. */
  async function p1Micro(month: string) {
    const quarter = quarterOf(month);
    const input = { quarter, date: monthEnd(month), authorityId: anaf };
    let proposal = await b.propose('tax.micro', input);
    if (codes(proposal).includes('MICRO_DETERMINATION')) {
      // The gift's benefit in kind, booked on 7588, is revenue art. 53 does not exclude.
      proposal = await b.invoke<ProposalView>('tax.micro.revise', {
        proposalId: proposal.id,
        version: proposal.version,
        input: {
          ...input,
          determinations: [
            {
              account: '7588',
              letter: null,
              excluded: '0',
              evidenceId: await b.paper(`analiza-7588-${quarter}.pdf`),
            },
          ],
        },
      });
    }
    // Q1: 3 × 20,000.00 + 10,166.00 (MS-0004) + 200.00 (the gift's benefit, 7588) = 70,366.00 →
    // 703.66 → 704. Q2, Q3: 60,000.00 → 600 (the FX gains on 7651 excluded). Q4: 60,000.00 +
    // the year's 2.42 + 8 × 2.42 = 21.78 of FX gains → 600.2178 → 600.
    const tax = micro[quarter as keyof typeof micro];
    expect(lines(proposal)).toEqual([`D 698 ${tax}`, `C 4418 ${tax}`]);
    await b.settle(proposal, ['MICRO_EMPLOYEE']);
  }

  const p1Returns = async (month: string) => {
    const m = Number(month.slice(5));
    const d300 = await b.prepare('D300', month, d300Options(p1Bank));
    validated(d300);
    // The sales come from the company's own invoicer, series MS, outside the engine's series.
    const numbers = month === '2026-03' ? [3, 4] : [m <= 3 ? m : m + 1];
    validated(
      await b.prepare('D394', month, {
        ...d394Options,
        outsideSeries: {
          allocated: [{ series: 'MS', first: '1', last: '9999' }],
          issued: [{ series: 'MS', first: String(numbers[0]), last: String(numbers.at(-1)) }],
          invoices: numbers.length,
        },
      }),
    );
    // D112 in ANAF's structure of its month: January–June 2026 with the minimum wage of 4,050 lei
    // and the 300 lei relief, from July 4,325 and 200 lei, each from the rule register.
    validated(await b.prepare('D112', month, d112Options));
    // April's holds the euro invoice collected at another rate: the receivable leaves at the
    // invoice's rate, the bank at the day's.
    validated(
      await b.prepare('D406', month, { contact, accounts: { '612': '6123', '646': '6461' } }),
    );
    // D100: the quarter's micro tax in its last month; June's dividend tax in June.
    if (isQuarterEnd(month) || m === 6) {
      const d100 = await b.prepare('D100', month, {
        declarant,
        // The fourth quarter's micro tax is declared by 25 June (ANAF's rule R15.1).
        ...(month === '2026-12' ? { fourthQuarterDue: 'june' } : {}),
      });
      validated(d100);
      expect(summary(d100).obligations).toEqual(m === 6 ? ['micro', 'dividends'] : ['micro']);
    }
  };

  /** Each month: the books balance; D300 = the VAT journals = 4426/4427's movement; D112 = the
   * payroll's postings on 421, 431x, 444 and 436. */
  async function p1Checks(month: string) {
    await balanced(b, `${month}-01`, monthEnd(month));
    await vatCrossCheck(b, month, `${month}-01`, monthEnd(month));
    if (Number(month.slice(5)) >= 7) await payrollCrossCheck(b, month);
  }
});

// =============================================================================================
// Profile 2: a profit-tax services SRL, quarterly VAT.
// =============================================================================================

const P2 = {
  cui: '31079200',
  name: 'Consultanță Profit SRL',
  client: '31158400',
  landlord: '31237601',
  accountant: '31316802',
  caterer: '31396003',
  hardware: '31475204',
};
const p2Bank = ibanOf('BREL', '0000000000200001');
/** Sales from the company's own invoicer, series CP, one a month. */
const p2Sale = (m: number) => `CP-${String(m).padStart(4, '0')}`;

describe('profile 2: a profit-tax services SRL, quarterly VAT, through FY2026', () => {
  const b = new Books();
  let anaf: string;
  let ron: string;
  let assetId: string;
  /** The answers the profit tax's computations cite: the protocol account, the losses. */
  const basis: string[] = [];
  let closing = '60000.00';

  beforeAll(async () => {
    await b.start(P2.cui, P2.name);
    for (const cui of Object.values(P2).filter((value) => /^\d{8}$/.test(value)))
      b.taxpayers.taxpayer(cui);
  });

  test('January: the facts, the determinations and the opening balance with 2025’s loss', async () => {
    const { s } = b;
    await b.at('2026-01-02');
    // No employees: not a micro-enterprise (art. 47 alin. (1) lit. g)), profit tax under the
    // quarterly system; 2025's turnover under 100,000 € keeps VAT quarterly.
    for (const [axis, value, from] of [
      ['entity.form', 'srl', '2020-01-01'],
      ['activity.goods', 'no', '2020-01-01'],
      ['regime.excluded', 'none', '2020-01-01'],
      ['vat.status', 'normal_vat', '2020-01-01'],
      ['vat.cash', 'no', '2020-01-01'],
      ['vat.period', 'quarterly', '2026-01-01'],
      ['income_tax', 'profit', '2020-01-01'],
      ['profit.system', 'quarterly', '2026-01-01'],
      ['employer', 'no', '2020-01-01'],
      ['tax.facilities', 'none', '2026-01-01'],
    ] as const)
      await b.fact(axis, value, from);
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: P2.name,
        vatId: `RO${P2.cui}`,
        address: { lines: ['Str. Mare 3'], city: 'Iași', subdivision: 'RO-IS', country: 'RO' },
      },
    });
    await b.invoke('fx.importBnr', { evidenceId: await b.file('nbrfxrates2026.xml', bnr) });
    ron = (
      await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
        kind: 'bank',
        name: 'Cont curent',
        iban: p2Bank,
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: '2026-01-01',
      })
    ).id;
    anaf = (
      await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_public_institution',
        country: 'RO',
        name: 'ANAF',
      })
    ).id;
    // 1 January: 60,000.00 lei in the bank and 15,000.00 lei of accounting loss carried
    // (1171), against 75,000.00 lei of capital.
    await b.book('ledger.general', {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'DESCHIDERE-2026',
      description: 'Soldurile de deschidere din balanța la 31.12.2025',
      evidenceId: await b.paper('balanta-2025.pdf'),
      lines: [
        { account: '5121', side: 'D', amount: '60000.00' },
        { account: '1171', side: 'D', amount: '15000.00' },
        { account: '1012', side: 'C', amount: '75000.00' },
      ],
    });
    await b.flush();

    const figures = await b.paper('situatii-financiare-2025.pdf');
    const confirmed = await determine(b, 2026, (question) => {
      switch (question.kind) {
        case 'year.figures': {
          // 2025, filed: 380,000.00 lei of turnover, under 100,000 € × 5.0800 = 508,000.00 lei
          // (quarterly VAT, art. 322), no goods from the Union, no employees.
          const all: Record<string, string> = {
            turnover: '380000.00',
            netTurnover: '380000.00',
            totalRevenue: '380500.00',
            vatTurnover: '380000.00',
            exemptionTurnover: '380000.00',
            totalAssets: '90000.00',
            averageEmployees: '0',
            euGoodsAcquisitions: 'no',
            distanceTurnover: '0.00',
            intrastatArrivals: '0.00',
            intrastatDispatches: '0.00',
          };
          const asked = (question.params as { figures: string[] }).figures;
          return {
            values: Object.fromEntries(asked.map((name) => [name, all[name]])),
            evidenceIds: [figures],
          };
        }
        case 'micro.conditions':
          return microConditions(figures);
        case 'profile.fact':
          if (question.subject.id.startsWith('size.category/'))
            return { value: 'micro', effectiveFrom: `${question.subject.id.slice(-4)}-01-01` };
          return undefined;
        case 'determination.confirm':
          return { confirm: true };
        default:
          return undefined;
      }
    });
    expect(confirmed).toMatchObject({
      income_tax: 'profit',
      'vat.period': 'quarterly',
      'size.category': 'micro',
    });
  });

  for (const month of months)
    test(`${month}: documents, the bank, the month's end; each quarter its VAT, profit tax and returns`, async () => {
      await p2Month(month);
    }, 60_000);

  async function p2Month(month: string) {
    const m = Number(month.slice(5));
    const mm = month.slice(5);
    const end = monthEnd(month);
    await b.at(`${nextMonth(month)}-05`);
    const xml = (number: string, input: Partial<XmlInput>) =>
      b.efactura(number, invoiceXml({ company: P2.cui, number, ...input }));

    // Consulting each month: 25,000.00 + 21% VAT. Rent and the accountant, both with VAT.
    const sale = await xml(p2Sale(m), {
      direction: 'sale',
      date: `${month}-12`,
      counterparty: `RO${P2.client}`,
      net: '25000.00',
      tax: '5250.00',
      gross: '30250.00',
      lines: [{ rate: '21', net: '25000.00', name: `Consultanță management ${month}` }],
    });
    await b.book('invoices.recognize', { documentId: sale.id, account: '704' });
    const rent = await xml(`CH-${mm}`, {
      date: `${month}-02`,
      counterparty: `RO${P2.landlord}`,
      net: '3000.00',
      tax: '630.00',
      gross: '3630.00',
      lines: [{ rate: '21', net: '3000.00', name: `Chirie birou ${month}` }],
    });
    await b.book('invoices.recognize', { documentId: rent.id, account: '612' });
    const books = await xml(`CT-${mm}`, {
      date: `${month}-03`,
      counterparty: `RO${P2.accountant}`,
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
      lines: [{ rate: '21', net: '1000.00', name: `Servicii contabilitate ${month}` }],
    });
    await b.book('invoices.recognize', { documentId: books.id, account: '628' });
    // Protocol: a client event in March (2,000.00 + 420.00) and in October (3,000.00 + 630.00),
    // their VAT not deducted, the expense on 623.
    const protocol = { 3: ['2000.00', '420.00', '2420.00'], 10: ['3000.00', '630.00', '3630.00'] }[
      m
    ];
    if (protocol) {
      const event = await xml(`PR-${mm}`, {
        date: `${month}-18`,
        counterparty: `RO${P2.caterer}`,
        net: protocol[0],
        tax: protocol[1],
        gross: protocol[2],
        lines: [{ rate: '21', net: protocol[0], name: 'Eveniment protocol clienți' }],
      });
      await b.book('invoices.recognize', {
        documentId: event.id,
        account: '623',
        deduction: 'none',
      });
    }
    if (m === 2) {
      // A workstation, in use from 20 February: 10,800.00 over 36 months in the books (300.00 a
      // month from March); degressive for the profit tax (art. 28 alin. (4)), 10,800 × 1.5 / 3
      // = 5,400.00 a year, 450.00 a month.
      const station = await xml('WS-1', {
        date: '2026-02-20',
        counterparty: `RO${P2.hardware}`,
        net: '10800.00',
        tax: '2268.00',
        gross: '13068.00',
        lines: [{ rate: '21', net: '10800.00', name: 'Stație de lucru' }],
      });
      await b.book('invoices.recognize', { documentId: station.id, account: '214' });
      assetId = (
        await b.invoke<{ id: string }>('assets.register', {
          number: 'MF-1',
          name: 'Stație de lucru',
          catalogCode: '2.2.9',
          account: '214',
          depreciationAccount: '2814',
          expenseAccount: '6811',
          value: '10800.00',
          lifeMonths: 36,
          fiscalLifeMonths: 36,
          commissionedOn: '2026-02-20',
          evidenceId: await b.paper('pv-punere-in-functiune-MF-1.pdf'),
          documentId: station.id,
        })
      ).id;
      await b.invoke('assets.recordFiscal', {
        assetId,
        method: 'degressive',
        value: '10800.00',
        m1: false,
        evidenceId: await b.paper('fisa-fiscala-MF-1.pdf'),
      });
    }
    await b.flush();
    await p2Details();

    // The bank, each month: the collection, the bills, the fee; the quarter's taxes after it.
    const entries: (Entry & { settle: Settle })[] = [];
    const add = (date: string, amount: string, ref: string, text: string, settle: Settle) =>
      entries.push({ date, amount, ref, text: `${text} ${ref}`, settle });
    const pay = (document: string, amount: string) => async (movement: Movement) =>
      b.book('bank.settle', {
        movementId: movement.id,
        allocations: [{ openItem: (await p2Item(document)).id, amount }],
      });
    add(
      `${month}-10`,
      '-3630.00',
      `PLATA-CH-${mm}`,
      `Plata chirie CH-${mm}`,
      pay(`CH-${mm}`, '3630.00'),
    );
    add(
      `${month}-15`,
      '-1210.00',
      `PLATA-CT-${mm}`,
      `Plata factura CT-${mm}`,
      pay(`CT-${mm}`, '1210.00'),
    );
    if (protocol)
      add(
        `${month}-22`,
        `-${protocol[2]}`,
        `PLATA-PR-${mm}`,
        `Plata factura PR-${mm}`,
        pay(`PR-${mm}`, protocol[2]),
      );
    if (m === 2)
      add('2026-02-25', '-13068.00', 'PLATA-WS-1', 'Plata factura WS-1', pay('WS-1', '13068.00'));
    add(
      `${month}-25`,
      '30250.00',
      `INCASARE-${mm}`,
      `Incasare factura ${p2Sale(m)}`,
      pay(p2Sale(m), '30250.00'),
    );
    if ([4, 7, 10].includes(m)) {
      // The quarter's VAT into its own account and its profit tax into the single account, on
      // their deadline (25 April and 25 July are Saturdays, 25 October a Sunday).
      const due = deadline(`${month}-25`);
      const owed = async (account: string) =>
        (await b.openItems())
          .filter((item) => item.partyId === anaf && item.account === account)
          .reduce((sum, item) => sum - cents(item.balance), 0n);
      const vat = await owed('4423');
      const profit = await owed('4411');
      expect({ vat: lei(vat), profit: lei(profit) }, month).toEqual(p2Payments[month]!);
      add(
        due,
        `-${lei(profit)}`,
        `CONT-UNIC-${mm}`,
        `Plata impozit profit CUI ${P2.cui}`,
        (movement) =>
          b.bookAlone('tax.pay', { movementId: movement.id, authorityId: anaf, to: 'single' }),
      );
      add(due, `-${lei(vat)}`, `TVA-${mm}`, `Plata TVA CUI ${P2.cui}`, (movement) =>
        b.bookAlone('tax.pay', { movementId: movement.id, authorityId: anaf, to: 'vat' }),
      );
    }
    add(`${month}-28`, '-20.00', `COMISION-${mm}`, 'Comision administrare cont', (movement) =>
      b.book('bank.settle', {
        movementId: movement.id,
        lines: [{ account: '627', amount: '20.00' }],
      }),
    );
    entries.sort((a, z) => (a.date < z.date ? -1 : a.date > z.date ? 1 : 0));
    const opening = closing;
    closing = lei(entries.reduce((sum, entry) => sum + cents(entry.amount), cents(opening)));
    await b.invoke('bank.import', {
      evidenceId: await b.file(
        `extras-${month}.xml`,
        camtStatement({
          iban: p2Bank,
          currency: 'RON',
          id: `P2-${month}`,
          from: `${month}-01`,
          to: end,
          opening,
          closing,
          entries,
        }),
      ),
      financialYearId: b.s.year.id,
    });
    const movements = await b.movements(ron);
    expect(movements).toHaveLength(entries.length);
    for (const entry of entries)
      await entry.settle(movements.find((candidate) => candidate.reference.includes(entry.ref))!);
    await b.flush();

    // The month's end: depreciation in the books from March.
    if (m >= 3) {
      const depreciation = await b.book('assets.depreciate', { month });
      expect(lines(depreciation)).toEqual(['D 6811 300.00', 'C 2814 300.00']);
    }
    await b.flush();

    if (isQuarterEnd(month)) {
      const quarter = quarterOf(month);
      await b.book('vat.settle', {
        period: quarter,
        date: end,
        authorityId: anaf,
        evidenceId: await b.paper(`decont-${quarter}.pdf`),
      });
      await b.flush();
      if (m < 12) await p2Profit(quarter, end);
      else return; // December: the year's tax, the year-end and the returns follow.
      await p2Returns(quarter);
      await balanced(b, `${month.slice(0, 5)}${String(m - 2).padStart(2, '0')}-01`, end);
      await vatCrossCheck(
        b,
        quarter,
        `${month.slice(0, 5)}${String(m - 2).padStart(2, '0')}-01`,
        end,
      );
    }
    await balanced(b, `${month}-01`, end);
    await b.close(month);
  }

  test("December: the year's profit tax, the year-end, Q4's returns, the year's close; D101 and the closure", async () => {
    const { s } = b;
    const end = '2026-12-31';
    // The year's tax, regularised against the quarters' 27,400 (p2Profit): 9,446.
    await p2Profit('2026', end);
    await b.flush();
    const year = profitRows.get('2026')!;
    // The bridge's rows, in lei: book depreciation added back (P28), fiscal deducted (P11),
    // protocol over its limit (P26), the year's tax 36,846 (P48) less the 27,400 declared (P50).
    expect(profitRows.get('2026-Q1')).toMatchObject({ P26: '1167', P28: '300', P11: '450' });
    expect(year).toMatchObject({
      P26: '1075',
      P28: '3000',
      P11: '4500',
      P48: '36846',
      P50: '27400',
      P52: '9446',
    });
    // 2025's loss, carried in by the owner's answer, recovered whole in 2026.
    expect(await b.list('profit.losses', { year: 2026 })).toEqual([
      expect.objectContaining({
        year: 2026,
        before: [{ year: 2025, amount: '12000', remaining: '12000' }],
        used: [{ year: 2025, amount: '12000' }],
        after: [],
        recovered: '12000',
      }),
    ]);

    // The year-end: the inventory (the workstation, the bank), no provisions, the result.
    const review = () =>
      b.invoke<{ closed: boolean; items: { id: string; check: string; severity: string }[] }>(
        'yearend.review',
        { financialYearId: s.year.id },
      );
    const printed = [
      'Liste de inventariere la 31.12.2026',
      'Decizia de inventariere nr. 7 din 01.12.2026',
      'MF-1 Statie de lucru - gasita',
      `5121 RON sold extras ${closing}`,
    ];
    const cite = (line: number, text: string) => ({ page: 1, line, text });
    const list = await b.invoke<{ checks: { code: string; status: string }[] }>(
      'documents.record',
      {
        evidenceId: await b.file('liste-inventariere-2026.txt', printed.join('\n'), 'text/plain'),
        kind: 'inventory.list',
        citations: {
          date: cite(1, '31.12.2026'),
          'commission.decision': cite(2, 'nr. 7'),
          'assets.0.number': cite(3, 'MF-1'),
          'bank.0.balance': cite(4, closing),
        },
        body: {
          title: 'Liste de inventariere la 31.12.2026',
          company: { name: P2.name, taxId: P2.cui },
          date: end,
          commission: {
            decision: '7',
            decisionDate: '2026-12-01',
            members: ['Georgescu Ion', 'Pavel Ana'],
          },
          assets: [{ number: 'MF-1', name: 'Stație de lucru', found: true }],
          bank: [{ account: '5121', currency: 'RON', balance: closing }],
        },
      },
    );
    expect(list.checks.filter((check) => check.status !== 'passed')).toEqual([]);
    expect(await b.invoke('inventory.compare', { date: end })).toMatchObject({
      differences: [],
      gaps: [],
    });
    await b.answer(
      {
        kind: 'provisions.review',
        subject: { kind: 'company', id: 'company' },
        params: { year: 2026 },
      },
      { none: true, evidenceIds: [await b.paper('analiza-obligatii-2026.pdf')] },
    );
    expect(
      (await review()).items.filter((item) => item.severity === 'block').map((item) => item.id),
    ).toEqual(['result|close']);
    // Revenue 300,000.00 less 57,290.00 of expenses and 36,846.00 of profit tax: 205,864.00.
    const result = await b.book('year.closeResult', {
      yearEnd: end,
      evidenceId: await b.paper('nota-inchidere-2026.pdf'),
    });
    expect(result.effect!.lines.find((line) => line.account === '121')).toMatchObject({
      side: 'C',
      amount: '205864.00',
    });
    await b.flush();
    expect((await review()).items.filter((item) => item.severity === 'block')).toEqual([]);

    // Q4's returns, its checks, December's close and the year's.
    await p2Returns('2026-Q4');
    await balanced(b, '2026-12-01', end);
    await balanced(b, '2026-10-01', end);
    await vatCrossCheck(b, '2026-Q4', '2026-10-01', end);
    await b.close('2026-12');
    const request = await b.invoke<ActionView>('years.close.request', {
      financialYearId: s.year.id,
    });
    expect((request.preview as Close).findings.filter((item) => item.severity === 'block')).toEqual(
      [],
    );
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    expect((await b.invoke<ActionView>('actions.execute', { id: request.id })).status).toBe(
      'executed',
    );
    expect((await review()).closed).toBe(true);

    await b.at('2027-01-08');
    const next = await s.invoke<{ id: string }>(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    expect(await b.invoke('years.opening', { financialYearId: next.id })).toMatchObject({
      closed: true,
      matches: true,
      differences: [],
    });

    // D101 for 2026 from the books; the assets file; S1005 waits on ANAF's package.
    const d101 = await b.prepare('D101', '2026', { declarant, caen: '7022' });
    validated(d101);
    expect(summary(d101)).toMatchObject({ tax: '36846', declared: '27400', payable: '9446' });
    validated(await b.prepare('D406', '2026', { contact }));
    expect(
      (
        await s.refused(
          b.invoke('declarations.prepare', {
            kind: 'S1005',
            period: '2026',
            options: s1005Options('7022'),
          }),
        )
      )?.code,
    ).toBe('FORMAT_GAP');

    const closure = await b.invoke<{
      status: string;
      obligations: { kind: string; period: string; state: string }[];
      needs: unknown[];
      unsupported: unknown[];
    }>('closure.evaluate', { from: '2026-01', to: '2026-12' });
    expect({
      status: closure.status,
      needs: closure.needs,
      unsupported: closure.unsupported,
    }).toEqual({
      status: 'ELIGIBLE',
      needs: [],
      unsupported: [],
    });
    const owed = closure.obligations.filter((item) => item.state === 'applies');
    const count = (kind: string) => owed.filter((item) => item.kind === kind).length;
    expect({
      D300: count('D300'),
      D394: count('D394'),
      D406: count('D406'),
      D100: count('D100'),
      D101: count('D101'),
      D112: count('D112'),
      D390: count('D390'),
      S1005: count('S1005'),
    }).toEqual({ D300: 4, D394: 4, D406: 5, D100: 3, D101: 1, D112: 0, D390: 0, S1005: 1 });
    const prepared = new Set(b.returns.map((item) => `${item.kind}|${item.period}`));
    expect(
      owed.map((item) => `${item.kind}|${item.period}`).filter((key) => !prepared.has(key)),
    ).toEqual(['S1005|2026']);
    for (const artifact of b.returns) validated(artifact);
    // 4 D300, 4 D394, 4 D406, 3 D100, D101 and the assets file: 17, each validated.
    expect(b.returns).toHaveLength(17);
    await b.keptByTheAgent();
  }, 120_000);

  const p2Detailed = new Set<string>();
  async function p2Details() {
    for (const party of await b.list<{
      id: string;
      name: string;
      taxId: string | null;
      kind: string;
    }>('parties.list')) {
      if (party.kind !== 'ro_legal_entity' || !party.taxId || p2Detailed.has(party.id)) continue;
      p2Detailed.add(party.id);
      await b.invoke('parties.recordDetails', {
        partyId: party.id,
        details: {
          name: party.name,
          vatId: `RO${party.taxId.replace(/^RO/, '')}`,
          address: {
            lines: ['Str. Lăpușneanu 2'],
            city: 'Iași',
            subdivision: 'RO-IS',
            country: 'RO',
          },
        },
      });
    }
  }
  async function p2Item(document: string) {
    const item = (await b.openItems()).find((candidate) => candidate.document === document);
    expect(item, `the open item of ${document}`).toBeDefined();
    return item!;
  }

  /**
   * The quarters' VAT and profit tax paid after them, by hand. VAT: 3 × 5,250.00 collected less
   * the rent's 3 × 630.00 and the accountant's 3 × 210.00 (the protocol's VAT not deducted), Q1
   * also the workstation's 2,268.00. Profit tax: p2Profit's.
   */
  const p2Payments: Record<string, { vat: string; profit: string }> = {
    '2026-04': { vat: '10962.00', profit: '7878.00' },
    '2026-07': { vat: '13230.00', profit: '9668.00' },
    '2026-10': { vat: '13230.00', profit: '9854.00' },
  };

  /**
   * The profit tax of a quarter of the quarterly system (art. 41 alin. (2)–(3)), cumulated from
   * January, less what the earlier quarters declared; the year's, regularised (alin. (5)).
   * Q1: revenue 75,000.00; expenses 9,000.00 rent, 3,000.00 accountant, 2,420.00 protocol,
   * 300.00 depreciation, 60.00 fees = 14,780.00: 60,220.00. Protocol within 2% × (60,220.00 +
   * 2,420.00) = 1,252.80: 1,167.20 over, added back. The book depreciation 300.00 added back,
   * the fiscal 450.00 deducted: 61,237.20; 2025's loss of 12,000.00 recovered (under 70% of the
   * profit): 49,237.20 × 16% = 7,877.95 → 7,878.
   * H1: 150,000.00 less 27,740.00 and Q1's 7,878.00 of tax (691, added back); protocol within
   * 2% × (114,382.00 + 7,878.00 + 2,420.00) = 2,493.60; book 1,200.00 back, fiscal 1,800.00 off:
   * 121,660.00 − 12,000.00 = 109,660.00 × 16% = 17,545.60 → 17,546, less 7,878: 9,668.
   * 9 months: 225,000.00 less 40,700.00: 184,300.00 + 2,100.00 − 3,150.00 − 12,000.00 =
   * 171,250.00 × 16% = 27,400.00, less 17,546: 9,854.
   * The year: 300,000.00 less 57,290.00 (612 36,000, 628 12,000, 623 6,050, 6811 3,000, 627
   * 240): 242,710.00; protocol over 6,050.00 − 2% × (242,710.00 + 6,050.00) = 1,074.80; book
   * 3,000.00 back, fiscal 4,500.00 off: 242,284.80 − 12,000.00 = 230,284.80 × 16% = 36,845.57
   * → 36,846, less 27,400 declared: 9,446.
   */
  const p2Tax = {
    '2026-Q1': '7878.00',
    '2026-Q2': '9668.00',
    '2026-Q3': '9854.00',
    '2026': '9446.00',
  };
  async function p2Profit(period: string, date: string) {
    const input = { period, date, authorityId: anaf };
    let proposal = await b.propose(
      'tax.profit',
      input,
      basis.length ? { answers: basis } : undefined,
    );
    if (!basis.length) {
      // The protocol account and the losses carried in are asked, never guessed.
      expect(codes(proposal)).toEqual(
        expect.arrayContaining(['PROFIT_CLASSIFICATION', 'PROFIT_LOSSES']),
      );
      basis.push(
        await b.answer(b.questionOf(proposal, 'PROFIT_CLASSIFICATION'), {
          nature: 'protocol',
          evidenceIds: [await b.paper('analiza-623.pdf')],
        }),
      );
      basis.push(
        await b.answer(b.questionOf(proposal, 'PROFIT_LOSSES'), {
          vintages: [{ year: 2025, amount: '12000.00', remaining: '12000.00' }],
          evidenceIds: [await b.paper('d101-2025.pdf')],
        }),
      );
      proposal = await b.invoke<ProposalView>('tax.profit.revise', {
        proposalId: proposal.id,
        version: proposal.version,
        input,
        basis: { answers: basis },
      });
    }
    const rows = (
      proposal.effect?.explanation.details as { position: { rows: Record<string, string> } }
    ).position.rows;
    profitRows.set(period, rows);
    expect(lines(proposal), period).toEqual([
      `D 691 ${p2Tax[period as keyof typeof p2Tax]}`,
      `C 4411 ${p2Tax[period as keyof typeof p2Tax]}`,
    ]);
    // The reviewer confirms 2025's turnover was under the minimum tax's 50 million euro (art.
    // 18^1), which the books do not hold, and that no legal reserve is deducted: this profile
    // leaves the reserve (art. 26 alin. (1) lit. a)) out, so the figures above hold without it.
    return b.settle(proposal, ['PROFIT_MINIMUM_TAX', 'LEGAL_RESERVE']);
  }
  const profitRows = new Map<string, Record<string, string>>();

  async function p2Returns(quarter: string) {
    const month = `${quarter.slice(0, 4)}-${String(Number(quarter.slice(-1)) * 3).padStart(2, '0')}`;
    const q = Number(quarter.slice(-1));
    validated(await b.prepare('D300', quarter, d300Options(p2Bank)));
    validated(
      await b.prepare('D394', quarter, {
        ...d394Options,
        caen: '7022',
        outsideSeries: {
          allocated: [{ series: 'CP', first: '1', last: '9999' }],
          issued: [{ series: 'CP', first: String(3 * q - 2), last: String(3 * q) }],
          invoices: 3,
        },
      }),
    );
    validated(
      await b.prepare('D406', quarter, { contact, accounts: { '612': '6123', '623': '6231' } }),
    );
    // D100 for the first three quarters: the profit tax (103).
    if (q < 4) {
      const d100 = await b.prepare('D100', month, { declarant });
      validated(d100);
      expect(summary(d100).obligations).toEqual(['profit']);
    }
  }
});
