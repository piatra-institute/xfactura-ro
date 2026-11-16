'use client';

import { formatAmount } from './presentation';
import { monthDays, State, type Pair } from './register-common';
import { useAccountingData } from './use-data';
import { useWorkspace } from './workspace';

type InventoryRow = {
  account: string;
  name: string;
  balance: Pair;
  items: { description: string; balance: Pair }[];
  inventoried: Pair;
  difference: Pair;
};

/** Registrul inventar at the end of the chosen month (or of the year, when it ends sooner). */
export default function Inventory({ month }: { month: string }) {
  const { year } = useWorkspace();
  const date = monthDays(month, year).to;
  const read = useAccountingData<InventoryRow[]>('ledger.inventoryRegister', { date }, true, true);
  return (
    <section>
      <h3>Registrul inventar</h3>
      <State
        loading={read.loading}
        error={read.error}
        empty={!!read.data && read.data.length === 0}
      >
        Nu există solduri la {date}.
      </State>
      {read.data && read.data.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table acc-inventory-table">
            <caption>Sume în RON, la {date}</caption>
            <thead>
              <tr>
                <th scope="col">Cont</th>
                <th scope="col">Sold debit</th>
                <th scope="col">Sold credit</th>
                <th scope="col" className="acc-text">
                  Elemente
                </th>
                <th scope="col">Valoare inventariată debit</th>
                <th scope="col">Valoare inventariată credit</th>
                <th scope="col">Diferență debit</th>
                <th scope="col">Diferență credit</th>
              </tr>
            </thead>
            <tbody>
              {read.data.map((row) => (
                <tr key={row.account}>
                  <td className="acc-text" data-label="Cont">
                    {row.account} {row.name}
                  </td>
                  <td data-label="Sold debit">{formatAmount(row.balance.debit)}</td>
                  <td data-label="Sold credit">{formatAmount(row.balance.credit)}</td>
                  <td className="acc-text acc-items" data-label="Elemente">
                    {row.items.length ? (
                      <ul className="acc-item-list">
                        {row.items.map((item, index) => (
                          <li key={index}>
                            {item.description}
                            <span className="acc-item-amounts">
                              debit {formatAmount(item.balance.debit)} · credit{' '}
                              {formatAmount(item.balance.credit)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td data-label="Valoare inventariată debit">
                    {formatAmount(row.inventoried.debit)}
                  </td>
                  <td data-label="Valoare inventariată credit">
                    {formatAmount(row.inventoried.credit)}
                  </td>
                  <td data-label="Diferență debit">{formatAmount(row.difference.debit)}</td>
                  <td data-label="Diferență credit">{formatAmount(row.difference.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
