'use client';

import { useState } from 'react';
import type { Overview } from 'xfactura-api/accounting-types';
import type { DeferralRescheduleEffect } from 'xfactura-api/accounting';
import { Amount } from 'xfactura-api/accounting';
import { command, companyPath, field, formatMoney } from './api';
import type { Run } from './forms';

type Props = {
  state: Overview;
  effect: DeferralRescheduleEffect;
  showJournal: (id: string, yearId?: string) => void;
};

function AllocationValue({ row }: { row?: DeferralRescheduleEffect['beforeSchedule'][number] }) {
  return row ? (
    <>
      {formatMoney(row.amount)}
      {'benefit' in row && typeof row.benefit === 'string' ? (
        <span className="acc-benefit">{row.benefit}</span>
      ) : null}
      {'days' in row && typeof row.days === 'number' ? (
        <span className="acc-hint">
          <br />
          {row.days} zile
        </span>
      ) : null}
    </>
  ) : (
    <>—</>
  );
}

export function RescheduleDetails({ state, effect, showJournal }: Props) {
  const scopeCredit = effect.scopeCredit;
  const before = new Map(effect.beforeSchedule.map((row) => [row.month, row]));
  const after = new Map(effect.afterSchedule.map((row) => [row.month, row]));
  const months = [...new Set([...before.keys(), ...after.keys()])].sort();
  const source = state.evidence.find((row) => row.id === effect.evidenceId);
  const last = effect.beforeSchedule.at(-1)!;
  const previousEnd =
    'serviceTo' in last && typeof last.serviceTo === 'string' ? last.serviceTo : last.date;
  return (
    <>
      <dl className="acc-review-meta">
        <div>
          <dt>Modificare din</dt>
          <dd>{effect.effectiveFrom}</dd>
        </div>
        <div>
          <dt>Final anterior</dt>
          <dd>{previousEnd}</dd>
        </div>
        <div>
          <dt>Final nou</dt>
          <dd>{effect.serviceTo}</dd>
        </div>
        <div>
          <dt>Deja recunoscut</dt>
          <dd>{formatMoney(effect.allocated)}</dd>
        </div>
        <div>
          <dt>Valoare repartizată</dt>
          <dd>{formatMoney(effect.amount)}</dd>
        </div>
        <div>
          <dt>Preț și TVA</dt>
          <dd>Neschimbate</dd>
        </div>
        {scopeCredit ? (
          <div>
            <dt>Reducere înregistrată</dt>
            <dd>
              {formatMoney(
                new Amount(scopeCredit.amount).plus(scopeCredit.priorAmount ?? '0.00').toFixed(2),
              )}
            </dd>
          </div>
        ) : null}
        {effect.method === 'actual_calendar_days' ? (
          <div>
            <dt>Alocare</dt>
            <dd>Pe zile calendaristice</dd>
          </div>
        ) : null}
        {effect.method === 'evidenced_monthly_amounts' ? (
          <div>
            <dt>Alocare</dt>
            <dd>Sume lunare documentate</dd>
          </div>
        ) : null}
        <div>
          <dt>Motiv</dt>
          <dd>{effect.reason}</dd>
        </div>
      </dl>
      <div className="acc-actions">
        <a href={`${companyPath(state.company.id)}/evidence/${effect.evidenceId}`} download>
          {source?.filename ?? 'Acord de modificare'}
        </a>
        <button
          className="acc-secondary"
          onClick={() => showJournal(effect.sourceJournalId, effect.sourceFinancialYearId)}
        >
          {state.invoiceLabels[effect.sourceInvoiceId]?.number ?? 'Factura originală'}
        </button>
        {scopeCredit ? (
          <button
            className="acc-secondary"
            onClick={() => showJournal(scopeCredit.journalId, scopeCredit.financialYearId)}
          >
            {state.invoiceLabels[scopeCredit.invoiceId]?.number ?? 'Factura de reducere'}
          </button>
        ) : null}
      </div>
      <div className="acc-table-scroll">
        <table>
          <caption>Calendar de alocare</caption>
          <thead>
            <tr>
              <th>Lună</th>
              <th>Înainte</th>
              <th>După</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr key={month}>
                <td className="acc-month">{month.slice(0, 7)}</td>
                <td>
                  <AllocationValue row={before.get(month)} />
                </td>
                <td>
                  <AllocationValue row={after.get(month)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function RescheduleReview({
  state,
  review,
  showJournal,
  run,
  busy,
}: Omit<Props, 'effect'> & {
  review: Overview['rescheduleReviews'][number];
  run: Run;
  busy: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const path = `${companyPath(state.company.id)}/capabilities`;
  const exact = { id: review.id, hash: review.hash };
  const canReview = state.role === 'owner' || state.role === 'reviewer';
  return (
    <article className="acc-review" data-review-kind="reschedule">
      <div className="acc-review-heading">
        <div>
          <h3>
            {review.effect.method !== 'equal_calendar_months'
              ? 'Calendar servicii'
              : 'Calendar abonament'}{' '}
            · {state.invoiceLabels[review.effect.sourceInvoiceId]?.number ?? 'Modificare'}
          </h3>
          <p>
            {review.effect.date} · plan {review.effect.sequence}
          </p>
        </div>
        <strong>{formatMoney(review.effect.amount)}</strong>
      </div>
      <RescheduleDetails state={state} effect={review.effect} showJournal={showJournal} />
      {canReview ? (
        <>
          <div className="acc-actions">
            {review.approvedAt ? (
              <>
                <span className="acc-status">Plan aprobat</span>
                <button
                  disabled={busy || rejecting}
                  onClick={() =>
                    void run(
                      () => command(`${path}/reviews.execute`, exact),
                      'Calendarul de alocare a fost actualizat.',
                    )
                  }
                >
                  Aplică planul
                </button>
              </>
            ) : (
              <button
                disabled={busy || rejecting}
                onClick={() =>
                  void run(
                    () => command(`${path}/reviews.approve`, exact),
                    'Calendarul verificat a fost aprobat.',
                  )
                }
              >
                Aprobă acest plan
              </button>
            )}
            <button
              className="acc-secondary"
              disabled={busy || rejecting}
              onClick={() => setRejecting(true)}
            >
              Respinge planul
            </button>
          </div>
          {rejecting ? (
            <form
              className="acc-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const reason = field(new FormData(event.currentTarget), 'reason');
                void run(
                  () => command(`${path}/reviews.reject`, { ...exact, reason }),
                  'Planul a fost respins.',
                );
              }}
            >
              <label>
                Motivul respingerii
                <textarea name="reason" required minLength={10} maxLength={1000} disabled={busy} />
              </label>
              <div className="acc-actions">
                <button disabled={busy}>Confirmă respingerea</button>
                <button
                  className="acc-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  Renunță
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
