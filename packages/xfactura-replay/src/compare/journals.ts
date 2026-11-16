import type { D406Filed, D406FiledJournal, D406FiledTransaction } from 'xfactura-core/ro/saft/read';
import { isLocalDate } from 'xfactura-core/time';
import { add, amount } from './decimal';
import { difference, fail, order, type AccountMapping, type Difference } from './differences';
import { transactionPeriod } from './filed';

/** Undefined is missing evidence. A null period explicitly means not yet exigible. */
export type ComparisonTax = {
  code?: string;
  base?: string;
  tax?: string;
  deductible?: string;
  period?: string | null;
};
export type TaxSupplement = ComparisonTax & {
  /** Zero-based filed line/tax coordinates; omission uses the flattened filed tax position. */
  filed?: { line: number; tax: number };
};
export type SourceJournalTransaction = {
  source: string;
  reference: string;
  transaction: D406FiledTransaction;
  /** Evidence supplied by the caller; D406 itself has no deductible or VAT-period field. */
  taxEntries?: readonly TaxSupplement[];
};
export type JournalLine = { account: string; side: 'D' | 'C'; amount: string };
export type EngineJournalEntry = {
  id: string;
  subject: string;
  date: string;
  lines: readonly JournalLine[];
  taxEntries: readonly ComparisonTax[];
};

export function migrationSubject(source: string, reference: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(source) || !reference || reference.length > 100)
    fail('COMPARISON_REFERENCE', 'Identitatea sursei nu corespunde notei de migrare.');
  return `migration:${source}:${reference}`;
}

/** The caller supplies the same reference builder used when replaying through migration.journal. */
export function transactionsFromD406(
  filed: D406Filed,
  source: string,
  reference: (journal: D406FiledJournal, transaction: D406FiledTransaction) => string,
): SourceJournalTransaction[] {
  return filed.generalLedgerEntries.journals.flatMap((journal) =>
    journal.transactions.map((transaction) => ({
      source,
      reference: reference(journal, transaction),
      transaction,
    })),
  );
}

function mergeLines(lines: readonly JournalLine[]): JournalLine[] {
  const merged = new Map<string, JournalLine>();
  for (const line of lines) {
    const value = amount(line.amount);
    if (!line.account || !['D', 'C'].includes(line.side) || value === null)
      fail('COMPARISON_LINE', 'O linie nu are cont, sens sau sumă zecimală validă.');
    const key = JSON.stringify([line.account, line.side]);
    const existing = merged.get(key);
    merged.set(key, {
      account: line.account,
      side: line.side,
      amount: add(existing?.amount ?? '0', value)!,
    });
  }
  // A zero-net group is retained: an explicitly present group is not an absent one.
  return [...merged.values()].sort((a, b) => order(a.account, b.account) || order(a.side, b.side));
}

const taxFields = ['code', 'base', 'tax', 'deductible', 'period'] as const;
type TaxField = (typeof taxFields)[number];
type TaxRow = Record<TaxField, string | null> & { unknown: TaxField[] };
function taxes(entries: readonly ComparisonTax[]): TaxRow[] {
  return entries
    .map((entry) => {
      const row = {
        code: entry.code || null,
        base: amount(entry.base),
        tax: amount(entry.tax),
        deductible: amount(entry.deductible),
        period: entry.period ?? null,
      };
      return {
        ...row,
        unknown: taxFields.filter((field) =>
          field === 'period' ? entry.period === undefined : row[field] === null,
        ),
      };
    })
    .sort((a, b) => order(JSON.stringify(a), JSON.stringify(b)));
}

/** Perfect matching preserves duplicate taxes. Unknown fields are wildcards only for the
 * known-field comparison; a separate evidence finding always keeps the gate closed. */
function sameTaxes(source: TaxRow[], engine: TaxRow[]): boolean {
  if (source.length !== engine.length) return false;
  if (!source.length) return true;
  // Complete taxes and filed taxes normally share one evidence shape per side. Compare
  // counted tuples directly so thousands of identical entries do not need augmenting paths.
  const uniform = (rows: TaxRow[]) =>
    rows.every((row) => JSON.stringify(row.unknown) === JSON.stringify(rows[0]!.unknown));
  if (uniform(source) && uniform(engine)) {
    const fields = taxFields.filter(
      (field) => !source[0]!.unknown.includes(field) && !engine[0]!.unknown.includes(field),
    );
    const keys = (rows: TaxRow[]) =>
      rows.map((row) => JSON.stringify(fields.map((field) => row[field]))).sort(order);
    return JSON.stringify(keys(source)) === JSON.stringify(keys(engine));
  }
  const matched = new Map<number, number>();
  const visit = (index: number, seen: Set<number>): boolean => {
    const a = source[index]!;
    for (let j = 0; j < engine.length; j++) {
      const b = engine[j]!;
      if (
        seen.has(j) ||
        !taxFields.every(
          (field) =>
            a.unknown.includes(field) || b.unknown.includes(field) || a[field] === b[field],
        )
      )
        continue;
      seen.add(j);
      const previous = matched.get(j);
      if (previous === undefined || visit(previous, seen)) {
        matched.set(j, index);
        return true;
      }
    }
    return false;
  };
  return source.every((_, index) => visit(index, new Set()));
}

function sourceTaxes(entry: SourceJournalTransaction) {
  const filed = entry.transaction.lines.flatMap((line, lineIndex) =>
    (line.tax ?? []).map((tax, taxIndex) => ({
      filed: { line: lineIndex, tax: taxIndex },
      facts: { code: tax.code, base: tax.base, tax: tax.amount } as ComparisonTax,
    })),
  );
  const coordinates = new Map(filed.map((tax, index) => [JSON.stringify(tax.filed), index]));
  const supplements = new Map<number, TaxSupplement[]>();
  let contradiction = false;
  for (const [position, supplement] of (entry.taxEntries ?? []).entries()) {
    const target = supplement.filed
      ? coordinates.get(JSON.stringify({ line: supplement.filed.line, tax: supplement.filed.tax }))
      : position;
    if (target === undefined || !filed[target]) {
      contradiction = true;
      continue;
    }
    const linked = supplements.get(target) ?? [];
    linked.push(supplement);
    supplements.set(target, linked);
  }
  const augmented = filed.map(({ facts }, index) => {
    const linked = supplements.get(index);
    if (!linked) return facts;
    if (linked.length !== 1) {
      contradiction = true;
      return facts;
    }
    const supplement = linked[0]!;
    const conflicts = (['code', 'base', 'tax'] as const).some((field) => {
      if (supplement[field] === undefined) return false;
      const asserted = field === 'code' ? supplement[field] || null : amount(supplement[field]);
      const actual = field === 'code' ? facts[field] || null : amount(facts[field]);
      return asserted === null || actual === null || asserted !== actual;
    });
    if (conflicts) {
      contradiction = true;
      return facts;
    }
    // Filed facts remain authoritative, including missing facts. Evidence only augments
    // deductible and period; contradictory evidence cannot establish either one.
    return { ...facts, deductible: supplement.deductible, period: supplement.period };
  });
  return {
    rows: taxes(augmented),
    contradiction,
    filed: filed.map((tax) => ({ ...tax.filed, ...taxes([tax.facts])[0]! })),
    supplement: (entry.taxEntries ?? []).map((tax, position) => ({
      filed: tax.filed ?? filed[position]?.filed ?? null,
      ...taxes([tax])[0]!,
    })),
  };
}

export function compareJournals(
  sourceTransactions: readonly SourceJournalTransaction[],
  engineEntries: readonly EngineJournalEntry[],
  mapping: AccountMapping,
): Difference[] {
  const source = new Map<string, SourceJournalTransaction>();
  const engine = new Map<string, EngineJournalEntry>();
  const entryIds = new Set<string>();
  for (const entry of sourceTransactions) {
    const subject = migrationSubject(entry.source, entry.reference);
    if (source.has(subject))
      fail('COMPARISON_REFERENCE_DUPLICATE', 'Referința sursă nu identifică o singură notă.');
    source.set(subject, entry);
  }
  for (const entry of engineEntries) {
    if (!entry.subject || !entry.id || !isLocalDate(entry.date))
      fail('COMPARISON_ENGINE_ENTRY', 'Identitatea sau data notei motorului lipsește.');
    if (engine.has(entry.subject) || entryIds.has(entry.id))
      fail('COMPARISON_REFERENCE_DUPLICATE', 'Subiectul motorului nu identifică o singură notă.');
    entryIds.add(entry.id);
    engine.set(entry.subject, entry);
  }
  const differences: Difference[] = [];
  for (const subject of [...new Set([...source.keys(), ...engine.keys()])].sort(order)) {
    const a = source.get(subject);
    const b = engine.get(subject);
    const period = a ? transactionPeriod(a.transaction) : b!.date.slice(0, 7);
    const locator = { subject };
    const sourceTax = a ? sourceTaxes(a) : null;
    if (sourceTax?.contradiction)
      differences.push(
        difference({
          kind: 'source-tax-supplement',
          period,
          locator,
          accounts: a!.transaction.lines.flatMap((line) =>
            line.account ? [mapping(line.account) ?? line.account] : [],
          ),
          taxCodes: sourceTax.rows.flatMap((tax) => tax.code ?? []),
          source: sourceTax.filed,
          engine: sourceTax.supplement,
        }),
      );
    if (!a || !b) {
      const accounts = a
        ? a.transaction.lines.flatMap((line) =>
            line.account ? [mapping(line.account) ?? line.account] : [],
          )
        : b!.lines.map((line) => line.account);
      differences.push(
        difference({
          kind: a ? 'journal-only-source' : 'journal-only-engine',
          period,
          locator,
          accounts,
          source: a
            ? {
                lines: a.transaction.lines.map((line) => ({
                  account: line.account ?? null,
                  side: line.side ?? null,
                  amount: amount(line.amount?.amount),
                })),
                taxes: sourceTax!.rows,
              }
            : null,
          engine: b ? { lines: mergeLines(b.lines), taxes: taxes(b.taxEntries) } : null,
        }),
      );
      continue;
    }
    if (period !== b.date.slice(0, 7))
      differences.push(
        difference({
          kind: 'journal-period',
          period,
          locator,
          source: period,
          engine: b.date.slice(0, 7),
          accounts: b.lines.map((line) => line.account),
        }),
      );
    const mapped: JournalLine[] = [];
    const unmapped = new Set<string>();
    for (const line of a.transaction.lines) {
      if (!line.account || !line.side || amount(line.amount?.amount) === null)
        fail('COMPARISON_LINE', 'O linie sursă nu are cont, sens sau sumă zecimală validă.');
      const account = mapping(line.account);
      if (!account) {
        unmapped.add(line.account);
        continue;
      }
      mapped.push({
        account,
        side: line.side === 'debit' ? 'D' : 'C',
        amount: line.amount!.amount!,
      });
    }
    for (const sourceAccount of [...unmapped].sort(order))
      differences.push(
        difference({
          kind: 'mapping-account',
          period,
          locator: { ...locator, sourceAccount },
          accounts: [sourceAccount],
          source: sourceAccount,
          engine: null,
        }),
      );
    const left = mergeLines(mapped);
    const right = mergeLines(b.lines);
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      const changed = [...left, ...right].filter(
        (line) =>
          !(left.includes(line) ? right : left).some(
            (other) =>
              line.account === other.account &&
              line.side === other.side &&
              line.amount === other.amount,
          ),
      );
      differences.push(
        difference({
          kind: 'journal-lines',
          period,
          locator,
          accounts: changed.map((line) => line.account),
          source: left,
          engine: right,
        }),
      );
    }
    const sourceTaxRows = sourceTax!.rows;
    const engineTax = taxes(b.taxEntries);
    const taxCodes = [...sourceTaxRows, ...engineTax].flatMap((tax) => tax.code ?? []);
    const accounts = [...left, ...right].map((line) => line.account);
    if ([...sourceTaxRows, ...engineTax].some((tax) => tax.unknown.length))
      differences.push(
        difference({
          kind: 'journal-tax-evidence',
          period,
          locator,
          accounts,
          taxCodes,
          source: sourceTaxRows,
          engine: engineTax,
        }),
      );
    if (!sameTaxes(sourceTaxRows, engineTax))
      differences.push(
        difference({
          kind: 'journal-tax',
          period,
          locator,
          accounts,
          taxCodes,
          source: sourceTaxRows,
          engine: engineTax,
        }),
      );
  }
  return differences;
}
