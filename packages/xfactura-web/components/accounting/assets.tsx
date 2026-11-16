'use client';

import { formatMoney } from './api';
import { useAccountingNavigation } from './navigation';
import { formatAmount, useOpenedHeading } from './presentation';
import { State } from './register-common';
import { useAccountingData } from './use-data';

type Asset = {
  id: string;
  number: string;
  name: string;
  catalogCode: string;
  account: string;
  value: string;
  depreciated: string;
  remaining: string;
  lifeMonths: number;
  fiscalLifeMonths: number;
  commissionedOn: string;
  disposedOn: string | null;
  fiscal: { method: string; value: string; lifeMonths: number } | null;
};

/** The engine's fiscal depreciation methods (`fiscalMethods`), as the Fiscal Code names them. */
const fiscalMethods: Record<string, string> = {
  linear: 'Liniară',
  degressive: 'Degresivă',
  accelerated: 'Accelerată',
  superaccelerated: 'Superaccelerată',
  full_safety: 'Deducere integrală la punerea în funcțiune (protecția muncii)',
  full_medical: 'Deducere integrală la punerea în funcțiune (cabinete medicale)',
  full_low_value: 'Deducere integrală la punerea în funcțiune (valoare mică)',
  none: 'Nu se amortizează fiscal',
};

/** The fixed-asset register as `assets.list` gives it; one asset opens below the table. */
export default function Assets() {
  const { params, filter } = useAccountingNavigation();
  const read = useAccountingData<Asset[]>('assets.list', {}, true, true);
  const assetId = params.get('registerAsset') ?? '';
  const asset = read.data?.find((row) => row.id === assetId);
  const heading = useOpenedHeading(Boolean(asset));
  return (
    <section>
      <h3>Mijloace fixe</h3>
      <State
        loading={read.loading}
        error={read.error}
        empty={!!read.data && read.data.length === 0}
      >
        Nu există mijloace fixe înregistrate.
      </State>
      {read.data && read.data.length > 0 ? (
        <div className="acc-table-scroll">
          <table className="acc-register-table">
            <caption>Valori contabile în RON, la zi</caption>
            <thead>
              <tr>
                <th scope="col">Număr de inventar</th>
                <th scope="col" className="acc-text">
                  Denumire
                </th>
                <th scope="col" className="acc-text">
                  Cont
                </th>
                <th scope="col">Valoare</th>
                <th scope="col">Amortizare</th>
                <th scope="col">Valoare rămasă</th>
                <th scope="col" className="acc-text">
                  Punere în funcțiune
                </th>
                <th scope="col" className="acc-text">
                  Detalii
                </th>
              </tr>
            </thead>
            <tbody>
              {read.data.map((row) => (
                <tr key={row.id}>
                  <td className="acc-text" data-label="Număr de inventar">
                    {row.number}
                  </td>
                  <td className="acc-text" data-label="Denumire">
                    {row.name}
                  </td>
                  <td className="acc-text" data-label="Cont">
                    {row.account}
                  </td>
                  <td data-label="Valoare">{formatAmount(row.value)}</td>
                  <td data-label="Amortizare">{formatAmount(row.depreciated)}</td>
                  <td data-label="Valoare rămasă">{formatAmount(row.remaining)}</td>
                  <td className="acc-text" data-label="Punere în funcțiune">
                    {row.commissionedOn}
                  </td>
                  <td className="acc-text" data-label="Detalii">
                    <button
                      className="acc-secondary"
                      aria-label={`Deschide mijlocul fix ${row.number} ${row.name}`}
                      onClick={() => filter({ registerAsset: row.id })}
                    >
                      Deschide
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {assetId && read.data && !asset ? (
        <p className="acc-empty">Mijlocul fix ales nu mai apare în registru.</p>
      ) : null}
      {asset ? (
        <section>
          <h4 ref={heading} tabIndex={-1} className="acc-opened-heading">
            {asset.number} {asset.name}
          </h4>
          <dl className="acc-work-details">
            <div>
              <dt>Cod de clasificare</dt>
              <dd>{asset.catalogCode}</dd>
            </div>
            <div>
              <dt>Cont</dt>
              <dd>{asset.account}</dd>
            </div>
            <div>
              <dt>Valoare</dt>
              <dd>{formatMoney(asset.value)}</dd>
            </div>
            <div>
              <dt>Amortizare înregistrată</dt>
              <dd>{formatMoney(asset.depreciated)}</dd>
            </div>
            <div>
              <dt>Valoare rămasă</dt>
              <dd>{formatMoney(asset.remaining)}</dd>
            </div>
            <div>
              <dt>Durată contabilă</dt>
              <dd>{asset.lifeMonths} luni</dd>
            </div>
            <div>
              <dt>Durată normală de funcționare</dt>
              <dd>{asset.fiscalLifeMonths} luni</dd>
            </div>
            <div>
              <dt>Punere în funcțiune</dt>
              <dd>{asset.commissionedOn}</dd>
            </div>
            <div>
              <dt>Scoatere din funcțiune</dt>
              <dd>{asset.disposedOn ?? 'În funcțiune'}</dd>
            </div>
            {asset.fiscal ? (
              <>
                <div>
                  <dt>Metodă de amortizare fiscală</dt>
                  <dd>{fiscalMethods[asset.fiscal.method] ?? asset.fiscal.method}</dd>
                </div>
                <div>
                  <dt>Valoare fiscală</dt>
                  <dd>{formatMoney(asset.fiscal.value)}</dd>
                </div>
                <div>
                  <dt>Durată fiscală înregistrată</dt>
                  <dd>{asset.fiscal.lifeMonths} luni</dd>
                </div>
              </>
            ) : (
              <div>
                <dt>Amortizare fiscală</dt>
                <dd>Baza fiscală a acestui mijloc fix nu este înregistrată.</dd>
              </div>
            )}
          </dl>
          <button className="acc-secondary" onClick={() => filter({ registerAsset: null })}>
            Închide mijlocul fix
          </button>
        </section>
      ) : null}
    </section>
  );
}
