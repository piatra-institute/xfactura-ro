'use client';

import { useState } from 'react';
import type { ActionView } from 'xfactura-api/contracts';
import { formatMoney, formatMonth, formatMonths } from './format';
import { followLink, useAccountingNavigation } from './navigation';
import { useAccountingData } from './use-data';
import { Button, Cell, Chip, Column, Row, Table, TableBody, TableHeader, type Tone } from './ui';
import { useWorkspace } from './workspace';

type PeriodState = { month: string; state: 'closed' | 'open' };
type Finding = {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  count?: number;
  items?: unknown[];
};
type Balance = {
  account: string;
  currency: string;
  debit: string;
  credit: string;
  closing: string;
  closingCurrency?: string;
};
type Preview = { month: string; findings: Finding[]; balances?: Balance[] };

const requestStates: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'De aprobat', tone: 'warning' },
  approved: { label: 'Aprobată', tone: 'info' },
  executed: { label: 'Luna închisă', tone: 'success' },
  rejected: { label: 'Respinsă', tone: 'danger' },
};

/** Every month from the month of `from` to the month of `to`, `YYYY-MM`. */
function monthsOf(from: string, to: string) {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let step = 0; step < 240; step++) {
    const current = `${year}-${String(month).padStart(2, '0')}`;
    if (current > last) break;
    months.push(current);
    month = (month % 12) + 1;
    if (month === 1) year += 1;
  }
  return months;
}

/** This month in Bucharest, `YYYY-MM`: a month is checked for closing once it has begun. */
const thisMonth = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);

const isMonth = (item: unknown): item is string =>
  typeof item === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(item);

/** Exerciții și luni: the financial years, the months of the one selected and their close. */
export default function Periods() {
  const { can, invoke, act, years, year } = useWorkspace();
  const { href } = useAccountingNavigation();
  const {
    data: states,
    error,
    loading,
  } = useAccountingData<PeriodState[]>('periods.list', {}, true, true);
  const [request, setRequest] = useState<ActionView | null>(null);
  const preview = request?.preview as Preview | undefined;
  const financial = years.filter((choice) => choice.kind === 'financial');
  const months = year ? monthsOf(year.from, year.to) : [];
  // A close covers every earlier month, empty ones included: a month is closed when it, or any
  // later month, was closed last.
  const lastClosed = (states ?? [])
    .filter((state) => state.state === 'closed')
    .map((state) => state.month)
    .sort()
    .at(-1);
  const now = thisMonth();
  const check = (month: string) =>
    act(
      async () => setRequest(await invoke<ActionView>('periods.close.request', { month })),
      'Verificările au fost rulate.',
    );
  return (
    <div className="acc-periods">
      <section aria-labelledby="periods-years">
        <h2 id="periods-years">Exerciții financiare</h2>
        {financial.length ? (
          <ul className="acc-year-list">
            {financial.map((choice) => (
              <li key={choice.id}>
                <a
                  className="acc-year-card"
                  href={href('periods', { year: choice.id })}
                  aria-current={choice.id === year?.id ? 'true' : undefined}
                  onClick={followLink}
                >
                  <span className="acc-year-label">{choice.label}</span>
                  <span className="acc-year-range">
                    {formatMonths(monthsOf(choice.from, choice.to))}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="acc-empty">Niciun exercițiu financiar.</p>
        )}
      </section>
      {year ? (
        <section aria-labelledby="periods-months">
          <h2 id="periods-months">Lunile exercițiului {year.label}</h2>
          {error ? (
            <p role="alert" className="acc-error">
              {error}
            </p>
          ) : null}
          <ul className="acc-month-list" aria-busy={loading || undefined}>
            {months.map((month) => {
              const closed = !!lastClosed && month <= lastClosed;
              const name = formatMonth(month);
              return (
                <li key={month} className="acc-month-row">
                  <div className="acc-month-line">
                    <span className="acc-month-name">{name}</span>
                    {states ? (
                      <Chip tone={closed ? 'success' : 'neutral'}>
                        {closed ? 'închisă' : 'deschisă'}
                      </Chip>
                    ) : null}
                    {states && !closed && month <= now && can('periods.close.request') ? (
                      <Button
                        size="small"
                        variant="quiet"
                        aria-label={`Verifică luna ${name}`}
                        onPress={() => check(month)}
                      >
                        Verifică luna
                      </Button>
                    ) : null}
                  </div>
                  {request && preview?.month === month ? (
                    <ClosePreview request={request} preview={preview} onChange={setRequest} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The close's checks and closing balances, then its approval and execution by a person. */
function ClosePreview({
  request,
  preview,
  onChange,
}: {
  request: ActionView;
  preview: Preview;
  onChange: (request: ActionView) => void;
}) {
  const { can, invoke, act } = useWorkspace();
  const blocking = preview.findings.some((finding) => finding.severity === 'block');
  const state = requestStates[request.status] ?? { label: request.status, tone: 'neutral' };
  const reread = async () => onChange(await invoke<ActionView>('actions.get', { id: request.id }));
  const balances = preview.balances ?? [];
  return (
    <section className="acc-close" aria-labelledby={`close-${preview.month}`}>
      <div className="acc-close-head">
        <h3 id={`close-${preview.month}`}>Închiderea lunii {formatMonth(preview.month)}</h3>
        <Chip tone={state.tone}>{state.label}</Chip>
      </div>
      {preview.findings.length ? (
        <Table aria-label="Constatări">
          <TableHeader>
            <Column isRowHeader>Constatare</Column>
            <Column>Efect</Column>
            <Column numeric>Număr</Column>
          </TableHeader>
          <TableBody>
            {preview.findings.map((finding, index) => {
              const months = (finding.items ?? []).filter(isMonth);
              return (
                <Row key={`${finding.code}-${index}`} id={`${finding.code}-${index}`}>
                  <Cell>
                    {finding.message}
                    {months.length && months.length === finding.items?.length ? (
                      <>
                        {' '}
                        <Chip>{formatMonths(months)}</Chip>
                      </>
                    ) : null}
                  </Cell>
                  <Cell>
                    <Chip tone={finding.severity === 'block' ? 'danger' : 'warning'}>
                      {finding.severity === 'block' ? 'Blochează' : 'Atenționare'}
                    </Chip>
                  </Cell>
                  <Cell numeric>{finding.count ?? ''}</Cell>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="acc-close-clear">Nicio constatare.</p>
      )}
      {balances.length ? (
        <Table aria-label="Solduri la închidere" maxHeight="380px">
          <TableHeader>
            <Column isRowHeader>Cont</Column>
            <Column numeric>Rulaj debitor</Column>
            <Column numeric>Rulaj creditor</Column>
            <Column numeric>Sold final</Column>
          </TableHeader>
          <TableBody>
            {balances.map((balance) => (
              <Row
                key={`${balance.account}-${balance.currency}`}
                id={`${balance.account}-${balance.currency}`}
              >
                <Cell>{balance.account}</Cell>
                <Cell numeric>{formatMoney(balance.debit)}</Cell>
                <Cell numeric>{formatMoney(balance.credit)}</Cell>
                <Cell numeric>
                  {formatMoney(balance.closing)}
                  {balance.closingCurrency ? (
                    <span className="acc-close-currency">
                      {formatMoney(balance.closingCurrency, balance.currency)}
                    </span>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <div className="acc-form-actions">
        {request.status === 'requested' && can('actions.approve') ? (
          <Button
            variant="primary"
            isDisabled={blocking}
            onPress={() =>
              act(async () => {
                await invoke('actions.approve', {
                  id: request.id,
                  previewHash: request.previewHash,
                });
                await reread();
              }, 'Închiderea a fost aprobată.')
            }
          >
            Aprobă închiderea
          </Button>
        ) : null}
        {request.status === 'approved' && can('actions.execute') ? (
          <Button
            variant="primary"
            onPress={() =>
              act(async () => {
                await invoke('actions.execute', { id: request.id });
                await reread();
              }, 'Luna a fost închisă.')
            }
          >
            Închide luna
          </Button>
        ) : null}
        {blocking && request.status === 'requested' ? (
          <p className="acc-hint">Constatările care blochează se rezolvă înainte de aprobare.</p>
        ) : null}
      </div>
    </section>
  );
}
