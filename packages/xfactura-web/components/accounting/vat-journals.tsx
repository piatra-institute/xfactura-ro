'use client';

import { useEffect, useId } from 'react';
import { useAccountingNavigation } from './navigation';
import { EntryLink, State, useJournalBetween, type JournalEntry } from './register-common';
import { useAccountingData } from './use-data';
import { useWorkspace, type Year } from './workspace';
import { formatAmount, formatMonth } from './format';

type VatRow = {
  entry: number;
  date: string;
  taxPeriod: string;
  exigibility: string | null;
  document: string | null;
  documentDate: string | null;
  counterparty: string | null;
  code: string;
  base: string;
  vat: string;
  deductible: string;
};
type VatJournalData = {
  rows: VatRow[];
  totals: { code: string; base: string; vat: string; deductible: string }[];
};
type Fact = {
  id: string;
  axis: string;
  value: string;
  effectiveFrom: string;
  supersedesId: string | null;
  createdAt: string;
};

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The company's facts as the engine applies them: none another supersedes, in its order. */
function factsInForce(facts: Fact[]) {
  const superseded = new Set(facts.map((fact) => fact.supersedesId));
  return facts
    .filter((fact) => !superseded.has(fact.id))
    .sort(
      (a, b) =>
        order(a.effectiveFrom, b.effectiveFrom) ||
        order(a.createdAt, b.createdAt) ||
        order(a.id, b.id),
    );
}

/** The VAT period the engine gives a day (`vatPeriodOf`): its month, or its quarter when the
 * company's `vat.period` fact in force on that day says quarterly. */
function vatPeriodAt(facts: Fact[], day: string) {
  let value: string | null = null;
  for (const fact of facts)
    if (fact.axis === 'vat.period' && fact.effectiveFrom <= day) value = fact.value;
  if (value !== 'quarterly') return day.slice(0, 7);
  return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
}

/** The VAT periods of the financial year in order: those of its months' first days, and of each
 * day a `vat.period` fact starts on. */
function periodsOf(facts: Fact[], year: Year) {
  const days: string[] = [];
  for (let month = year.from.slice(0, 7); month <= year.to.slice(0, 7);) {
    days.push(month === year.from.slice(0, 7) ? year.from : `${month}-01`);
    const [y, m] = month.split('-').map(Number);
    month = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`;
  }
  for (const fact of facts)
    if (
      fact.axis === 'vat.period' &&
      year.from <= fact.effectiveFrom &&
      fact.effectiveFrom <= year.to
    )
      days.push(fact.effectiveFrom);
  return [...new Set(days.sort().map((day) => vatPeriodAt(facts, day)))];
}

/** The first month of a period, held to the financial year. */
function firstMonthOf(period: string, year: Year) {
  const month = period.includes('Q')
    ? `${period.slice(0, 4)}-${String(Number(period.slice(-1)) * 3 - 2).padStart(2, '0')}`
    : period;
  const first = year.from.slice(0, 7);
  return month < first ? first : month;
}

const periodLabel = (period: string) =>
  period.includes('Q')
    ? `Trimestrul ${period.slice(-1)} ${period.slice(0, 4)}`
    : formatMonth(period);

/** A row's entry, found by its number and date: `vat.journal` gives no entry id. */
type Match = { entry: JournalEntry } | { reason: string } | null;

export default function VatJournals({ month }: { month: string }) {
  const { can, year } = useWorkspace();
  const { params, filter, replace } = useAccountingNavigation();
  const facts = useAccountingData<Fact[]>('profile.read', {}, can('profile.read'), true);
  const inForce = facts.data ? factsInForce(facts.data) : null;
  const periods = inForce && year ? periodsOf(inForce, year) : [];
  const requested = params.get('vatPeriod');
  const monthStart = year && `${month}-01` < year.from ? year.from : `${month}-01`;
  const period =
    requested && periods.includes(requested)
      ? requested
      : inForce
        ? vatPeriodAt(inForce, monthStart)
        : '';
  useEffect(() => {
    if (period && requested !== period) replace({ vatPeriod: period });
  }, [period, requested]);

  const ready = Boolean(period);
  const sales = useAccountingData<VatJournalData>(
    'vat.journal',
    { direction: 'output', from: period, to: period },
    ready,
  );
  const purchases = useAccountingData<VatJournalData>(
    'vat.journal',
    { direction: 'input', from: period, to: period },
    ready,
  );
  const dates = [...(sales.data?.rows ?? []), ...(purchases.data?.rows ?? [])]
    .map((row) => row.date)
    .sort();
  const journal = useJournalBetween(
    dates[0] ?? '',
    dates.at(-1) ?? '',
    can('ledger.journal') && dates.length > 0,
  );
  const matchOf = (row: VatRow): Match => {
    if (!can('ledger.journal') || journal.loading || journal.error) return null;
    const numbered = journal.entries.filter(
      (entry) => entry.date === row.date && entry.number === row.entry,
    );
    // Numbers repeat across journal classes (a memo entry beside a general one); the document the
    // engine names for both the row and the entry can still tell them apart.
    const documented = numbered.filter(
      (entry) => row.document !== null && entry.document?.number === row.document,
    );
    const matches = numbered.length > 1 && documented.length === 1 ? documented : numbered;
    if (matches.length === 1) return { entry: matches[0]! };
    if (matches.length > 1)
      return {
        reason: `${matches.length} înregistrări din ${row.date} au numărul ${row.entry}; jurnalul de TVA nu spune care este a acestui rând.`,
      };
    return {
      reason: journal.complete
        ? `Nicio înregistrare din ${row.date} nu are numărul ${row.entry} în registrul jurnal.`
        : 'Registrul jurnal al acestor zile este prea lung pentru a găsi înregistrarea.',
    };
  };

  return (
    <section>
      <h2>Jurnale de TVA</h2>
      {!can('profile.read') ? (
        <p className="acc-empty">
          Rolul dumneavoastră nu poate citi perioada fiscală de TVA a companiei, deci nu se știe ce
          perioade au jurnalele de TVA.
        </p>
      ) : (
        <State loading={facts.loading} error={facts.error} />
      )}
      {periods.length > 0 ? (
        <div className="acc-work-filters">
          <label>
            Perioada fiscală de TVA
            <select
              value={period}
              onChange={(event) => {
                if (year)
                  filter({
                    vatPeriod: event.target.value,
                    registerMonth: firstMonthOf(event.target.value, year),
                  });
              }}
            >
              {periods.map((choice) => (
                <option key={choice} value={choice}>
                  {periodLabel(choice)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {ready && !can('ledger.journal') ? (
        <p className="acc-hint">
          Rolul dumneavoastră nu poate citi registrul jurnal, deci rândurile nu deschid
          înregistrările.
        </p>
      ) : null}
      {journal.error ? (
        <p role="alert" className="acc-error">
          Rândurile nu deschid înregistrările: {journal.error}
        </p>
      ) : null}
      {ready ? (
        <>
          <VatJournal title="Jurnal de vânzări" input={false} read={sales} matchOf={matchOf} />
          <VatJournal title="Jurnal de cumpărări" input read={purchases} matchOf={matchOf} />
        </>
      ) : null}
    </section>
  );
}

function VatJournal({
  title,
  input,
  read,
  matchOf,
}: {
  title: string;
  input: boolean;
  read: { data: VatJournalData | null; loading: boolean; error: string };
  matchOf: (row: VatRow) => Match;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{title}</h3>
      <State
        loading={read.loading}
        error={read.error}
        empty={!!read.data && read.data.rows.length === 0}
      >
        Nicio operațiune în perioada aleasă.
      </State>
      {read.data && read.data.rows.length > 0 ? (
        <VatRows rows={read.data.rows} input={input} matchOf={matchOf} />
      ) : null}
      {read.data && read.data.totals.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table">
            <caption>Totaluri pe coduri, în RON</caption>
            <thead>
              <tr>
                <th scope="col">Cod</th>
                <th scope="col">Bază</th>
                <th scope="col">TVA</th>
                {input ? <th scope="col">TVA deductibilă</th> : null}
              </tr>
            </thead>
            <tbody>
              {read.data.totals.map((total) => (
                <tr key={total.code}>
                  <td className="acc-text" data-label="Cod">
                    {total.code}
                  </td>
                  <td data-label="Bază">{formatAmount(total.base)}</td>
                  <td data-label="TVA">{formatAmount(total.vat)}</td>
                  {input ? (
                    <td data-label="TVA deductibilă">{formatAmount(total.deductible)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function VatRows({
  rows,
  input,
  matchOf,
}: {
  rows: VatRow[];
  input: boolean;
  matchOf: (row: VatRow) => Match;
}) {
  return (
    <div className="acc-table-scroll">
      <table className="acc-register-table acc-vat-table">
        <caption>Sume în RON</caption>
        <thead>
          <tr>
            <th scope="col" className="acc-text">
              Înregistrare
            </th>
            <th scope="col" className="acc-text">
              Data înregistrării
            </th>
            <th scope="col" className="acc-text">
              Document
            </th>
            <th scope="col" className="acc-text">
              Data documentului
            </th>
            <th scope="col" className="acc-text">
              Partener
            </th>
            <th scope="col" className="acc-text">
              Cod
            </th>
            <th scope="col">Bază</th>
            <th scope="col">TVA</th>
            {input ? <th scope="col">TVA deductibilă</th> : null}
            <th scope="col" className="acc-text">
              Exigibilitate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const match = matchOf(row);
            return (
              <tr key={`${row.date}-${row.entry}-${row.code}-${index}`}>
                <td className="acc-text" data-label="Înregistrare">
                  {match && 'entry' in match ? (
                    <EntryLink
                      entry={match.entry}
                      label={`Deschide înregistrarea ${row.entry} din ${row.date}`}
                    >
                      {row.entry}
                    </EntryLink>
                  ) : (
                    <span>
                      {row.entry}
                      {match ? <span className="acc-cell-note">{match.reason}</span> : null}
                    </span>
                  )}
                </td>
                <td className="acc-text" data-label="Data înregistrării">
                  {row.date}
                </td>
                <td className="acc-text" data-label="Document">
                  {row.document ?? ''}
                </td>
                <td className="acc-text" data-label="Data documentului">
                  {row.documentDate ?? ''}
                </td>
                <td className="acc-text" data-label="Partener">
                  {row.counterparty ?? ''}
                </td>
                <td className="acc-text" data-label="Cod">
                  {row.code}
                </td>
                <td data-label="Bază">{formatAmount(row.base)}</td>
                <td data-label="TVA">{formatAmount(row.vat)}</td>
                {input ? (
                  <td data-label="TVA deductibilă">{formatAmount(row.deductible)}</td>
                ) : null}
                <td className="acc-text" data-label="Exigibilitate">
                  {row.exigibility ?? 'Neexigibilă încă (TVA la încasare)'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
