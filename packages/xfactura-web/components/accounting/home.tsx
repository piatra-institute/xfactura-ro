'use client';

import { formatMoney } from './format';
import { useAccountingNavigation } from './navigation';
import { LinkButton } from './ui';
import { useLoad, useWorkspace } from './workspace';

type Balance = { rows: { account: string; closing: { debit: string; credit: string } }[] };

/** The net closing balance of accounts with a prefix, positive on their normal side. */
const net = (balance: Balance, prefix: string, normal: 'debit' | 'credit' = 'debit') => {
  let bani = 0n;
  for (const row of balance.rows)
    if (row.account.startsWith(prefix)) {
      const toBani = (value: string) => BigInt(value.replace('.', ''));
      bani += toBani(row.closing.debit) - toBani(row.closing.credit);
    }
  if (normal === 'credit') bani = -bani;
  const negative = bani < 0n;
  const digits = (negative ? -bani : bani).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/** Acasă: the money position from the trial balance and the way to the work waiting. */
export default function Home() {
  const { year } = useWorkspace();
  const { href } = useAccountingNavigation();
  const { data: balance, error } = useLoad<Balance>(
    'ledger.trialBalance',
    { financialYearId: year?.id },
    !!year,
  );
  const tiles = [
    { label: 'Bancă și casă', prefix: '5', normal: 'debit' },
    { label: 'De încasat de la clienți', prefix: '411', normal: 'debit' },
    { label: 'De plătit furnizorilor', prefix: '401', normal: 'credit' },
  ] as const;
  return (
    <div className="acc-home">
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : null}
      <dl className="acc-balances" aria-label="Solduri contabile" aria-busy={!balance}>
        {tiles.map((tile) => (
          <div key={tile.prefix}>
            <dt>{tile.label}</dt>
            <dd>{balance ? formatMoney(net(balance, tile.prefix, tile.normal)) : '…'}</dd>
          </div>
        ))}
      </dl>
      <ul className="acc-home-links">
        <li>
          <LinkButton href={href('review')}>De verificat</LinkButton>
        </li>
        <li>
          <LinkButton href={href('questions')}>Întrebări</LinkButton>
        </li>
        <li>
          <LinkButton href={href('deadlines')}>Declarații</LinkButton>
        </li>
      </ul>
    </div>
  );
}
