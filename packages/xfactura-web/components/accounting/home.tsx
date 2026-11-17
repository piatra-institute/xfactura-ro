'use client';

import { Fragment, useId, type ReactNode } from 'react';
import { formatCount, formatDay, formatMinor, formatPeriod } from './format';
import { useAccountingNavigation, yearForReturn } from './navigation';
import { ProfileCard, useFactRows } from './profile-card';
import { useAccountingData } from './use-data';
import { Button, Chip, EmptyState, LinkButton } from './ui';
import { WorkRow, useExpanded, workRowKey } from './work-rows';
import { arrangeWork, isFactItem, returnStatuses, returnTones, type WorkItem } from './work-model';
import { useWorkspace, type Money, type Summary } from './workspace';

/** Acasă: what waits on the person now, the money as the engine states it, the next returns. */
export default function Home() {
  const { summary, refresh } = useWorkspace();
  return (
    <div className="acc-home">
      <Now summary={summary.data} />
      <HomeSection title="Bani" busy={summary.loading} className="acc-home-money">
        {summary.data ? (
          <MoneyPosition summary={summary.data} />
        ) : summary.error ? (
          <Unread error={summary.error} retry={refresh} />
        ) : (
          <Skeleton />
        )}
      </HomeSection>
      <HomeSection title="Termene" busy={summary.loading} className="acc-home-deadlines">
        {summary.data ? <Deadlines summary={summary.data} /> : summary.error ? null : <Skeleton />}
      </HomeSection>
    </div>
  );
}

function HomeSection({
  title,
  busy,
  className,
  children,
}: {
  title: string;
  busy: boolean;
  className: string;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className={`acc-home-section ${className}`} aria-labelledby={heading} aria-busy={busy}>
      <h2 id={heading}>{title}</h2>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="acc-skeleton" />
      <div className="acc-skeleton" />
    </div>
  );
}

function Unread({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="acc-home-error">
      <p role="alert" className="acc-error">
        {error}
      </p>
      <Button size="small" onPress={retry}>
        Reîncearcă
      </Button>
    </div>
  );
}

/** De făcut acum: the missing company facts, then up to five items that wait on the person. */
function Now({ summary }: { summary: Summary | null }) {
  const { can } = useWorkspace();
  const { href } = useAccountingNavigation();
  const needs = useFactRows();
  const work = useAccountingData<{ items: WorkItem[] }>(
    'work.list',
    { by: 'human', limit: 50 },
    can('work.list'),
  );
  const expanded = useExpanded();
  // What waits on the person, grouped as De verificat groups it (a return's periods are one
  // row), the first five rows.
  const rows = arrangeWork(
    (work.data?.items ?? []).filter(
      (item) => !isFactItem(item) && item.next.some((step) => step.by === 'human'),
    ),
    needs.facts,
  )
    .flatMap((group) => group.rows)
    .slice(0, 5);
  const waiting = summary?.work.by.person ?? 0;
  const settled = !work.loading && !needs.loading && !!work.data;
  return (
    <HomeSection
      title="De făcut acum"
      busy={work.loading || needs.loading}
      className="acc-home-now"
    >
      <ProfileCard needs={needs} level={3} />
      {work.error ? (
        <p role="alert" className="acc-error">
          {work.error}
        </p>
      ) : null}
      {rows.length ? (
        <ul className="acc-work-list acc-home-work" aria-label="Elemente care așteaptă decizia ta">
          {rows.map((row) => (
            <WorkRow key={workRowKey(row)} row={row} expanded={expanded} />
          ))}
        </ul>
      ) : null}
      {settled && !rows.length && !needs.rows.length && !work.error ? (
        <EmptyState
          message="Nimic nu așteaptă decizia ta."
          action={{ label: 'Adaugă documente', href: href('documents') }}
        />
      ) : null}
      {waiting > 0 ? (
        <p className="acc-home-all">
          <LinkButton href={href('review')} size="small" variant="quiet">
            De verificat
            <span className="acc-badge">
              {formatCount(waiting)}
              {summary?.work.complete ? '' : '+'}
            </span>
          </LinkButton>
        </p>
      ) : null}
    </HomeSection>
  );
}

const minorText = (money: Money) => formatMinor(money.minor, money.currency);
/** A count as Romanian says it: `1 obligație`, `3 obligații`, `20 de obligații`. */
const counted = (count: number, one: string, many: string) =>
  count === 1
    ? `1 ${one}`
    : `${formatCount(count)}${count % 100 >= 20 || (count && count % 100 === 0) ? ' de' : ''} ${many}`;
/** How many open items: `1 poziție deschisă`, `20 de poziții deschise`. */
const positions = (count: number, one: string, many: string) =>
  counted(count, `poziție ${one}`, `poziții ${many}`);
const isZero = (money: Money | string) =>
  /^-?0+$/.test(typeof money === 'string' ? money : money.minor);

/** One line of a statement: its name and the engine's amount, right-aligned. */
function Line({
  name,
  amount,
  note,
  tone,
  total,
}: {
  name: ReactNode;
  amount: string;
  note?: ReactNode;
  tone?: 'danger' | 'muted';
  total?: boolean;
}) {
  return (
    <div className={['acc-statement-line', total ? 'acc-statement-total' : ''].join(' ').trim()}>
      <dt>
        {name}
        {note ? <span className="acc-statement-note">{note}</span> : null}
      </dt>
      <dd className={tone ? `acc-amount--${tone}` : undefined}>{amount}</dd>
    </div>
  );
}

/** Bani: cash, what customers owe and what is owed to suppliers, the position towards the state;
 * every figure as `company.summary` states it, nothing added up here. */
function MoneyPosition({ summary }: { summary: Summary }) {
  const { href } = useAccountingNavigation();
  const { cash, receivables, payables, tax, taxReason } = summary;
  return (
    <div className="acc-money">
      <div className="acc-money-block">
        <h3>Bancă și casă</h3>
        {cash.accounts.length ? (
          <dl className="acc-statement">
            {cash.accounts.map((account) => (
              <Line
                key={account.id}
                name={account.name}
                amount={minorText(account.balance)}
                tone={isZero(account.balance) ? 'muted' : undefined}
              />
            ))}
            {cash.totals.map((total) => (
              <Line
                key={total.currency}
                name={`Total ${total.currency}`}
                amount={minorText(total)}
                total
              />
            ))}
          </dl>
        ) : (
          <EmptyState
            message="Niciun cont bancar sau de casă."
            action={{ label: 'Adaugă un cont', href: href('bank') }}
          />
        )}
      </div>
      <OpenSide title="Clienți" owed="De încasat" side={receivables} />
      <OpenSide title="Furnizori" owed="De plătit" side={payables} />
      <div className="acc-money-block">
        <h3>Stat</h3>
        {tax ? (
          <dl className="acc-statement">
            <Line
              name="Datorat"
              note={counted(tax.obligations, 'obligație', 'obligații')}
              amount={minorText(tax.owed)}
            />
            {!isZero(tax.overdue) ? (
              <Line name="din care restant" amount={minorText(tax.overdue)} tone="danger" />
            ) : null}
            {!isZero(tax.claims) ? (
              <Line name="De recuperat" amount={minorText(tax.claims)} />
            ) : null}
            <Line name="Sold" amount={minorText(tax.net)} total />
          </dl>
        ) : taxReason ? (
          <p className="acc-money-note">
            Poziția nu se calculează: lipsește o regulă fiscală aprobată.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OpenSide({
  title,
  owed,
  side,
}: {
  title: string;
  owed: string;
  side: Summary['receivables'];
}) {
  return (
    <div className="acc-money-block">
      <h3>{title}</h3>
      {side.currencies.length ? (
        <dl className="acc-statement">
          {side.currencies.map((currency) => (
            <Fragment key={currency.currency}>
              <Line
                name={owed}
                note={positions(currency.count, 'deschisă', 'deschise')}
                amount={formatMinor(currency.total, currency.currency)}
                total
              />
              {currency.overdueCount ? (
                <Line
                  name="Restante"
                  note={positions(currency.overdueCount, 'restantă', 'restante')}
                  amount={formatMinor(currency.overdue, currency.currency)}
                  tone="danger"
                />
              ) : null}
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="acc-money-note">Nicio poziție deschisă.</p>
      )}
      {side.unrepresented ? (
        <p className="acc-money-note">
          Fără evidență pe parteneri, în afara totalului:{' '}
          {side.unrepresented.accounts.map((account) => account.account).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

/** Termene: the next returns, each with its deadline, status and the way to it in Declarații. */
function Deadlines({ summary }: { summary: Summary }) {
  const { href } = useAccountingNavigation();
  const { years } = useWorkspace();
  if (!summary.deadlines.length)
    return (
      <EmptyState
        message="Nicio declarație de depus."
        action={{ label: 'Deschide Declarații', href: href('deadlines') }}
      />
    );
  // The day column is kept only when a return has a deadline.
  const dated = summary.deadlines.some((deadline) => deadline.due);
  return (
    <ol className={dated ? 'acc-deadlines acc-deadlines--dated' : 'acc-deadlines'}>
      {summary.deadlines.map((deadline) => {
        const key = `${deadline.kind}|${deadline.period}`;
        return (
          <li key={key} className="acc-deadline" data-return={key}>
            {dated ? (
              <span className="acc-deadline-day">
                {deadline.due ? (
                  <time dateTime={deadline.due}>
                    {formatDay(deadline.due, summary.date.slice(0, 4))}
                  </time>
                ) : null}
              </span>
            ) : null}
            <span className="acc-deadline-return">
              <strong>{deadline.kind}</strong> {formatPeriod(deadline.period)}
            </span>
            <span className="acc-deadline-status">
              {returnStatuses[deadline.status] ? (
                <Chip tone={returnTones[deadline.status] ?? 'neutral'}>
                  {returnStatuses[deadline.status]}
                </Chip>
              ) : null}
            </span>
            <LinkButton
              size="small"
              href={href('deadlines', {
                return: key,
                month: null,
                declarationStatus: null,
                year: yearForReturn(years, key)?.id ?? null,
              })}
            >
              Deschide
            </LinkButton>
          </li>
        );
      })}
    </ol>
  );
}
