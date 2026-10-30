import type { ProfileFact } from '../kernel';
import type { LocalDate } from '../time';

/**
 * Who keeps the books, and how. An SRL keeps double-entry books (Legea nr. 82/1991); a PFA, an II
 * and an IF keep single-entry books (OUG nr. 44/2008 art. 15; OMFP nr. 170/2015 art. 2 lit. a)).
 * The engine keeps its internal double-entry ledger either way: for single-entry books the
 * statutory registers are projections of it (`ro/pit`).
 */
export const entityForms = ['srl', 'pfa', 'ii', 'if'] as const;
export type EntityForm = (typeof entityForms)[number];
export const booksSystems = ['double', 'single'] as const;
export type BooksSystem = (typeof booksSystems)[number];

/** The forms whose owners are taxed on income (Codul fiscal titlul IV), not on profit. */
export const individualForms: readonly EntityForm[] = ['pfa', 'ii', 'if'];

/** A dated profile value at a date, from the facts in effect order; null when none is recorded. */
function factAt(facts: readonly ProfileFact[], axis: string, date: LocalDate) {
  let value: string | null = null;
  for (const fact of facts)
    if (fact.axis === axis && fact.effectiveFrom <= date) value = fact.value;
  return value;
}

/** The legal form at a date. A company with no `entity.form` fact is an SRL, as the engine has
 * always assumed. */
export function entityFormOf(facts: readonly ProfileFact[], date: LocalDate): EntityForm {
  return (factAt(facts, 'entity.form', date) as EntityForm | null) ?? 'srl';
}

/**
 * The books system at a date: the recorded `books.system`, else the form's own (single entry for
 * a PFA, II or IF, double entry for an SRL). Whether a PFA, II or IF may opt for double entry is
 * open (OUG nr. 44/2008 art. 15 against OMFP nr. 170/2015 art. 3): the profile refuses that option
 * until an expert contabil answers.
 */
export function booksSystemOf(facts: readonly ProfileFact[], date: LocalDate): BooksSystem {
  const recorded = factAt(facts, 'books.system', date) as BooksSystem | null;
  if (recorded) return recorded;
  return individualForms.includes(entityFormOf(facts, date)) ? 'single' : 'double';
}

/**
 * Treatments that belong to double-entry books of a company, with why single-entry books have no
 * use for them (docs/PFA_II_IF.md §4.2): cash basis makes accruals and deferrals pointless; there is
 * no month-end revaluation, no result to close to 121, no legal reserve, no dividends, no
 * microenterprise tax (Codul fiscal art. 47 is for legal persons) and no annual statements (OMFP
 * nr. 170/2015 cap. II pct. 11).
 */
export const singleEntryExcluded: Readonly<Record<string, string>> = {
  'accruals.record': 'cheltuielile și veniturile se recunosc la plată și la încasare',
  'accruals.settle': 'cheltuielile și veniturile se recunosc la plată și la încasare',
  'deferrals.defer': 'cheltuielile și veniturile se recunosc la plată și la încasare',
  'deferrals.release': 'cheltuielile și veniturile se recunosc la plată și la încasare',
  'loans.accrue': 'dobânzile se recunosc la plată',
  'fx.revalue': 'disponibilitățile în valută nu se reevaluează la sfârșitul lunii',
  'year.closeResult': 'nu există rezultat contabil de închis în contul 121',
  'year.legalReserve': 'nu există rezervă legală',
  'year.transferResult': 'nu există rezultat contabil de repartizat',
  'dividends.distribute': 'nu există dividende',
  'dividends.withhold': 'nu există dividende',
  'tax.micro': 'impozitul pe veniturile microîntreprinderilor se aplică doar persoanelor juridice',
};
