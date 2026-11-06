'use client';

import { useState } from 'react';
import { formatMoney } from './api';
import { useLoad, useWorkspace } from './workspace';

type Pair = { debit: string; credit: string };
type TrialBalance = {
  rows: {
    account: string;
    name: string;
    opening: Pair;
    previous: Pair;
    current: Pair;
    total: Pair;
    closing: Pair;
  }[];
  totals: { opening: Pair; previous: Pair; current: Pair; total: Pair; closing: Pair };
};
type Journal = {
  entries: {
    id: string;
    number: number;
    date: string;
    journalCode: string;
    description: string;
    /** A line's amount is null in a payment of one person's pay, to a reader who may not read
     * pay. */
    lines: { account: string; side: 'D' | 'C'; amount: string | null }[];
  }[];
};
type VatJournal = {
  rows: {
    entry: number;
    date: string;
    document: string | null;
    counterparty: string | null;
    code: string;
    base: string;
    vat: string;
  }[];
  totals: { code: string; base: string; vat: string; deductible: string }[];
};

const columns = ['opening', 'previous', 'current', 'total', 'closing'] as const;
const headings = {
  opening: 'Sold inițial',
  previous: 'Rulaje precedente',
  current: 'Rulaje curente',
  total: 'Total sume',
  closing: 'Sold final',
};

export default function Registers() {
  const { year } = useWorkspace();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const range = year ? { from: year.from, to: year.to } : null;
  const { data: balance } = useLoad<TrialBalance>(
    'ledger.trialBalance',
    { financialYearId: year?.id },
    Boolean(year),
  );
  const { data: journal } = useLoad<Journal>(
    'ledger.journal',
    { ...range, limit: 200 },
    Boolean(range),
  );
  const { data: sales } = useLoad<VatJournal>('vat.journal', {
    direction: 'output',
    from: month,
    to: month,
  });
  const { data: purchases } = useLoad<VatJournal>('vat.journal', {
    direction: 'input',
    from: month,
    to: month,
  });
  return (
    <>
      <div className="acc-section-heading">
        <h2>Balanța de verificare</h2>
        <p>{year ? `${year.from} – ${year.to}` : ''}</p>
      </div>
      <div className="acc-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Cont</th>
              {columns.map((column) => (
                <th key={column} scope="col" colSpan={2}>
                  {headings[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(balance?.rows ?? []).map((row) => (
              <tr key={row.account}>
                <td title={row.name}>{row.account}</td>
                {columns.flatMap((column) => [
                  <td key={`${column}D`}>{row[column].debit}</td>,
                  <td key={`${column}C`}>{row[column].credit}</td>,
                ])}
              </tr>
            ))}
            {balance ? (
              <tr>
                <th scope="row">Total</th>
                {columns.flatMap((column) => [
                  <td key={`${column}D`}>{balance.totals[column].debit}</td>,
                  <td key={`${column}C`}>{balance.totals[column].credit}</td>,
                ])}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <h2>Registrul-jurnal</h2>
      {journal && journal.entries.length === 0 ? (
        <p className="acc-empty">Nu există înregistrări în acest exercițiu.</p>
      ) : null}
      {(journal?.entries ?? []).map((entry) => (
        <details key={entry.id} className="acc-journal">
          <summary>
            {entry.number}. {entry.date} · {entry.journalCode} · {entry.description}
          </summary>
          <ul>
            {entry.lines.map((line, index) => (
              <li key={index}>
                {line.side === 'D' ? 'Debit' : 'Credit'} {line.account} ·{' '}
                {line.amount === null ? 'sumă ascunsă (date salariale)' : formatMoney(line.amount)}
              </li>
            ))}
          </ul>
        </details>
      ))}
      <div className="acc-section-heading">
        <h2>Jurnale de TVA</h2>
        <label>
          Luna
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
      </div>
      <p className="acc-hint">
        Registre de lucru din înregistrările fiscale; nu sunt declarații depuse.
      </p>
      {(
        [
          ['Jurnal de vânzări', sales],
          ['Jurnal de cumpărări', purchases],
        ] as const
      ).map(([title, register]) => (
        <section key={title}>
          <h3>{title}</h3>
          {register && register.rows.length === 0 ? (
            <p className="acc-empty">Nicio operațiune în această lună.</p>
          ) : null}
          {register?.totals.map((total) => (
            <p key={total.code}>
              {total.code}: bază {formatMoney(total.base)}, TVA {formatMoney(total.vat)}
            </p>
          ))}
        </section>
      ))}
    </>
  );
}
