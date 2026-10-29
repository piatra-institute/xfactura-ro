'use client';

import { useState } from 'react';
import type { ProposalView } from 'xfactura-api/contracts';
import { amountField, field, formatMoney } from './api';
import { useLoad, useWorkspace } from './workspace';

export const treatmentLabels: Record<string, string> = {
  'ledger.general': 'Notă contabilă',
  'ledger.reverse': 'Stornare',
  'invoices.recognize': 'Factură',
  'invoices.credit': 'Notă de credit',
  'bank.settle': 'Mișcare bancară',
  'fx.revalue': 'Reevaluare valutară',
};
const statusLabels: Record<ProposalView['status'], string> = {
  blocked: 'Blocată',
  proposed: 'De aprobat',
  approved: 'Aprobată',
  posted: 'Contabilizată',
  withdrawn: 'Retrasă',
};

export default function Review() {
  const { can } = useWorkspace();
  const { data, error } = useLoad<{ items: ProposalView[] }>('proposals.list', { limit: 200 });
  const open = (data?.items ?? []).filter(
    (item) => item.status !== 'posted' && item.status !== 'withdrawn',
  );
  return (
    <>
      <div className="acc-section-heading">
        <h2>De verificat</h2>
        <p>Fiecare propunere arată efectul exact; aprobarea se aplică acestei versiuni.</p>
      </div>
      {error ? <p className="acc-error">{error}</p> : null}
      {data && open.length === 0 ? (
        <p className="acc-empty">Nu există propuneri deschise.</p>
      ) : null}
      {open.map((proposal) => (
        <ProposalCard key={`${proposal.id}:${proposal.version}`} proposal={proposal} />
      ))}
      {can('ledger.general.propose') ? <JournalForm /> : null}
    </>
  );
}

export function ProposalCard({ proposal }: { proposal: ProposalView }) {
  const { can, invoke, act } = useWorkspace();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const effect = proposal.effect;
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
          <h3>{treatmentLabels[proposal.treatment] ?? proposal.treatment}</h3>
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
      {unreviewed.length ? (
        <p className="acc-hint">
          Calculul folosește parametri fiscali neverificați de expertul contabil:{' '}
          {unreviewed.map((rule) => rule.id).join(', ')}.
        </p>
      ) : null}
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
                {entry.direction === 'input' ? `, deductibil ${formatMoney(entry.deductible)}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="acc-actions">
        {proposal.status === 'proposed' && can('proposals.approve') ? (
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
        {proposal.status === 'approved' && can('ledger.post') ? (
          <button
            disabled={busy}
            onClick={() =>
              run(() => invoke('ledger.post', review), 'Înregistrarea a fost contabilizată.')
            }
          >
            Contabilizează
          </button>
        ) : null}
        {can('proposals.withdraw') ? (
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

const LINES = 4;

function JournalForm() {
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
