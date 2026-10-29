import type { ZodType } from 'zod';
import type { RuleContext } from '../rules';
import type { LocalDate } from '../time';
import type { Effect, Issue, JsonValue, LineSpec, OpenItemKind, TaxEntrySpec } from './effect';
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
    | 'balance';
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

export interface ProfileFact {
  axis: string;
  value: string;
  effectiveFrom: LocalDate;
}

/** What the kernel loaded for a plan, ordered deterministically. */
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
}

/** The company profile value on an axis at a date, or null when nothing is recorded. */
export function profileAt(loaded: Loaded, axis: string, date: LocalDate): string | null {
  let value: string | null = null;
  for (const fact of loaded.profile)
    if (fact.axis === axis && fact.effectiveFrom <= date) value = fact.value;
  return value;
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
