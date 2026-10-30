import type { ZodType } from 'zod';
import type { RuleContext } from '../rules';
import type { LocalDate } from '../time';
import type {
  Effect,
  Issue,
  JsonValue,
  LineSpec,
  OpenItemKind,
  ScheduleRow,
  TaxEntrySpec,
} from './effect';
import type { OpenItemInfo } from './validate';
import type { DataClass, Toolset } from './contract';

/**
 * What a treatment reads before it evaluates. The kernel loads exactly this, records what it
 * read as the proposal's read-set, and rechecks the read-set when the proposal is posted.
 */
export interface ReadPlan {
  /** Retained source files the effect cites. */
  evidence?: string[];
  documents?: string[];
  /** Posted entries, with their lines and tax entries (for reversals and corrections). */
  entries?: string[];
  openItems?: OpenItemQuery[];
  /** Reported bank movements. */
  movements?: string[];
  parties?: string[];
  /** The company's dated profile facts (VAT status, regimes, …), read with `profileAt`. */
  profile?: boolean;
  /** Reference rates published on or before `until`, newest first, per currency. */
  fx?: { currency: string; until: LocalDate }[];
  /** Balances at a date of accounts without partners (bank, cash) held in a foreign currency. */
  foreignBalances?: { at: LocalDate };
  /** Everything a tax period holds: its tax entries and the settlement lines already posted.
   * The whole set is one read, so an entry landing in the period makes the proposal stale. */
  taxPeriods?: { tax: string; period: string }[];
  /** Payroll runs with their computed lines. A run never changes; superseding it does. */
  payrollRuns?: string[];
  /** Debit and credit turnover of the accounts under some prefixes, posted in a date range. */
  turnover?: TurnoverQuery[];
  /** What the lines tagged with an analytics item booked on the accounts under some prefixes, per
   * item, account and open item (a loan's interest accrued on 1682, by loan). */
  itemLines?: { prefixes: string[] };
  /** Every fixed asset in the register, with the depreciation booked for it. */
  assets?: boolean;
  /**
   * ANAF's status of a Romanian party on a date (`parties.checkStatus`): the latest snapshot
   * taken for exactly that date. A snapshot for an earlier date does not count: ANAF answers for
   * the date asked, and an earlier answer cannot show an entry in the register of inactive
   * taxpayers made since. A missing snapshot is a read too, so a snapshot taken for the date
   * after the proposal, or a newer one, makes it stale.
   */
  partyStatus?: { partyId: string; date: LocalDate }[];
}

/** What ANAF's register held about a Romanian party on a date, as one snapshot recorded it. */
export interface PartyStatus {
  partyId: string;
  /** The date the status is for (the service's `data`). */
  date: LocalDate;
  /** Its number among the party's snapshots; the read-set version. */
  seq: number;
  cui: string;
  name: string;
  vatPayer: boolean;
  /** VAT on a cash basis (registrul TVA la încasare). */
  cashVat: boolean;
  /** In the register of inactive taxpayers on `date`. */
  inactive: boolean;
  inactiveSince: LocalDate | null;
  reactivatedOn: LocalDate | null;
  splitVat: boolean;
  /** In the RO e-Factura register. */
  eInvoice: boolean;
  struckOffOn: LocalDate | null;
  /** ANAF's answer, kept as evidence. */
  evidenceId: string;
  checkedAt: string;
}

/** The key of a party's status on a date in `Loaded.partyStatus` and in the read-set. */
export const partyStatusKey = (partyId: string, date: LocalDate) => `${partyId}|${date}`;

/** A fixed asset as registered, with what the ledger holds for it; amounts in bani. */
export interface AssetState {
  id: string;
  number: string;
  name: string;
  account: string;
  depreciationAccount: string;
  expenseAccount: string;
  value: bigint;
  /** Accounting useful life, in months. */
  lifeMonths: number;
  commissionedOn: LocalDate;
  disposedOn: LocalDate | null;
  /** Depreciation booked on its depreciation account (lines carrying the asset as their item). */
  depreciated: bigint;
}

/** The lines tagged with one analytics item on one account and open item: their debit and credit
 * in lei and in the currency they carry. */
export interface ItemLines {
  item: string;
  account: string;
  openItem: string | null;
  debit: bigint;
  credit: bigint;
  debitMinor: bigint;
  creditMinor: bigint;
}

/** The read key of an item-lines query, as `Loaded.itemLines` holds it. */
export const itemLinesKey = (query: { prefixes: string[] }) => [...query.prefixes].sort().join(',');

export interface TurnoverQuery {
  prefixes: string[];
  from: LocalDate;
  to: LocalDate;
}

/** The read key of a turnover query, as `Loaded.turnover` holds it. */
export const turnoverKey = (query: TurnoverQuery) =>
  `${[...query.prefixes].sort().join(',')}|${query.from}|${query.to}`;

export interface AccountTurnover {
  account: string;
  debit: bigint;
  credit: bigint;
}

export interface OpenItemQuery {
  ids?: string[];
  /** Open items that lines of this posted entry touched. */
  touchedBy?: string;
  /** The items a document's bookings opened, those whose booking was reversed left out: a
   * document booked again after a reversal has the new booking's items only. */
  documentId?: string;
  partyId?: string;
  kind?: OpenItemKind;
  /** Only items held on accounts under these prefixes (a loan on 1621, 167 or 4551). */
  accounts?: string[];
  /** Only items whose balance is not zero. */
  openOnly?: boolean;
  /** With each item's schedule (its latest version), when it has one. */
  schedules?: boolean;
  /** Only items held in a currency other than RON. */
  foreign?: boolean;
  /** With the ids of the posted entries whose lines touch each item (`history`), to read them
   * with `entries` in a follow-up. */
  history?: boolean;
}

/** One recorded read. `version` identifies the state read: for an open item, its number of
 * posted lines; for an immutable record, its content hash. */
export interface ReadSetEntry {
  kind:
    | 'evidence'
    | 'document'
    | 'entry'
    | 'openItem'
    | 'schedule'
    | 'movement'
    | 'party'
    | 'profile'
    | 'fx'
    | 'balance'
    | 'taxPeriod'
    | 'artifact'
    | 'payrollRun'
    | 'turnover'
    | 'itemLines'
    | 'assets'
    | 'partyStatus'
    /** Where a document read comes from: its authority, its group and whether it was
     * superseded (the engine adds it beside the document's own entry). */
    | 'documentSource'
    /** A question a proposal's basis cites, by its id: the version is its latest answer's id
     * (the engine adds it, and loads the answer into `Loaded.answers`). */
    | 'answer';
  id: string;
  version: string;
}

export interface DocumentRecord {
  id: string;
  kind: string;
  schema: string;
  body: JsonValue;
  bodyHash: string;
  docDate: LocalDate;
  partyId: string | null;
  currency: string | null;
  number: string | null;
  evidenceId: string | null;
}

export interface OpenItemState extends OpenItemInfo {
  documentId: string | null;
  dueDate: LocalDate | null;
  /** The posted entry that created the item. */
  originEntryId: string;
  /** Number of posted lines; the item's version in the read-set. */
  movements: number;
  /** On request (`history`): the posted entries with lines on the item, in posting order. Each
   * adds a line, so the item's version covers the list. */
  history?: readonly string[];
  /** The item's schedule, loaded on request: its latest version's method and rows, in due order.
   * Rows are written with the entry that creates them and never change; a later version (a loan's
   * revised plan) is a read of its own. */
  schedule?: { id: string; version: number; method: string; rows: readonly ScheduleRow[] };
}

export interface EvidenceRecord {
  id: string;
  hash: string;
  filename: string;
  mediaType: string;
}

/** A movement as the bank reported it, with the ledger account its treasury account uses. */
export interface MovementRecord {
  id: string;
  treasuryAccountId: string;
  ledgerAccount: string;
  currency: string;
  bookingDate: LocalDate;
  valueDate: LocalDate | null;
  /** Signed: positive for money received, negative for money paid. */
  amountMinor: bigint;
  reference: string;
  counterparty: string | null;
}

export interface PartyRecord {
  id: string;
  kind: string;
  country: string;
  taxId: string | null;
  name: string;
}

export interface FiscalYear {
  id: string;
  kind: 'financial' | 'fiscal';
  from: LocalDate;
  to: LocalDate;
}

/** A posted entry as treatments see it: the effect it recorded. */
export interface PostedEntry {
  id: string;
  number: number;
  date: LocalDate;
  journalCode: string;
  description: string;
  lines: LineSpec[];
  taxEntries: TaxEntrySpec[];
  /** For a reversal (`ledger.reverse`), the entry it reverses. */
  reverses?: string;
}

export interface FxRate {
  id: string;
  source: string;
  currency: string;
  date: LocalDate;
  rate: string;
  multiplier: number;
}

export interface AccountBalance {
  account: string;
  currency: string;
  bani: bigint;
  minor: bigint;
}

/** A posted tax entry as a tax period lists it. */
export interface TaxLedgerEntry {
  entryId: string;
  seq: number;
  taxNo: number;
  key: string;
  direction: 'output' | 'input';
  code: string;
  baseBani: bigint;
  taxBani: bigint;
  deductibleBani: bigint;
  ledgerBani: bigint;
  taxPoint: LocalDate;
  /** Null while the tax is not chargeable (deductible): the period lists it, but its amounts
   * are not yet the period's to declare or settle (VAT on collection). */
  exigibility: LocalDate | null;
  documentId: string | null;
  partyId: string | null;
  originTaxEntry: string | null;
  attributes: Readonly<Record<string, string>>;
}

/** A posted line that settled (cleared) a tax period, signed as booked. */
export interface TaxSettlementLine {
  entryId: string;
  account: string;
  side: 'D' | 'C';
  bani: bigint;
}

export interface TaxPeriodLedger {
  tax: string;
  period: string;
  entries: readonly TaxLedgerEntry[];
  settlements: readonly TaxSettlementLine[];
}

export interface ProfileFact {
  axis: string;
  value: string;
  effectiveFrom: LocalDate;
}

/** What the kernel loaded for a plan, ordered deterministically. */
/** One contract's line in a payroll run; amounts in bani. */
export interface PayrollLineState {
  contractId: string;
  employeeId: string;
  /** The employee as a party: their 421 open item. */
  partyId: string;
  cash: bigint;
  vouchers: bigint;
  cas: bigint;
  cass: bigint;
  casEmployer: bigint;
  cassEmployer: bigint;
  tax: bigint;
  unionDues: bigint;
  net: bigint;
  cam: bigint;
  /** The CAM base: CAM is owed on the employer's total, rounded once. */
  camBase: bigint;
  /** The sick pay borne by the health insurance fund, within `cash`: the employer pays it and
   * recovers it from the fund. */
  sickFund: bigint;
}

export interface PayrollRunState {
  id: string;
  month: string;
  round: number;
  state: 'prepared' | 'superseded';
  /** Problems found when it was computed: such a run is not posted. */
  issues: number;
  lines: readonly PayrollLineState[];
}

/**
 * A person's answer to a question a proposal's basis cites (`questions.answer`): its latest
 * answer, which the read-set records. The engine loads the basis's answers, never a plan.
 */
export interface AnswerRecord {
  questionId: string;
  /** The answer's id: its version in the read-set. */
  answerId: string;
  kind: string;
  /** As the question was asked; compare through its kind's `normalize`. */
  subject: { kind: string; id: string };
  params: JsonValue;
  /** As the kind's answer schema read it. */
  value: JsonValue;
  /** The answer kept as evidence. */
  evidenceId: string;
  /** When the engine recorded the answer (its clock, never the database's), as an ISO instant. */
  answeredAt: string;
}

export interface Loaded {
  years: readonly FiscalYear[];
  evidence: ReadonlyMap<string, EvidenceRecord>;
  documents: ReadonlyMap<string, DocumentRecord>;
  entries: ReadonlyMap<string, PostedEntry>;
  openItems: ReadonlyMap<string, OpenItemState>;
  movements: ReadonlyMap<string, MovementRecord>;
  parties: ReadonlyMap<string, PartyRecord>;
  profile: readonly ProfileFact[];
  fxRates: ReadonlyMap<string, readonly FxRate[]>;
  balances: readonly AccountBalance[];
  /** By `${tax}|${period}`. */
  taxLedger: ReadonlyMap<string, TaxPeriodLedger>;
  payrollRuns: ReadonlyMap<string, PayrollRunState>;
  /** By `turnoverKey(query)`: each account with posted lines in the range. */
  turnover: ReadonlyMap<string, readonly AccountTurnover[]>;
  /** By `itemLinesKey(query)`: each item, account and open item with tagged lines. */
  itemLines: ReadonlyMap<string, readonly ItemLines[]>;
  assets: ReadonlyMap<string, AssetState>;
  /** By `partyStatusKey`: only the statuses a snapshot exists for. */
  partyStatus: ReadonlyMap<string, PartyStatus>;
  /** By question id: the answers the proposal's basis cites, and only those. */
  answers: ReadonlyMap<string, AnswerRecord>;
}

/** The company profile value on an axis at a date, or null when nothing is recorded. */
export function profileAt(loaded: Loaded, axis: string, date: LocalDate): string | null {
  let value: string | null = null;
  for (const fact of loaded.profile)
    if (fact.axis === axis && fact.effectiveFrom <= date) value = fact.value;
  return value;
}

/**
 * The VAT period containing a date: its calendar month, or its quarter (`2026-Q4`) when the
 * company's `vat.period` fact says quarterly. The month is the legal default tax period
 * (Cod fiscal art. 322; paragraph to cite in the source register).
 */
export function vatPeriodOf(loaded: Loaded, date: LocalDate): string {
  if (profileAt(loaded, 'vat.period', date) !== 'quarterly') return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

export interface Evaluation {
  effect: Effect | null;
  issues: Issue[];
}

/**
 * A pure accounting treatment: the same input, loaded state and rules always give the same
 * evaluation. It may not read the clock, randomness or anything outside `loaded` and `rules`.
 * Open items and schedules it creates are named by refs the kernel turns into stable ids.
 */
export interface Treatment<Input = unknown> {
  id: string;
  version: number;
  description: string;
  input: ZodType<Input>;
  /** Identifies what the proposal recognizes. A company recognizes each subject once, across all
   * treatments: every treatment that recognizes a document uses `document:<id>`. */
  subject(input: Input): string;
  plan(input: Input): ReadPlan;
  /** A second read that depends on the first, e.g. rates for a document's currency and date. */
  followUp?(input: Input, loaded: Loaded): ReadPlan | null;
  evaluate(input: Input, loaded: Loaded, rules: RuleContext): Evaluation;
  /** Whether an agent credential may propose this treatment. */
  agent: boolean;
  /** What it books, in one line of English for agents, beside the Romanian `description`. */
  summary: string;
  /** The toolset its `.propose` and `.revise` operations belong to; `books` when omitted. */
  toolset?: Toolset;
  /** The data its proposals read and show; the books alone when omitted. */
  dataClasses?: readonly DataClass[];
}

/** The financial year containing a date, if exactly one does. */
export function financialYearOf(loaded: Loaded, date: LocalDate): FiscalYear | undefined {
  const years = loaded.years.filter(
    (year) => year.kind === 'financial' && year.from <= date && date <= year.to,
  );
  return years.length === 1 ? years[0] : undefined;
}
