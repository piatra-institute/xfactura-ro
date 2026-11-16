'use client';

import { useState } from 'react';
import type { ProposalView } from 'xfactura-api/contracts';
import { amountField, companyPath, field, formatMoney } from './api';
import { useLoad, useWorkspace } from './workspace';
import { treatmentLabels, type WorkStepView } from './work-model';
export { treatmentLabels } from './work-model';
import { SectionLink } from './navigation';

const statusLabels: Record<ProposalView['status'], string> = {
  blocked: 'Blocată',
  proposed: 'De aprobat',
  approved: 'Aprobată',
  stale: 'Depășită',
  posted: 'Contabilizată',
  withdrawn: 'Retrasă',
};

export function ProposalCard({
  proposal,
  steps,
}: {
  proposal: ProposalView;
  steps?: WorkStepView[];
}) {
  const { can, invoke, act } = useWorkspace();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const effect = proposal.effect;
  const permitted = (operation: string) =>
    can(operation) &&
    !proposal.redacted &&
    (steps?.find((step) => step.operation === operation)?.allowed ?? true);
  const warnings = proposal.issues.filter((issue) => issue.severity === 'ack');
  const unreviewed = proposal.rules.used.filter((rule) => rule.status !== 'signed');
  const review = {
    proposalId: proposal.id,
    version: proposal.version,
    effectHash: proposal.effectHash,
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    await act(action, success);
    setBusy(false);
  };
  return (
    <article className="acc-review" aria-label={effect?.description ?? proposal.subject}>
      <div className="acc-review-heading">
        <div>
          <h4 className="acc-proposal-title">
            {treatmentLabels[proposal.treatment] ?? 'Propunere contabilă'}
          </h4>
          <p>
            {effect ? `${effect.description} · ${effect.date}` : proposal.subject} · versiunea{' '}
            {proposal.version}
          </p>
        </div>
        <span className="acc-status">{statusLabels[proposal.status]}</span>
      </div>
      {proposal.issues.length ? (
        <ul className="acc-warning">
          {proposal.issues.map((issue) => (
            <li key={`${issue.code}:${issue.path ?? ''}`}>
              {issue.severity === 'ack' ? (
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged.includes(issue.code)}
                    onChange={(event) =>
                      setAcknowledged((current) =>
                        event.target.checked
                          ? [...current, issue.code]
                          : current.filter((code) => code !== issue.code),
                      )
                    }
                  />{' '}
                  {issue.message}
                </label>
              ) : (
                <span className={issue.severity === 'block' ? 'acc-error' : undefined}>
                  {issue.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {proposal.status === 'stale' ? (
        <p className="acc-hint">
          Registrele s-au schimbat de la evaluarea acestei versiuni; revizuiți propunerea înainte de
          aprobare sau contabilizare.
        </p>
      ) : null}
      {unreviewed.length ? (
        <p className="acc-hint">
          Calculul folosește parametri fiscali neverificați de expertul contabil:{' '}
          {unreviewed.map((rule) => rule.id).join(', ')}.
        </p>
      ) : null}
      <div className="acc-review-columns">
        <ProposalEvidence proposal={proposal} />
        <div className="acc-review-effect">
          <h5>Efectul exact</h5>
          {effect ? (
            <div className="acc-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Cont</th>
                    <th scope="col">Debit</th>
                    <th scope="col">Credit</th>
                    <th scope="col">Valută</th>
                    <th scope="col">Detalii</th>
                  </tr>
                </thead>
                <tbody>
                  {effect.lines.map((line, index) => (
                    <tr key={index}>
                      <td>{line.account}</td>
                      <td>{line.side === 'D' ? formatMoney(line.amount) : ''}</td>
                      <td>{line.side === 'C' ? formatMoney(line.amount) : ''}</td>
                      <td>
                        {line.currency
                          ? `${formatMoney(line.currency.amount, line.currency.code)} · ${line.currency.rate}`
                          : ''}
                      </td>
                      <td>
                        {line.memo ??
                          (line.openItem
                            ? 'poziție deschisă'
                            : line.taxSettlement
                              ? `decont ${line.taxSettlement.period}`
                              : '')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {effect?.taxEntries.length ? (
            <dl className="acc-review-meta">
              {effect.taxEntries.map((entry) => (
                <div key={entry.key}>
                  <dt>
                    TVA {entry.direction === 'output' ? 'colectată' : 'deductibilă'} {entry.code} ·{' '}
                    {entry.taxPeriod}
                  </dt>
                  <dd>
                    bază {formatMoney(entry.base)}, TVA {formatMoney(entry.amount)}
                    {entry.direction === 'input'
                      ? `, deductibil ${formatMoney(entry.deductible)}`
                      : ''}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
      <dl className="acc-review-meta">
        <div>
          <dt>Versiune</dt>
          <dd>{proposal.version}</dd>
        </div>
        <div>
          <dt>Amprenta efectului</dt>
          <dd>
            <code>{proposal.effectHash}</code>
          </dd>
        </div>
      </dl>
      <div className="acc-actions">
        {proposal.status === 'proposed' && permitted('proposals.approve') ? (
          <button
            disabled={busy || warnings.some((warning) => !acknowledged.includes(warning.code))}
            onClick={() =>
              run(
                () => invoke('proposals.approve', { ...review, acknowledge: acknowledged }),
                'Versiunea a fost aprobată.',
              )
            }
          >
            Aprobă această versiune
          </button>
        ) : null}
        {proposal.status === 'approved' && permitted('ledger.post') ? (
          <button
            disabled={busy}
            onClick={() =>
              run(() => invoke('ledger.post', review), 'Înregistrarea a fost contabilizată.')
            }
          >
            Contabilizează
          </button>
        ) : null}
        {proposal.status !== 'posted' &&
        proposal.status !== 'withdrawn' &&
        permitted('proposals.withdraw') ? (
          <form
            className="acc-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const reason = field(new FormData(event.currentTarget), 'reason');
              void run(
                () => invoke('proposals.withdraw', { proposalId: proposal.id, reason }),
                'Propunerea a fost retrasă.',
              );
            }}
          >
            <label>
              Motivul retragerii
              <input name="reason" minLength={10} required />
            </label>
            <button className="acc-secondary" disabled={busy}>
              Retrage
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}

function EvidenceLink({ id }: { id: string }) {
  const { company, evidence } = useWorkspace();
  const file = evidence.find((candidate) => candidate.id === id);
  return (
    <a
      href={`${companyPath(company.id)}/evidence/${encodeURIComponent(id)}`}
      target="_blank"
      rel="noreferrer"
    >
      {file?.filename ?? 'Deschide documentul justificativ'}
    </a>
  );
}

function DocumentEvidence({ id }: { id: string }) {
  const { data, error } = useLoad<{
    number: string | null;
    date: string;
    evidenceId: string | null;
    currency: string | null;
    totals: { net: string; tax: string; gross: string } | null;
  }>('documents.get', { id });
  if (error) return <p className="acc-error">{error}</p>;
  if (!data) return <p className="acc-hint">Se încarcă documentul…</p>;
  return (
    <div>
      <p>
        {data.number ?? 'Document fără număr'} · {data.date}
      </p>
      {data.totals ? <p>{formatMoney(data.totals.gross, data.currency ?? 'RON')}</p> : null}
      {data.evidenceId ? (
        <EvidenceLink id={data.evidenceId} />
      ) : (
        <p className="acc-hint">Documentul nu indică un fișier original.</p>
      )}
    </div>
  );
}

function MovementEvidence({ id }: { id: string }) {
  const { data, error } = useLoad<{
    items: {
      id: string;
      bookingDate: string;
      amount: string | null;
      currency: string;
      reference: string | null;
      counterparty: string | null;
    }[];
  }>('bank.movements', {});
  const movement = data?.items.find((item) => item.id === id);
  return (
    <div>
      {error ? (
        <p className="acc-error">{error}</p>
      ) : !data ? (
        <p className="acc-hint">Se încarcă mișcarea bancară…</p>
      ) : movement ? (
        <>
          <p>
            {movement.bookingDate} · {movement.counterparty}
          </p>
          <p>
            {movement.amount === null
              ? 'Sumă cu acces restricționat'
              : formatMoney(movement.amount, movement.currency)}
          </p>
          <p>{movement.reference}</p>
        </>
      ) : (
        <p className="acc-hint">Mișcarea nu este disponibilă.</p>
      )}
      <SectionLink section="bank">Deschide Bancă</SectionLink>
    </div>
  );
}

function ProposalEvidence({ proposal }: { proposal: ProposalView }) {
  const input = proposal.input ?? {};
  const documents = [
    ...new Set(
      ['documentId', 'originalDocumentId'].flatMap((key) =>
        typeof input[key] === 'string' ? [input[key]] : [],
      ),
    ),
  ];
  const evidenceId = typeof input.evidenceId === 'string' ? input.evidenceId : null;
  const movementId = typeof input.movementId === 'string' ? input.movementId : null;
  return (
    <aside className="acc-review-source" aria-label="Documente justificative">
      <h5>Documente justificative</h5>
      {proposal.redacted ? (
        <p className="acc-hint">Documentele necesită acces la datele acestei propuneri.</p>
      ) : (
        <>
          {documents.map((id) => (
            <DocumentEvidence key={id} id={id} />
          ))}
          {evidenceId ? <EvidenceLink id={evidenceId} /> : null}
          {movementId ? <MovementEvidence id={movementId} /> : null}
          {!documents.length && !evidenceId && !movementId ? (
            <p className="acc-hint">Datele propunerii nu indică un document justificativ.</p>
          ) : null}
        </>
      )}
      {proposal.effect?.explanation.summary ? (
        <p className="acc-hint">{proposal.effect.explanation.summary}</p>
      ) : null}
    </aside>
  );
}

const LINES = 4;

export function JournalForm() {
  const { evidence, invoke, act } = useWorkspace();
  return (
    <details className="acc-disclosure">
      <summary>Notă contabilă nouă</summary>
      <form
        className="acc-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const lines = Array.from({ length: LINES }, (_, index) => ({
            account: field(data, `account${index}`),
            side: field(data, `side${index}`),
            amount: amountField(data, `amount${index}`),
          })).filter((line) => line.account && line.amount);
          void act(
            () =>
              invoke('ledger.general.propose', {
                date: field(data, 'date'),
                purpose: field(data, 'purpose'),
                reference: field(data, 'reference'),
                description: field(data, 'description'),
                evidenceId: field(data, 'evidenceId'),
                lines,
              }),
            'Propunerea a fost pregătită pentru verificare.',
          );
        }}
      >
        <div className="acc-form-grid">
          <label>
            Data
            <input name="date" type="date" required />
          </label>
          <label>
            Tip
            <select name="purpose" defaultValue="general">
              <option value="general">Înregistrare generală</option>
              <option value="opening">Poziție de deschidere</option>
              <option value="adjustment">Ajustare</option>
            </select>
          </label>
          <label>
            Referință
            <input name="reference" required maxLength={100} />
          </label>
        </div>
        <label>
          Explicație
          <input name="description" required minLength={3} />
        </label>
        <label>
          Document justificativ
          <select name="evidenceId" required>
            {evidence.map((file) => (
              <option key={file.id} value={file.id}>
                {file.filename}
              </option>
            ))}
          </select>
        </label>
        {Array.from({ length: LINES }, (_, index) => (
          <div className="acc-form-grid" key={index}>
            <label>
              Cont
              <input name={`account${index}`} inputMode="numeric" required={index < 2} />
            </label>
            <label>
              Parte
              <select name={`side${index}`} defaultValue={index % 2 ? 'C' : 'D'}>
                <option value="D">Debit</option>
                <option value="C">Credit</option>
              </select>
            </label>
            <label>
              Sumă (lei)
              <input name={`amount${index}`} inputMode="decimal" required={index < 2} />
            </label>
          </div>
        ))}
        <button>Pregătește propunerea</button>
      </form>
    </details>
  );
}
