'use client';

import { useState } from 'react';
import type { ActionView, ProposalView } from 'xfactura-api/contracts';
import { ApiError, companyPath, field } from './api';
import { useLoad, useWorkspace } from './workspace';
import { treatmentLabels, type WorkStepView } from './work-model';
export { treatmentLabels } from './work-model';
import { SectionLink } from './navigation';
import { useAccountingData } from './use-data';
import { WorkDetails } from './work-details';
import { formatDate, formatMoney, formatPeriod } from './format';
import {
  Button,
  Cell,
  Chip,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  TextField,
  type Tone,
} from './ui';

/** A person's decision is bound to the preview actually displayed. Execution remains a
 * separate action, which the engine re-evaluates against the same hash. */
export function ReviewedDeclarationAction({
  id,
  disabled = false,
}: {
  id: string;
  disabled?: boolean;
}) {
  const { can, invoke, act } = useWorkspace();
  const action = useAccountingData<ActionView>('actions.get', { id }, can('actions.get'));
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const request = action.data;
  const preview = request?.preview;
  const findings =
    preview && typeof preview === 'object' && !Array.isArray(preview) ? preview.findings : null;
  const blocking = !Array.isArray(findings) || findings.length > 0;
  const authorization = request?.operation === 'declarations.authorize';
  const run = async (operation: 'actions.approve' | 'actions.execute') => {
    if (!request) return;
    setBusy(true);
    await act(
      async () => {
        try {
          await invoke(operation, {
            id,
            ...(operation === 'actions.approve' ? { previewHash: request.previewHash } : {}),
          });
        } catch (reason) {
          if (reason instanceof ApiError && reason.code === 'STALE') setStale(true);
          throw reason;
        }
      },
      operation === 'actions.approve'
        ? 'Previzualizarea exactă a fost aprobată.'
        : authorization
          ? 'Declarația a fost autorizată pe XML-ul verificat.'
          : 'Perioada fiscală a fost redeschisă.',
    );
    setBusy(false);
  };
  return (
    <section
      className="acc-review"
      aria-label={authorization ? 'Revizuirea autorizării' : 'Revizuirea redeschiderii'}
    >
      <h5>{authorization ? 'Autorizează XML-ul verificat' : 'Redeschide perioada fiscală'}</h5>
      {action.loading ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă previzualizarea…
        </p>
      ) : null}
      {action.error ? (
        <p role="alert" className="acc-error">
          {action.error}
        </p>
      ) : null}
      {request ? (
        <>
          <WorkDetails value={preview} technical={{ previewHash: request.previewHash }} />
          <p className="acc-hint">
            {authorization
              ? 'Autorizarea blochează perioada fiscală pentru acest XML. PDF-ul se semnează și se depune în afara aplicației.'
              : 'Redeschiderea permite corectarea perioadei fiscale. Declarația rectificativă se pregătește și se autorizează separat.'}
          </p>
          {stale ? (
            <p role="alert" className="acc-error">
              Previzualizarea este depășită. Solicită o previzualizare nouă înainte de a continua.
            </p>
          ) : null}
          {request.status === 'rejected' ? (
            <p>Cererea a fost respinsă.</p>
          ) : request.status === 'executed' ? (
            <p>Acțiunea a fost executată.</p>
          ) : null}
          <div className="acc-actions">
            {request.status === 'requested' && can('actions.approve') ? (
              <button
                disabled={disabled || busy || stale || action.unavailable || blocking}
                onClick={() => run('actions.approve')}
              >
                {authorization ? 'Aprobă autorizarea acestui XML' : 'Aprobă redeschiderea'}
              </button>
            ) : null}
            {request.status === 'approved' && can('actions.execute') ? (
              <button
                disabled={disabled || busy || stale || action.unavailable || blocking}
                onClick={() => run('actions.execute')}
              >
                {authorization ? 'Autorizează declarația' : 'Redeschide perioada'}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

const statusLabels: Record<ProposalView['status'], string> = {
  blocked: 'Blocată',
  proposed: 'De aprobat',
  approved: 'Aprobată',
  stale: 'Depășită',
  posted: 'Contabilizată',
  withdrawn: 'Retrasă',
};
const statusTones: Record<ProposalView['status'], Tone> = {
  blocked: 'danger',
  proposed: 'accent',
  approved: 'info',
  stale: 'warning',
  posted: 'success',
  withdrawn: 'neutral',
};

/** An account's name from the company's chart, beside its code. */
function AccountName({ code }: { code: string }) {
  const { can } = useWorkspace();
  const { data } = useLoad<{ items: { code: string; name: string }[] }>(
    'accounts.list',
    { prefix: code, limit: 1 },
    can('accounts.list'),
  );
  return <>{data?.items?.find((account) => account.code === code)?.name ?? ''}</>;
}

/** A line's partner, named by `parties.get`. */
function LinePartner({ id }: { id: string }) {
  const { can } = useWorkspace();
  const { data } = useLoad<{ name: string }>('parties.get', { partyId: id }, can('parties.get'));
  return <>{data?.name ?? ''}</>;
}

/**
 * A proposal's review: the retained evidence beside the exact effect, the warnings a person
 * confirms, and the decision on this exact version (approve, or post once approved) or its
 * withdrawal. Hashes and rule keys stay under „Detalii tehnice”.
 */
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
  const [withdrawing, setWithdrawing] = useState(false);
  const effect = proposal.effect;
  const permitted = (operation: string) =>
    can(operation) &&
    !proposal.redacted &&
    (steps?.find((step) => step.operation === operation)?.allowed ?? true);
  const warnings = proposal.issues.filter((issue) => issue.severity === 'ack');
  const notes = proposal.issues.filter((issue) => issue.severity !== 'ack');
  const unreviewed = proposal.rules.used.filter((rule) => rule.status !== 'signed');
  const review = {
    proposalId: proposal.id,
    version: proposal.version,
    effectHash: proposal.effectHash,
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    const done = await act(action, success);
    setBusy(false);
    return done;
  };
  const open = proposal.status !== 'posted' && proposal.status !== 'withdrawn';
  return (
    <article
      className="acc-review acc-proposal"
      aria-label={effect?.description ?? proposal.subject}
    >
      <div className="acc-review-heading">
        <div>
          <h4 className="acc-proposal-title">
            {treatmentLabels[proposal.treatment] ?? 'Propunere contabilă'}
          </h4>
          <p>
            {effect ? `${effect.description} · ${formatDate(effect.date)}` : proposal.subject} ·
            versiunea {proposal.version}
          </p>
        </div>
        <Chip tone={statusTones[proposal.status]}>{statusLabels[proposal.status]}</Chip>
      </div>
      {notes.length ? (
        <ul className="acc-review-notes">
          {notes.map((issue) => (
            <li
              key={`${issue.code}:${issue.path ?? ''}`}
              className={issue.severity === 'block' ? 'acc-error' : undefined}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {proposal.status === 'stale' ? (
        <p className="acc-hint">
          Registrele s-au schimbat de la evaluarea acestei versiuni: revizuiește propunerea înainte
          de aprobare.
        </p>
      ) : null}
      {unreviewed.length ? (
        <p className="acc-hint">
          {unreviewed.length === 1
            ? 'Calculul folosește un parametru fiscal neverificat de expertul contabil.'
            : `Calculul folosește ${unreviewed.length} parametri fiscali neverificați de expertul contabil.`}
        </p>
      ) : null}
      <div className="acc-review-columns">
        <ProposalEvidence proposal={proposal} />
        <section className="acc-review-effect" aria-label="Efectul exact">
          <h5>Efectul exact</h5>
          {effect ? (
            <Table aria-label="Efectul exact">
              <TableHeader>
                <Column isRowHeader>Cont</Column>
                <Column>Denumire</Column>
                <Column numeric>Debit</Column>
                <Column numeric>Credit</Column>
                <Column>Partener</Column>
              </TableHeader>
              <TableBody>
                {effect.lines.map((line, index) => (
                  <Row key={index} id={index}>
                    <Cell>{line.account}</Cell>
                    <Cell>
                      <span className="acc-effect-name">
                        <AccountName code={line.account} />
                      </span>
                      {line.memo ? <span className="acc-effect-memo">{line.memo}</span> : null}
                    </Cell>
                    <Cell numeric>{line.side === 'D' ? <LineAmount line={line} /> : null}</Cell>
                    <Cell numeric>{line.side === 'C' ? <LineAmount line={line} /> : null}</Cell>
                    <Cell>{line.partyId ? <LinePartner id={line.partyId} /> : null}</Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {effect?.taxEntries.length ? (
            <dl className="acc-review-meta">
              {effect.taxEntries.map((entry) => (
                <div key={entry.key}>
                  <dt>
                    TVA {entry.direction === 'output' ? 'colectată' : 'deductibilă'} {entry.code}
                    {entry.taxPeriod ? ` · ${formatPeriod(entry.taxPeriod)}` : ''}
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
        </section>
      </div>
      {warnings.length && proposal.status === 'proposed' ? (
        <fieldset className="acc-checklist">
          <legend>De confirmat</legend>
          {warnings.map((issue) => (
            <label key={`${issue.code}:${issue.path ?? ''}`}>
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
              />
              <span>{issue.message}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {withdrawing ? (
        <form
          className="acc-review-withdraw"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = field(new FormData(event.currentTarget), 'reason');
            void run(
              () => invoke('proposals.withdraw', { proposalId: proposal.id, reason }),
              'Propunerea a fost retrasă.',
            );
          }}
        >
          <TextField label="Motivul retragerii" name="reason" isRequired minLength={10} />
          <div className="acc-form-actions">
            <Button type="submit" variant="danger" isDisabled={busy}>
              Retrage propunerea
            </Button>
            <Button variant="quiet" onPress={() => setWithdrawing(false)}>
              Renunță
            </Button>
          </div>
        </form>
      ) : (
        <div className="acc-actions">
          {open && permitted('proposals.withdraw') ? (
            <Button variant="quiet" isDisabled={busy} onPress={() => setWithdrawing(true)}>
              Retrage
            </Button>
          ) : null}
          {proposal.status === 'proposed' && permitted('proposals.approve') ? (
            <Button
              variant="primary"
              isDisabled={busy || warnings.some((warning) => !acknowledged.includes(warning.code))}
              onPress={() =>
                run(
                  () => invoke('proposals.approve', { ...review, acknowledge: acknowledged }),
                  'Versiunea a fost aprobată.',
                )
              }
            >
              Aprobă această versiune
            </Button>
          ) : null}
          {proposal.status === 'approved' && permitted('ledger.post') ? (
            <Button
              variant="primary"
              isDisabled={busy}
              onPress={() =>
                run(() => invoke('ledger.post', review), 'Înregistrarea a fost contabilizată.')
              }
            >
              Contabilizează
            </Button>
          ) : null}
        </div>
      )}
      <details className="acc-disclosure acc-technical">
        <summary>Detalii tehnice</summary>
        <dl className="acc-work-details">
          <div>
            <dt>Amprenta efectului</dt>
            <dd>
              <code>{proposal.effectHash}</code>
            </dd>
          </div>
          {unreviewed.length ? (
            <div>
              <dt>Parametri neverificați</dt>
              <dd>{unreviewed.map((rule) => rule.id).join(', ')}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </article>
  );
}

/** A line's amount in lei and, for a foreign currency, its own amount and rate under it. */
function LineAmount({ line }: { line: NonNullable<ProposalView['effect']>['lines'][number] }) {
  return (
    <>
      {formatMoney(line.amount)}
      {line.currency ? (
        <span className="acc-effect-currency">
          {formatMoney(line.currency.amount, line.currency.code)} · {line.currency.rate}
        </span>
      ) : null}
    </>
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
        {data.number ?? 'Document fără număr'} · {formatDate(data.date)}
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
            {formatDate(movement.bookingDate)}
            {movement.counterparty ? ` · ${movement.counterparty}` : ''}
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
    </aside>
  );
}
