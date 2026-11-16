'use client';

import { formatMoney } from './api';
import { SectionLink, useAccountingNavigation } from './navigation';
import { formatAmount } from './presentation';
import { State, type Pair } from './register-common';
import { useAccountingData } from './use-data';

type Sheet = {
  account: string;
  name: string;
  opening: Pair;
  debit: { correspondent: string; amount: string }[];
  credit: { correspondent: string; amount: string }[];
  turnover: Pair;
  closing: Pair;
};

/** Fișa contului (cartea mare) of one synthetic account for a month, as the engine gives it. */
export default function AccountSheet({ month }: { month: string }) {
  const { params, filter } = useAccountingNavigation();
  const account = params.get('registerAccount') ?? '';
  // Every sheet of the month: the accounts that have one are the choices, so none opens empty.
  const read = useAccountingData<Sheet[]>('ledger.generalLedger', { month }, true, true);
  const sheets = read.data ?? [];
  const sheet = sheets.find((row) => row.account === account);
  return (
    <section>
      <h3>Fișa contului</h3>
      <State loading={read.loading} error={read.error} empty={!!read.data && !sheets.length}>
        Nu există înregistrări până la sfârșitul lunii alese.
      </State>
      {sheets.length ? (
        <div className="acc-work-filters">
          <label>
            Cont
            <select
              value={sheet ? account : ''}
              onChange={(event) => filter({ registerAccount: event.target.value || null })}
            >
              <option value="">Alegeți contul</option>
              {sheets.map((row) => (
                <option key={row.account} value={row.account}>
                  {row.account} {row.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {sheets.length > 0 && !sheet ? (
        <p className="acc-empty">
          {account
            ? `Contul ${account} nu are înregistrări până la sfârșitul lunii alese.`
            : 'Alegeți un cont pentru fișa lui.'}
        </p>
      ) : null}
      {sheet ? (
        <>
          <h4>
            {sheet.account} {sheet.name}
          </h4>
          <dl className="acc-review-meta">
            <div>
              <dt>Sold inițial debit</dt>
              <dd>{formatMoney(sheet.opening.debit)}</dd>
            </div>
            <div>
              <dt>Sold inițial credit</dt>
              <dd>{formatMoney(sheet.opening.credit)}</dd>
            </div>
            <div>
              <dt>Rulaj debit</dt>
              <dd>{formatMoney(sheet.turnover.debit)}</dd>
            </div>
            <div>
              <dt>Rulaj credit</dt>
              <dd>{formatMoney(sheet.turnover.credit)}</dd>
            </div>
            <div>
              <dt>Sold final debit</dt>
              <dd>{formatMoney(sheet.closing.debit)}</dd>
            </div>
            <div>
              <dt>Sold final credit</dt>
              <dd>{formatMoney(sheet.closing.credit)}</dd>
            </div>
          </dl>
          {sheet.debit.length || sheet.credit.length ? (
            <div className="acc-table-scroll">
              <table className="acc-register-table">
                <caption>Rulajele lunii pe conturi corespondente, în RON</caption>
                <thead>
                  <tr>
                    <th scope="col">Cont corespondent</th>
                    <th scope="col">Debit</th>
                    <th scope="col">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.debit.map((row) => (
                    <tr key={`D${row.correspondent}`}>
                      <td className="acc-text" data-label="Cont corespondent">
                        {row.correspondent}
                      </td>
                      <td data-label="Debit">{formatAmount(row.amount)}</td>
                      <td data-label="Credit"></td>
                    </tr>
                  ))}
                  {sheet.credit.map((row) => (
                    <tr key={`C${row.correspondent}`}>
                      <td className="acc-text" data-label="Cont corespondent">
                        {row.correspondent}
                      </td>
                      <td data-label="Debit"></td>
                      <td data-label="Credit">{formatAmount(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="acc-empty">Contul nu are rulaje în luna aleasă.</p>
          )}
          <p className="acc-hint">
            Aceste sume nu deschid înregistrările din care provin: motorul nu le întoarce pentru
            fișa contului. Înregistrările lunii sunt în{' '}
            <SectionLink section="registers" filters={{ register: 'jurnal' }}>
              Registrul jurnal
            </SectionLink>
            .
          </p>
        </>
      ) : null}
    </section>
  );
}
