import type { ZodType } from 'zod';
import type { RuleContext } from '../rules';
import type { LocalDate } from '../time';
import type {
  Effect,
  Issue,
  JsonValue,
  LineSpec,
  JournalClass,
  OpenItemKind,
  ScheduleRow,
  StockMoveSpec,
  TaxEntrySpec,
} from './effect';
import type { OpenItemInfo, StockLayerInfo } from './validate';
import type { DataClass, Toolset } from './contract';

/**
 * What a treatment reads before it evaluates. The kernel loads exactly this, records what it
 * read as the proposal's read-set, and rechecks the read-set when the proposal is posted.
 */
export interface ReadPlan {
  /** Retained source files the effect cites. */
  evidence?: string[];
  documents?: string[];
  /** With the documents' standing bookings, including balances carried by opening items. */
  documentBookings?: string[];
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
  /** Every fixed asset in the register, with the depreciation booked for it and its latest
   * fiscal basis. */
  assets?: boolean;
  /** The postings that stand of the profit tax (`tax.profit`) and of prior-year corrections
   * (`correction.priorYear`), with the position each effect recorded: earlier quarters' tax, the
   * years' loss vintages. */
  profitPostings?: boolean;
  /**
   * ANAF's status of a Romanian party on a date (`parties.checkStatus`): the latest snapshot
   * taken for exactly that date. A snapshot for an earlier date does not count: ANAF answers for
   * the date asked, and an earlier answer cannot show an entry in the register of inactive
   * taxpayers made since. A missing snapshot is a read too, so a snapshot taken for the date
   * after the proposal, or a newer one, makes it stale.
   */
  partyStatus?: { partyId: string; date: LocalDate }[];
  /** The stock register: the positions (an item in a warehouse) with their layers, and the
   * catalogue's cards of the items read. */
  stock?: StockQuery;
  /** Production (G4): the bills of materials, the work orders with their events and, on request,
   * the lines production postings tagged (`production:…`). */
  production?: ProductionQuery;
}

/**
 * What a treatment reads of the stock register. A position is read whole, layers and all, with
 * the number of moves posted on it as its version: a move landing on it (another sale of the
 * same item) makes the proposal stale. A position nothing moved yet is a read too.
 */
export interface StockQuery {
  /** Each item in each named warehouse. */
  positions?: { item: string; warehouse: string }[];
  /** The positions the moves of this posted entry touched (a reversal). */
  touchedBy?: string;
  /** Every position of the register, as one read whose version is the register's moves (the
   * inventory, the write-downs, the period's costing, the D406 stock file). */
  all?: boolean;
  /** Catalogue cards to load even without a position (a receipt's new items). */
  items?: string[];
  /** Warehouses to load. */
  warehouses?: string[];
  /** Every item of the catalogue and every warehouse (an inventory list names items by code). */
  catalogue?: boolean;
  /** With each layer's flows in a date range: what it held before, what entered and what left
   * (the periodic average's month). */
  flows?: { from: LocalDate; to: LocalDate };
  /** With each layer's moves in the months still open, summed per day (`StockLayerState.days`):
   * an exit reads what its layers held on its own date, which the plan may not know yet (an
   * invoice's), and nothing is posted in a closed month. */
  dated?: boolean;
}

/**
 * What moved on a layer in a date range, signed. A move is an entry or an exit by the line it
 * explains, a debit or a credit of the stock account (a red storno of a receipt, a return to the
 * supplier, is a negative entry; of an exit, a customer's return, a negative exit); a reversal's
 * move by the move it mirrors, so a black storno nets against its original; a move without a line
 * (a transfer) by the sign of its quantity.
 */
export interface StockFlows {
  opening: { quantity: bigint; bani: bigint };
  entered: { quantity: bigint; bani: bigint };
  left: { quantity: bigint; bani: bigint };
}

/** The read key of a stock position, as `Loaded.stock` and the read-set hold it. */
export const stockPositionKey = (item: string, warehouse: string) => `${item}|${warehouse}`;
/** The read-set id of a read of the whole register. */
export const stockRegisterKey = '*';

/** A stock layer as the register holds it. */
export interface StockLayerState extends StockLayerInfo {
  date: LocalDate;
  originEntryId: string;
  /** The posting order of the entry that created it. */
  seq: number;
  /** On request (`flows`). */
  flows?: StockFlows;
  /** On request (`dated`): what moved on it each day of the months still open, in date order. */
  days?: readonly StockDay[];
}

/** A layer's moves of one day, summed. */
export interface StockDay {
  date: LocalDate;
  quantity: bigint;
  bani: bigint;
}

/** An item in a warehouse: its layers in FIFO order (by date, then posting), with what each
 * holds after every posted move. */
export interface StockPosition {
  item: string;
  warehouse: string;
  /** Moves posted on the position: its version in the read-set. */
  moves: number;
  layers: readonly StockLayerState[];
}

/** An item of the catalogue, as recorded. */
export interface StockItemRecord {
  id: string;
  code: string;
  name: string;
  /** UN/ECE Recommendation 20 code of its unit of measure (H87 a piece, KGM a kilogram). */
  unit: string;
  /** The NC8 code of the combined nomenclature, when known (D406 Products, Intrastat). */
  nc8: string | null;
  /** The stock account its layers are on (371 goods, 301 raw materials, …). */
  account: string;
  /** The VAT category it is normally sold in (S, E, …), for the invoicer's lines. */
  vatCategory: string | null;
}

/** A warehouse (gestiune) and the person responsible for it (gestionarul). */
export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  keeper: string;
}

/**
 * What a treatment reads of production (G4): the whole catalogue of bills of materials and work
 * orders, as one read whose version counts them and their events; with `lines`, also every line
 * tagged `production:…` (per order, per product account) dated in the range, with the quantity
 * the stock moves on it carry, whose count and last posting are part of the version.
 */
export interface ProductionQuery {
  lines?: { from?: LocalDate; to: LocalDate };
}

/** A version of a bill of materials (BOM): the materials one output quantity of its product
 * takes, with its labour and machine norms and its standard cost when the company keeps one. */
export interface BomRecord {
  id: string;
  /** The product, an item of the catalogue on a product account (341, 345). */
  itemId: string;
  version: number;
  validFrom: LocalDate;
  /** The quantity of product the norms are for, in thousandths of its unit. */
  outputQuantity: bigint;
  /** The standard cost of the output quantity, in bani; null when none is kept. */
  standardCost: bigint | null;
  /** Labour and machine hours for the output quantity, in thousandths of an hour. */
  labourHours: bigint | null;
  machineHours: bigint | null;
  evidenceId: string;
  lines: readonly { lineNo: number; itemId: string; quantity: bigint }[];
}

/** A work order (comandă de producție): its product, the BOM version it is costed on, the
 * quantity launched, the day it opened and the day it closed, if it did. */
export interface WorkOrderRecord {
  id: string;
  number: string;
  itemId: string;
  bomId: string;
  quantity: bigint;
  openedOn: LocalDate;
  closedOn: LocalDate | null;
  evidenceId: string;
}

/** Lines tagged by production postings, summed per tag, account, entry date and the stock item
 * their moves carry (null for lines without moves). Signed amounts net reversals out. */
export interface ProductionLine {
  tag: string;
  account: string;
  date: LocalDate;
  debit: bigint;
  credit: bigint;
  item: string | null;
  /** The net quantity of the moves on these lines, in thousandths. */
  quantity: bigint;
}

export interface ProductionState {
  boms: ReadonlyMap<string, BomRecord>;
  orders: ReadonlyMap<string, WorkOrderRecord>;
  lines: readonly ProductionLine[];
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

/** A fixed asset's fiscal basis (Codul fiscal art. 28), its latest version on the register;
 * amounts in bani. The methods are the tax module's (`ro/profit/depreciation.ts`). */
export interface AssetFiscalBasis {
  version: number;
  method: string;
  /** The fiscal value at entry. */
  value: bigint;
  /** The normal life, in months. */
  lifeMonths: number;
  /** The share of the value taken in the first year (the accelerated methods). */
  firstYearPercent: string | null;
  /** An M1 passenger car whose depreciation is capped monthly. */
  m1: boolean;
  /** A new asset (the superaccelerated method). */
  newAsset: boolean;
  evidenceId: string;
}

/** A fixed asset as registered, with what the ledger holds for it; amounts in bani. */
export interface AssetState {
  id: string;
  number: string;
  name: string;
  /** The fixed-asset catalogue's code (HG nr. 2.139/2004). */
  catalogCode: string;
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
  /** Its latest fiscal basis, or null while none is recorded. */
  fiscal: AssetFiscalBasis | null;
}

/** A posting that stands of the profit tax or of a prior-year correction, with the position its
 * effect recorded (`explanation.details.position`). */
export interface ProfitPosting {
  entryId: string;
  treatmentId: string;
  subject: string;
  date: LocalDate;
  /** The entry's sequence: postings come in this order. */
  seq: number;
  position: JsonValue;
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
  /** `original`: a reversal's lines count on the side of the lines they reverse, as their red
   * storno (negative amounts), so a black storno nets against its original instead of adding to
   * both sides' turnover (what moved in and out, as the coefficients of pct. 286 read it). */
  sides?: 'original';
}

/** The read key of a turnover query, as `Loaded.turnover` holds it. */
export const turnoverKey = (query: TurnoverQuery) =>
  `${[...query.prefixes].sort().join(',')}|${query.from}|${query.to}${query.sides ? `|${query.sides}` : ''}`;

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
  /** With what created each item (`origin`): the treatment and subject of the proposal whose
   * entry opened it, and the analytics item of its opening line. */
  origins?: boolean;
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
    | 'profitPostings'
    | 'partyStatus'
    /** Where a document read comes from: its authority, its group and whether it was
     * superseded (the engine adds it beside the document's own entry). */
    | 'documentSource'
    /** A document group's standing booking, or its absence. */
    | 'documentBooking'
    /** A question a proposal's basis cites, by its id: the version is its latest answer's id
     * (the engine adds it, and loads the answer into `Loaded.answers`). */
    | 'answer'
    /** A stock position (`item|warehouse`) or the whole register (`*`): its moves posted. */
    | 'stock'
    /** The production catalogue (`catalogue`) and, with lines, its tagged lines in a range. */
    | 'production';
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
  /** On request (`documentBookings`), the standing entry carrying this document's balance. */
  booking?: { entryId: string; number: number; opening: boolean };
  /** On request (`documentBookings`), the group's root, or this document outside a group. */
  groupId?: string;
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
  /** On request (`origins`): what created the item. It never changes, so the item's version
   * covers it. */
  origin?: OpenItemOrigin;
}

/** The posting that opened an open item: its proposal's treatment and subject, its date, and the
 * analytics item (`LineSpec.analytics.item`) of the line that opened it, if it carried one. */
export interface OpenItemOrigin {
  treatmentId: string;
  subject: string;
  date: LocalDate;
  tag: string | null;
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
  /** `general` when omitted. */
  journalClass?: JournalClass;
  journalCode: string;
  description: string;
  lines: LineSpec[];
  taxEntries: TaxEntrySpec[];
  /** The stock moves it posted, with their layers' ids; none when omitted. */
  stockMoves?: StockMoveSpec[];
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
  /** Benefits in kind, taxable: salary income not paid in money. */
  inKind: bigint;
  /** What garnishment orders take from the net pay, each owed to its creditor on 427. */
  garnishments: readonly { orderId: string; partyId: string; amount: bigint }[];
}

export interface PayrollRunState {
  id: string;
  month: string;
  round: number;
  state: 'prepared' | 'superseded';
  /** Problems found when it was computed: such a run is not posted. */
  issues: number;
  /** The posted run of the month this one corrects (a round after the first), or null. */
  corrects: string | null;
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
  /** In posting order. */
  profitPostings: readonly ProfitPosting[];
  /** By `partyStatusKey`: only the statuses a snapshot exists for. */
  partyStatus: ReadonlyMap<string, PartyStatus>;
  /** By question id: the answers the proposal's basis cites, and only those. */
  answers: ReadonlyMap<string, AnswerRecord>;
  /** By `stockPositionKey`: the positions read, each with its layers. */
  stock: ReadonlyMap<string, StockPosition>;
  /** The catalogue's items and the warehouses read. */
  stockItems: ReadonlyMap<string, StockItemRecord>;
  warehouses: ReadonlyMap<string, WarehouseRecord>;
  /** Production (G4), when the plan reads it. */
  production?: ProductionState;
}

/**
 * The fact in effect on an axis at a date: of the facts in effect order (superseded ones left
 * out, as the state loader gives them), the last on the axis effective on or before the date;
 * null when none is.
 */
export function factInEffect<Fact extends { axis: string; effectiveFrom: string }>(
  facts: readonly Fact[],
  axis: string,
  date: string,
): Fact | null {
  let found: Fact | null = null;
  for (const fact of facts) if (fact.axis === axis && fact.effectiveFrom <= date) found = fact;
  return found;
}

/** The company profile value on an axis at a date, or null when nothing is recorded. */
export function profileAt(loaded: Loaded, axis: string, date: LocalDate): string | null {
  return factInEffect(loaded.profile, axis, date)?.value ?? null;
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
