'use client';

import { useState } from 'react';
import type { Overview } from 'xfactura-api/accounting-types';
import { correctionBodySchema, correctionLines } from 'xfactura-api/accounting';
import { command, companyPath, formatMoney } from './api';
import { CorrectionForm, type Run } from './forms';

export function CorrectionDetails({ proposal }: { proposal: Overview['proposals'][number] }) {
  const body = correctionBodySchema.parse(proposal.body);
  return (
    <>
      <p>{body.reason}</p>
      <p>
        Sumă înregistrată: {formatMoney(body.previousAmount)}
        <br />
        Sumă corectată: {formatMoney(body.amount)}
      </p>
    </>
  );
}

export default function CorrectionReview({
  state,
  proposal,
  run,
  busy,
  showJournal,
}: {
  state: Overview;
  proposal: Overview['proposals'][number];
  run: Run;
  busy: boolean;
  showJournal: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const body = correctionBodySchema.parse(proposal.body);
  const target = state.journals.find((entry) => entry.id === body.journalId)!;
  const source = state.evidence.find((item) => item.id === body.evidenceId)!;
  const path = companyPath(state.company.id);
  const canWrite = state.role !== 'viewer';
  const review = { version: proposal.version, hash: proposal.hash };
  return (
    <article className="acc-review">
      <div className="acc-review-heading">
        <div>
          <h3>
            {body.action === 'reverse' ? 'Stornare' : 'Corecție'} · înregistrarea #{target.number}
          </h3>
          <p>
            {body.date} · versiunea {proposal.version}
          </p>
        </div>
        <strong>{formatMoney(body.amount)}</strong>
      </div>
      <CorrectionDetails proposal={proposal} />
      <div className="acc-table-scroll">
        <table>
          <caption>
            Înregistrare inversă{body.action === 'replace' ? ' și suma corectată' : ''}
          </caption>
          <thead>
            <tr>
              <th>Cont</th>
              <th>Debit</th>
              <th>Credit</th>
            </tr>
          </thead>
          <tbody>
            {correctionLines(body.previousAmount, body.amount).map((line, index) => (
              <tr key={index}>
                <td>
                  {line.account} ·{' '}
                  {line.account === '401' ? 'Furnizori' : 'Servicii executate de terți'}
                </td>
                <td>{formatMoney(line.debit)}</td>
                <td>{formatMoney(line.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="acc-actions">
        <a href={`${path}/evidence/${body.evidenceId}`} download>
          {source.filename}
        </a>
        <button className="acc-secondary" onClick={() => showJournal(target.id)}>
          Înregistrarea #{target.number}
        </button>
      </div>
      {canWrite ? (
        <div className="acc-actions">
          {proposal.approved ? (
            <>
              <span className="acc-status">Versiune aprobată</span>
              <button
                disabled={busy || editing}
                onClick={() =>
                  void run(
                    () => command(`${path}/correction-proposals/${proposal.id}/post`, review),
                    'Corecția a fost contabilizată.',
                  )
                }
              >
                Contabilizează corecția
              </button>
            </>
          ) : (
            <button
              disabled={busy || editing}
              onClick={() =>
                void run(
                  () => command(`${path}/proposals/${proposal.id}/approve`, review),
                  'Versiunea verificată a fost aprobată.',
                )
              }
            >
              Aprobă această versiune
            </button>
          )}
          <button
            className="acc-secondary"
            disabled={busy || editing}
            onClick={() => setEditing(true)}
          >
            Modifică
          </button>
          <button
            className="acc-secondary"
            disabled={busy}
            onClick={() =>
              void run(
                () => command(`${path}/correction-proposals/${proposal.id}/withdraw`, review),
                'Propunerea a fost retrasă.',
              )
            }
          >
            Retrage propunerea
          </button>
        </div>
      ) : null}
      {editing ? (
        <CorrectionForm
          key={proposal.version}
          state={state}
          run={run}
          busy={busy}
          journalId={body.journalId}
          draft={proposal}
          cancel={() => setEditing(false)}
          done={() => setEditing(false)}
        />
      ) : null}
    </article>
  );
}
