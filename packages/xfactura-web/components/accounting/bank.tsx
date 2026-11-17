'use client';

import { amountField, field } from './api';
import { DateField } from './ui';
import { useList, useWorkspace } from './workspace';
import { formatMoney } from './format';

type TreasuryAccount = {
  id: string;
  kind: string;
  name: string;
  iban: string | null;
  currency: string;
  ledgerAccount: string;
};
type Movement = {
  id: string;
  treasuryAccountId: string;
  bookingDate: string;
  /** Null for one person's pay, to a reader who may not read pay (`Plată salarii`). */
  amount: string | null;
  currency: string;
  reference: string | null;
  counterparty: string | null;
  settled: boolean;
};
type Position = {
  id: string;
  kind: string;
  party: string | null;
  document: string | null;
  currency: string;
  balanceCurrency: string;
};

export default function Bank() {
  const { can, invoke, act } = useWorkspace();
  const { data: accounts } = useList<TreasuryAccount>('treasury.accounts', {});
  const { data: movements } = useList<Movement>('bank.movements', {});
  const { data: positions } = useList<Position>('openItems.list', {});
  const unsettled = (movements ?? []).filter((movement) => !movement.settled);
  return (
    <>
      <div className="acc-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Cont</th>
              <th scope="col">IBAN</th>
              <th scope="col">Monedă</th>
              <th scope="col">Cont contabil</th>
            </tr>
          </thead>
          <tbody>
            {(accounts ?? []).map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>{account.iban ?? '—'}</td>
                <td>{account.currency}</td>
                <td>{account.ledgerAccount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can('treasury.createAccount') ? (
        <details className="acc-disclosure">
          <summary>Adaugă un cont bancar sau o casă</summary>
          <form
            className="acc-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const iban = field(data, 'iban');
              void act(
                () =>
                  invoke('treasury.createAccount', {
                    kind: iban ? 'bank' : 'cash',
                    name: field(data, 'name'),
                    ...(iban ? { iban } : {}),
                    currency: field(data, 'currency'),
                    ledgerAccount: field(data, 'ledgerAccount'),
                    openedOn: field(data, 'openedOn'),
                  }),
                'Contul a fost configurat.',
              );
            }}
          >
            <div className="acc-form-grid">
              <label>
                Denumire
                <input name="name" required />
              </label>
              <label>
                IBAN (gol pentru casă)
                <input name="iban" />
              </label>
              <label>
                Monedă
                <input name="currency" defaultValue="RON" pattern="[A-Z]{3}" required />
              </label>
              <label>
                Cont contabil
                <input name="ledgerAccount" defaultValue="5121" required />
              </label>
              <DateField label="Deschis la" name="openedOn" isRequired />
            </div>
            <button>Configurează contul</button>
          </form>
        </details>
      ) : null}
      <h2>Mișcări neexplicate</h2>
      {movements && unsettled.length === 0 ? (
        <p className="acc-empty">Toate mișcările importate sunt explicate.</p>
      ) : null}
      {unsettled.map((movement) => {
        const received = !(movement.amount ?? '-').startsWith('-');
        const candidates = (positions ?? []).filter(
          (position) =>
            position.currency === movement.currency &&
            (received
              ? ['receivable', 'unapplied.payment'].includes(position.kind)
              : ['payable', 'unapplied.receipt'].includes(position.kind)),
        );
        return (
          <article key={movement.id} className="acc-review">
            <div className="acc-review-heading">
              <div>
                <h3>{received ? 'Încasare' : 'Plată'}</h3>
                <p>
                  {movement.bookingDate} · {movement.counterparty ?? movement.reference}
                </p>
              </div>
              <strong>
                {movement.amount === null
                  ? 'Sumă ascunsă (date salariale)'
                  : formatMoney(movement.amount, movement.currency)}
              </strong>
            </div>
            {can('bank.settle.propose') ? (
              <form
                className="acc-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const openItem = field(data, 'openItem');
                  const account = field(data, 'account');
                  void act(
                    () =>
                      invoke('bank.settle.propose', {
                        movementId: movement.id,
                        allocations: openItem
                          ? [{ openItem, amount: amountField(data, 'allocation') }]
                          : [],
                        lines: account
                          ? [{ account, amount: amountField(data, 'lineAmount') }]
                          : [],
                      }),
                    'Explicația a fost pregătită pentru verificare.',
                  );
                }}
              >
                <div className="acc-form-grid">
                  <label>
                    Factură decontată
                    <select name="openItem" defaultValue="">
                      <option value="">Niciuna</option>
                      {candidates.map((position) => (
                        <option key={position.id} value={position.id}>
                          {position.party} · {position.document ?? 'fără document'} ·{' '}
                          {formatMoney(
                            position.balanceCurrency.replace('-', ''),
                            position.currency,
                          )}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Sumă decontată
                    <input name="allocation" inputMode="decimal" />
                  </label>
                  <label>
                    Alt cont (comision, dobândă, transfer)
                    <input name="account" placeholder="627" />
                  </label>
                  <label>
                    Sumă pe cont
                    <input name="lineAmount" inputMode="decimal" />
                  </label>
                </div>
                <button>Pregătește explicația</button>
              </form>
            ) : null}
          </article>
        );
      })}
    </>
  );
}
