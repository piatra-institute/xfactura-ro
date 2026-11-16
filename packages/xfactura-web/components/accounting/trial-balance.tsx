'use client';

import { useState } from 'react';
import { SectionLink } from './navigation';
import { formatAmount } from './presentation';
import { monthDays, State, syntheticOf, type Pair } from './register-common';
import { useAccountingData } from './use-data';
import { useWorkspace } from './workspace';

type Columns = { opening: Pair; previous: Pair; current: Pair; total: Pair; closing: Pair };
type TrialBalanceData = {
  from: string;
  to: string;
  rows: ({ account: string; name: string } & Columns)[];
  totals: Columns;
};

const columns = ['opening', 'previous', 'current', 'total', 'closing'] as const;
const headings = {
  opening: 'Sold inițial',
  previous: 'Rulaje precedente',
  current: 'Rulaje curente',
  total: 'Total sume',
  closing: 'Sold final',
} as const;

/** A row's ten amounts; on the phone only the closing balance shows until the row is opened. */
function Amounts({ values }: { values: Columns }) {
  return columns.flatMap((column) => {
    const extra = column === 'closing' ? undefined : 'acc-trial-extra';
    return [
      <td key={`${column}D`} className={extra} data-label={`${headings[column]} · Debit`}>
        {formatAmount(values[column].debit)}
      </td>,
      <td key={`${column}C`} className={extra} data-label={`${headings[column]} · Credit`}>
        {formatAmount(values[column].credit)}
      </td>,
    ];
  });
}

function ColumnsToggle({
  open,
  name,
  toggle,
}: {
  open: boolean;
  name: string;
  toggle: () => void;
}) {
  const label = open ? 'Mai puține coloane' : 'Toate coloanele';
  return (
    <button
      className="acc-secondary acc-trial-toggle"
      aria-expanded={open}
      aria-label={`${label} pentru ${name}`}
      onClick={toggle}
    >
      {label}
    </button>
  );
}

export default function TrialBalance({ month }: { month: string }) {
  const { year } = useWorkspace();
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const { from, to } = monthDays(month, year);
  const read = useAccountingData<TrialBalanceData>(
    'ledger.trialBalance',
    { financialYearId: year?.id, from, to },
    Boolean(year),
  );
  const balance = read.data;
  const flip = (key: string) => setOpened((previous) => ({ ...previous, [key]: !previous[key] }));
  return (
    <section>
      <h3>Balanța de verificare</h3>
      <State
        loading={read.loading}
        error={read.error}
        empty={!!balance && balance.rows.length === 0}
      >
        Nu există înregistrări până la sfârșitul lunii alese.
      </State>
      {balance && balance.rows.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table acc-trial-table">
            <caption>
              Sume în RON, de la {balance.from} la {balance.to}
            </caption>
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>
                  Cont
                </th>
                {columns.map((column) => (
                  <th key={column} scope="colgroup" colSpan={2}>
                    {headings[column]}
                  </th>
                ))}
              </tr>
              <tr>
                {columns.flatMap((column) => [
                  <th key={`${column}D`} scope="col">
                    Debit
                  </th>,
                  <th key={`${column}C`} scope="col">
                    Credit
                  </th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {balance.rows.map((row) => (
                <tr key={row.account} data-open={opened[row.account] ? 'true' : undefined}>
                  <td className="acc-text" data-label="Cont">
                    <SectionLink
                      section="registers"
                      filters={{ register: 'fisa', registerAccount: syntheticOf(row.account) }}
                    >
                      {row.account} {row.name}
                    </SectionLink>
                    <ColumnsToggle
                      open={Boolean(opened[row.account])}
                      name={`contul ${row.account}`}
                      toggle={() => flip(row.account)}
                    />
                  </td>
                  <Amounts values={row} />
                </tr>
              ))}
              <tr data-open={opened[''] ? 'true' : undefined}>
                <th scope="row" className="acc-text" data-label="Cont">
                  Total
                  <ColumnsToggle open={Boolean(opened[''])} name="total" toggle={() => flip('')} />
                </th>
                <Amounts values={balance.totals} />
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
