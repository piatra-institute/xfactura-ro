'use client';

import { formatMoney } from './api';
import { useAccountingNavigation } from './navigation';
import { formatAmount, formatQuantity, useOpenedHeading } from './presentation';
import { EntryLink, monthDays, State } from './register-common';
import { useAccountingData } from './use-data';
import { useWorkspace } from './workspace';

type StockRegister = {
  positions: {
    itemId: string;
    code: string;
    name: string;
    unit: string;
    warehouseId: string;
    warehouse: string;
    account: string;
    quantity: string;
    value: string;
  }[];
  accounts: { account: string; register: string; ledger: string; outside: string }[];
};
type StockCard = {
  item: { code: string; name: string; unit: string; account: string };
  warehouse: { code: string; name: string; keeper: string };
  opening: { quantity: string; value: string };
  moves: {
    date: string;
    entryId: string;
    number: number;
    description: string;
    quantity: string;
    value: string;
    balance: { quantity: string; value: string };
  }[];
  closing: { quantity: string; value: string };
};

/** The stock register at the end of the chosen month, and one item's card for that month. */
export default function Stock({ month }: { month: string }) {
  const { can, year } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const { from, to } = monthDays(month, year);
  const read = useAccountingData<StockRegister>('stock.register', { date: to });
  const itemId = params.get('stockItem') ?? '';
  const warehouseId = params.get('stockWarehouse') ?? '';
  const positions = read.data?.positions ?? [];
  const choose = (item: string | null, warehouse: string | null) =>
    filter({ stockItem: item, stockWarehouse: warehouse });
  return (
    <section>
      <h3>Stocuri</h3>
      <State loading={read.loading} error={read.error} empty={!!read.data && !positions.length}>
        Nu există poziții de stoc la {to}.
      </State>
      {positions.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table">
            <caption>Registrul stocurilor la {to}, valori în RON</caption>
            <thead>
              <tr>
                <th scope="col">Articol</th>
                <th scope="col" className="acc-text">
                  Gestiune
                </th>
                <th scope="col" className="acc-text">
                  Cont
                </th>
                <th scope="col">Cantitate</th>
                <th scope="col">Valoare</th>
                <th scope="col" className="acc-text">
                  Fișa de magazie
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={`${position.itemId}|${position.warehouseId}|${position.account}`}>
                  <td className="acc-text" data-label="Articol">
                    {position.code} {position.name}
                  </td>
                  <td className="acc-text" data-label="Gestiune">
                    {position.warehouse}
                  </td>
                  <td className="acc-text" data-label="Cont">
                    {position.account}
                  </td>
                  <td data-label="Cantitate">
                    {formatQuantity(position.quantity)} {position.unit}
                  </td>
                  <td data-label="Valoare">{formatAmount(position.value)}</td>
                  <td className="acc-text" data-label="Fișa de magazie">
                    <button
                      className="acc-secondary"
                      aria-label={`Deschide fișa de magazie pentru ${position.code} ${position.name}, ${position.warehouse}`}
                      onClick={() => choose(position.itemId, position.warehouseId)}
                    >
                      Deschide fișa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {read.data && read.data.accounts.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table">
            <caption>Registrul față de contabilitate, în RON</caption>
            <thead>
              <tr>
                <th scope="col">Cont</th>
                <th scope="col">Registru</th>
                <th scope="col">Contabilitate</th>
                <th scope="col">În afara registrului</th>
              </tr>
            </thead>
            <tbody>
              {read.data.accounts.map((row) => (
                <tr key={row.account}>
                  <td className="acc-text" data-label="Cont">
                    {row.account}
                  </td>
                  <td data-label="Registru">{formatAmount(row.register)}</td>
                  <td data-label="Contabilitate">{formatAmount(row.ledger)}</td>
                  <td data-label="În afara registrului">{formatAmount(row.outside)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {itemId && warehouseId && can('stock.card') ? (
        <Card itemId={itemId} warehouseId={warehouseId} from={from} to={to} />
      ) : null}
    </section>
  );
}

function Card({
  itemId,
  warehouseId,
  from,
  to,
}: {
  itemId: string;
  warehouseId: string;
  from: string;
  to: string;
}) {
  const { filter } = useAccountingNavigation();
  const card = useAccountingData<StockCard>('stock.card', { itemId, warehouseId, from, to });
  const heading = useOpenedHeading(Boolean(card.data));
  const data = card.data;
  return (
    <section>
      <h4 ref={heading} tabIndex={-1} className="acc-opened-heading">
        Fișa de magazie{data ? ` · ${data.item.code} ${data.item.name}` : ''}
      </h4>
      <State loading={card.loading} error={card.error} />
      {data ? (
        <>
          <dl className="acc-review-meta">
            <div>
              <dt>Gestiune</dt>
              <dd>
                {data.warehouse.code} {data.warehouse.name}
              </dd>
            </div>
            <div>
              <dt>Gestionar</dt>
              <dd>{data.warehouse.keeper}</dd>
            </div>
            <div>
              <dt>Cont</dt>
              <dd>{data.item.account}</dd>
            </div>
            <div>
              <dt>Sold inițial</dt>
              <dd>
                {formatQuantity(data.opening.quantity)} {data.item.unit} ·{' '}
                {formatMoney(data.opening.value)}
              </dd>
            </div>
            <div>
              <dt>Sold final</dt>
              <dd>
                {formatQuantity(data.closing.quantity)} {data.item.unit} ·{' '}
                {formatMoney(data.closing.value)}
              </dd>
            </div>
          </dl>
          {data.moves.length === 0 ? (
            <p className="acc-empty">
              Nu există mișcări între {from} și {to}.
            </p>
          ) : (
            <div className="acc-table-scroll">
              <table className="acc-register-table">
                <caption>
                  Mișcări între {from} și {to}; cantități în {data.item.unit}, valori în RON
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col" className="acc-text">
                      Înregistrare
                    </th>
                    <th scope="col" className="acc-text">
                      Descriere
                    </th>
                    <th scope="col">Cantitate</th>
                    <th scope="col">Valoare</th>
                    <th scope="col">Sold cantitate</th>
                    <th scope="col">Sold valoare</th>
                  </tr>
                </thead>
                <tbody>
                  {data.moves.map((move, index) => (
                    <tr key={`${move.entryId}-${index}`}>
                      <td className="acc-text" data-label="Data">
                        {move.date}
                      </td>
                      <td className="acc-text" data-label="Înregistrare">
                        <EntryLink
                          entry={{ id: move.entryId, date: move.date }}
                          label={`Deschide înregistrarea ${move.number} din ${move.date}`}
                        >
                          {move.number}
                        </EntryLink>
                      </td>
                      <td className="acc-text" data-label="Descriere">
                        {move.description}
                      </td>
                      <td data-label="Cantitate">{formatQuantity(move.quantity)}</td>
                      <td data-label="Valoare">{formatAmount(move.value)}</td>
                      <td data-label="Sold cantitate">{formatQuantity(move.balance.quantity)}</td>
                      <td data-label="Sold valoare">{formatAmount(move.balance.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      <button
        className="acc-secondary"
        onClick={() => filter({ stockItem: null, stockWarehouse: null })}
      >
        Închide fișa de magazie
      </button>
    </section>
  );
}
