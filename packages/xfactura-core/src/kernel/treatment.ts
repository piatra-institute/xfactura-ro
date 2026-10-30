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
  documentId?: string;
  partyId?: string;
  kind?: OpenItemKind;
  /** Only items whose balance is not zero. */
  openOnly?: boolean;
  /** With each item's schedule (its latest version), when it has one. */
  schedules?: boolean;
  /** Only items held in a currency other than RON. */
  foreign?: boolean;
}

/** One recorded read. `version` identifies the state read: for an open item, its number of
 * posted lines; for an immutable record, its content hash. */
export interface ReadSetEntry {
  kind:
    | 'evidence'
    | 'document'
    | 'entry'
    | 'openItem'
    | 'movement'
    | 'party'
    | 'profile'
    | 'fx'
    | 'balance'
    | 'taxPeriod'
    | 'artifact'
    | 'payrollRun'
    | 'turnover'
    | 'assets'
    | 'partyStatus';
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
  /** Number of posted lines; the item's version in the read-set. */
  movements: number;
  /** The item's schedule, loaded on request: its method and rows, in due order. Rows are written
   * with the entry that creates them and never change, so the item's version covers them. */
  schedule?: { method: string; rows: readonly ScheduleRow[] };
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
  direction: 'output' | 'input';
  code: string;
  baseBani: bigint;
  taxBani: bigint;
  deductibleBani: bigint;
  ledgerBani: bigint;
  taxPoint: LocalDate;
  documentId: string | null;
  partyId: string | null;
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
  assets: ReadonlyMap<string, AssetState>;
  /** By `partyStatusKey`: only the statuses a snapshot exists for. */
  partyStatus: ReadonlyMap<string, PartyStatus>;
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
}

/** The financial year containing a date, if exactly one does. */
export function financialYearOf(loaded: Loaded, date: LocalDate): FiscalYear | undefined {
  const years = loaded.years.filter(
    (year) => year.kind === 'financial' && year.from <= date && date <= year.to,
  );
  return years.length === 1 ? years[0] : undefined;
}
