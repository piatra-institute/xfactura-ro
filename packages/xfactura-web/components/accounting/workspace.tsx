'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { Overview } from 'xfactura-api/accounting-types';
import { Amount, proposalLines } from 'xfactura-api/accounting';
import { ApiError, command, companyPath, field, formatMoney, get, upload } from './api';
import { CorrectionForm, OpeningForm, PurchaseForm, StatementForm, type Run } from './forms';
import CorrectionReview, { CorrectionDetails } from './correction-review';
import GeneralDetails from './general-details';
import BankStatementEntries from './bank-statement-entries';

type Props = { companyId: string };

export default function Workspace({ companyId }: Props) {
  const [state, setState] = useState<Overview | null>(null);
  const [financialYearId, setFinancialYearId] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(location.search).get('financialYearId') ?? ''),
  );
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<string | null>(null);
  const [focusedJournal, setFocusedJournal] = useState<string | null>(null);
  const path = companyPath(companyId);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  function selectYear(id: string) {
    const url = new URL(location.href);
    url.searchParams.set('financialYearId', id);
    history.replaceState(null, '', `${url.pathname}${url.search}`);
    setFinancialYearId(id);
    setState(null);
  }
  function showJournal(id: string, yearId?: string) {
    if (yearId && yearId !== state?.financialYear.id) selectYear(yearId);
    setTab('journal');
    setFocusedJournal(id);
  }
  useEffect(() => {
    if (tab !== 'journal' || !focusedJournal) return;
    const entry = document.getElementById(`journal-${focusedJournal}`);
    if (entry instanceof HTMLDetailsElement) {
      entry.open = true;
      entry.querySelector('summary')?.focus({ preventScroll: true });
      entry.scrollIntoView({ block: 'start' });
    }
  }, [tab, focusedJournal, state?.financialYear.id]);

  useEffect(() => {
    const controller = new AbortController();
    get<Overview>(
      `${path}${financialYearId ? `?financialYearId=${financialYearId}` : ''}`,
      controller.signal,
    )
      .then(setState)
      .catch((error) => {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setState(null);
          setError(error instanceof Error ? error.message : 'Datele nu sunt disponibile.');
        }
      });
    return () => controller.abort();
  }, [path, revision, financialYearId]);

  const pendingExports = state?.jobs.some(
    (job) => job.status === 'pending' || job.status === 'running',
  );
  useEffect(() => {
    if (!pendingExports) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [pendingExports, refresh]);

  const run: Run = async (action, success) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Operațiunea nu a reușit. Poți reîncerca.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!state)
    return (
      <section className="acc-loading" aria-busy={!error}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={refresh}>Reîncearcă</button>
          </>
        ) : (
          <>
            <div className="acc-skeleton" />
            <div className="acc-skeleton" />
            <p>Se încarcă înregistrările companiei…</p>
          </>
        )}
      </section>
    );

  const canWrite = state.role !== 'viewer';
  const accountNames = state.accountNames;
  const pending = state.proposals.filter(
    (proposal) => !proposal.posted && !proposal.withdrawn && !proposal.superseded,
  );
  const unreconciled = state.movements.filter((movement) => !movement.matched);
  const hasOpening = state.proposals.some(
    (proposal) =>
      proposal.kind === 'opening' ||
      (proposal.kind === 'general' &&
        'purpose' in proposal.body &&
        proposal.body.purpose === 'opening'),
  );
  const legacyYear = state.financialYear.from === `${state.company.year}-01-01`;
  const balance = (account: string) =>
    state.balances
      .filter((row) => row.account === account || row.account.startsWith(`${account}.`))
      .reduce((sum, row) => sum.plus(row.balance), new Amount(0))
      .toFixed(2);
  const payable = new Amount(balance('401')).negated().toFixed(2);
  const serviceExpenses = state.balances
    .filter((row) => /^(61\d|62\d)(?:\.|$)/.test(row.account))
    .reduce((sum, row) => sum.plus(row.balance), new Amount(0))
    .toFixed(2);

  return (
    <>
      <div className="acc-workspace-title">
        <div>
          <h1>{state.company.name}</h1>
          <p>
            CUI {state.company.cui} <span aria-hidden="true">·</span> {state.financialYear.label}
          </p>
        </div>
        {state.financialYears.length > 1 ? (
          <label>
            Exercițiu financiar
            <select
              value={state.financialYear.id}
              disabled={busy}
              onChange={(event) => {
                selectYear(event.target.value);
              }}
            >
              {state.financialYears.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="acc-secondary"
          disabled={busy}
          onClick={async () => {
            if (await run(() => command(`${path}/exports`, {}), '')) setTab('documents');
          }}
        >
          Export complet
        </button>
      </div>

      <div className="acc-feedback" aria-live="polite">
        {error ? (
          <p role="alert" className="acc-error">
            {error}
          </p>
        ) : notice ? (
          <p role="status">{notice}</p>
        ) : null}
      </div>
      <dl className="acc-balances" aria-label="Solduri contabile">
        <div>
          <dt>În bancă</dt>
          <dd>{formatMoney(balance('5121'))}</dd>
        </div>
        <div>
          <dt>De plătit furnizorilor</dt>
          <dd>{formatMoney(payable)}</dd>
        </div>
        <div>
          <dt>Cheltuieli cu servicii</dt>
          <dd>{formatMoney(serviceExpenses)}</dd>
        </div>
      </dl>
      <nav className="acc-tabs" aria-label="Secțiuni contabilitate">
        {[
          ['review', 'De verificat', pending.length],
          ['bank', 'Bancă', unreconciled.length],
          ['journal', 'Registre', null],
          ['documents', 'Documente', state.evidence.length],
        ].map(([id, label, count]) => (
          <button
            key={id}
            className={tab === id ? 'acc-active' : ''}
            aria-pressed={tab === id}
            onClick={() => setTab(String(id))}
          >
            <span>{label}</span>
            {count !== null ? <span className="acc-count">{count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'review' ? (
        <section className="acc-content">
          {!hasOpening && canWrite && legacyYear ? (
            <OpeningForm state={state} run={run} busy={busy} />
          ) : null}
          <div className="acc-section-heading">
            <div>
              <h2>Decizii de revizuit</h2>
              <p>Verifică documentul, perioada și efectul înainte de aprobare.</p>
            </div>
          </div>
          {!pending.length ? (
            <p className="acc-empty">
              Nu sunt propuneri în așteptare. Adaugă o factură sau verifică mișcările bancare.
            </p>
          ) : (
            pending.map((proposal) => {
              if (proposal.kind === 'correction')
                return (
                  <CorrectionReview
                    key={proposal.id}
                    state={state}
                    proposal={proposal}
                    run={run}
                    busy={busy}
                    showJournal={showJournal}
                  />
                );
              const body = proposal.body;
              const title =
                proposal.kind === 'opening'
                  ? 'Poziția inițială'
                  : 'supplier' in body
                    ? `${body.supplier} · ${body.invoiceNumber}`
                    : 'description' in body
                      ? body.description
                      : 'Înregistrare contabilă';
              const source = state.evidence.find((item) => item.id === body.evidenceId);
              const review = { version: proposal.version, hash: proposal.hash };
              const amount =
                'settlement' in body && body.settlement
                  ? body.lines
                      .filter((line) => line.account === body.settlement!.ledgerAccount)
                      .reduce((sum, line) => sum.plus(line.debit).minus(line.credit), new Amount(0))
                      .toFixed(2)
                  : 'invoice' in body && body.invoice
                    ? body.invoice.gross
                    : body.amount;
              return (
                <article className="acc-review" key={proposal.id}>
                  <div className="acc-review-heading">
                    <div>
                      <h3>{title}</h3>
                      <p>
                        {body.date}{' '}
                        {proposal.kind === 'purchase' && 'description' in body
                          ? `· ${body.description}`
                          : ''}
                      </p>
                    </div>
                    <strong>{formatMoney(amount)}</strong>
                  </div>
                  <p>
                    <a href={`${path}/evidence/${body.evidenceId}`} download>
                      {source?.filename ?? 'Descarcă documentul original'}
                    </a>
                    <span className="acc-hint"> · versiunea {proposal.version}</span>
                  </p>
                  {proposal.kind === 'general' &&
                  'schemaVersion' in body &&
                  body.schemaVersion === 2 ? (
                    <GeneralDetails
                      body={body}
                      state={state}
                      path={path}
                      showJournal={showJournal}
                    />
                  ) : null}
                  <div className="acc-table-scroll">
                    <table>
                      <caption>Efect contabil propus</caption>
                      <thead>
                        <tr>
                          <th>Cont</th>
                          <th>Debit</th>
                          <th>Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {proposalLines(proposal.kind, body).map((line, index) => (
                          <tr key={index}>
                            <td>
                              {line.account}
                              {accountNames[line.account] ? ` · ${accountNames[line.account]}` : ''}
                            </td>
                            <td>{formatMoney(line.debit)}</td>
                            <td>{formatMoney(line.credit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {canWrite ? (
                    <div className="acc-actions">
                      {!proposal.approved ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => command(`${path}/proposals/${proposal.id}/approve`, review),
                              'Versiunea verificată a fost aprobată.',
                            )
                          }
                        >
                          Aprobă această versiune
                        </button>
                      ) : (
                        <>
                          <span className="acc-status">Versiune aprobată</span>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => command(`${path}/proposals/${proposal.id}/post`, review),
                                'Înregistrarea a fost contabilizată.',
                              )
                            }
                          >
                            Contabilizează
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="acc-hint">
                      Ai acces de citire. Un membru cu drept de revizuire poate aproba.
                    </p>
                  )}
                </article>
              );
            })
          )}
          {canWrite && legacyYear ? <PurchaseForm state={state} run={run} busy={busy} /> : null}
          {state.proposals.some((proposal) => proposal.withdrawn) ? (
            <details className="acc-disclosure">
              <summary>Propuneri retrase</summary>
              {state.proposals
                .filter((proposal) => proposal.withdrawn)
                .map((proposal) => (
                  <p key={proposal.id}>
                    {proposal.body.date} · {'reason' in proposal.body ? proposal.body.reason : ''} ·
                    versiunea {proposal.version}
                  </p>
                ))}
            </details>
          ) : null}
        </section>
      ) : null}

      {tab === 'bank' ? (
        <section className="acc-content">
          <h2>Plăți și reconciliere</h2>
          <p>
            Confirmă legătura dintre fiecare plată și factura contabilizată. Data plății nu schimbă
            data cheltuielii.
          </p>
          {!state.movements.length ? (
            <p className="acc-empty">
              Importă primul extras pentru a verifica soldurile și plățile.
            </p>
          ) : (
            state.movements.map((movement) => {
              const options = state.proposals.filter(
                (proposal) =>
                  proposal.posted &&
                  proposal.kind === 'purchase' &&
                  new Amount(proposal.currentAmount).gt(proposal.paid),
              );
              return (
                <article key={movement.id} className="acc-bank-row">
                  <div>
                    <h3>{movement.reference || 'Mișcare bancară'}</h3>
                    <p>
                      {movement.date}
                      {movement.sourceReference ? ` · ${movement.sourceReference}` : ''}
                    </p>
                  </div>
                  <strong>{formatMoney(movement.amount)}</strong>
                  {movement.matched ? (
                    <span className="acc-status">Reconciliată</span>
                  ) : canWrite && new Amount(movement.amount).lt(0) ? (
                    <form
                      className="acc-match"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void run(
                          () =>
                            command(`${path}/matches`, {
                              movementId: movement.id,
                              proposalId: field(data, 'proposalId'),
                              amount: new Amount(movement.amount).abs().toFixed(2),
                            }),
                          'Plata a fost reconciliată și contabilizată.',
                        );
                      }}
                    >
                      <label>
                        Factură
                        <select name="proposalId" required defaultValue="">
                          <option value="">Alege factura</option>
                          {options.map((proposal) => (
                            <option key={proposal.id} value={proposal.id}>
                              {'supplier' in proposal.body
                                ? `${proposal.body.supplier} · ${proposal.body.invoiceNumber}`
                                : proposal.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button disabled={busy || !options.length}>Confirmă plata</button>
                      {!options.length ? (
                        <span className="acc-hint">
                          Nu există facturi contabilizate cu sold deschis.
                        </span>
                      ) : null}
                    </form>
                  ) : (
                    <span className="acc-status acc-warning">Necesită revizuire</span>
                  )}
                </article>
              );
            })
          )}
          {canWrite ? <StatementForm state={state} run={run} busy={busy} /> : null}
          {state.statements.length ? (
            <div className="acc-table-scroll">
              <table>
                <caption>Extrase importate</caption>
                <thead>
                  <tr>
                    <th>Extras</th>
                    <th>Interval</th>
                    <th>Sold inițial</th>
                    <th>Sold final</th>
                  </tr>
                </thead>
                <tbody>
                  {state.statements.map((statement) => (
                    <Fragment key={statement.id}>
                      <tr>
                        <td>
                          <a href={`${path}/evidence/${statement.evidenceId}`} download>
                            {statement.source?.sourceId ?? statement.sourceId}
                          </a>
                          {statement.source ? (
                            <span className="acc-hint">
                              {' '}
                              · {statement.source.format === 'mt940' ? 'MT940' : 'camt.053'}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {statement.periodFrom} — {statement.periodTo}
                        </td>
                        <td>{formatMoney(statement.opening)}</td>
                        <td>{formatMoney(statement.closing)}</td>
                      </tr>
                      {statement.source ? (
                        <tr>
                          <td colSpan={4}>
                            <BankStatementEntries path={path} sourceId={statement.source.id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'journal' ? (
        <section className="acc-content">
          <h2>Balanță de verificare</h2>
          <p>Calculată din aceleași înregistrări ca jurnalul. Soldurile sunt exprimate în RON.</p>
          <div className="acc-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cont</th>
                  <th>Total debit</th>
                  <th>Total credit</th>
                  <th>Sold debit − credit</th>
                </tr>
              </thead>
              <tbody>
                {state.balances.map((row) => (
                  <tr key={row.account}>
                    <td>
                      {row.account} · {accountNames[row.account]}
                    </td>
                    <td>{formatMoney(row.debit)}</td>
                    <td>{formatMoney(row.credit)}</td>
                    <td>{formatMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!state.balances.length ? (
            <p className="acc-empty">Balanța apare după prima poziție contabilizată.</p>
          ) : null}
          <h2 className="acc-spaced">Jurnal contabil</h2>
          {state.journals.map((entry) => (
            <details key={entry.id} id={`journal-${entry.id}`} className="acc-journal">
              <summary>
                <span>
                  #{entry.number} · {entry.description}
                </span>
                <span>{entry.date}</span>
              </summary>
              {entry.kind === 'correction' ? (
                <CorrectionDetails
                  proposal={state.proposals.find((proposal) => proposal.id === entry.sourceId)!}
                />
              ) : null}
              {state.proposals.flatMap((proposal) =>
                proposal.id === entry.sourceId &&
                proposal.kind === 'general' &&
                'schemaVersion' in proposal.body &&
                proposal.body.schemaVersion === 2
                  ? [
                      <GeneralDetails
                        key={proposal.id}
                        body={proposal.body}
                        state={state}
                        path={path}
                        showJournal={showJournal}
                      />,
                    ]
                  : [],
              )}
              <div className="acc-table-scroll">
                <table>
                  <caption>Linii contabilizate</caption>
                  <thead>
                    <tr>
                      <th>Cont</th>
                      <th>Debit</th>
                      <th>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line, index) => (
                      <tr key={index}>
                        <td>
                          {line.account} · {accountNames[line.account]}
                        </td>
                        <td>{formatMoney(line.debit)}</td>
                        <td>{formatMoney(line.credit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                <a href={`${path}/evidence/${entry.evidenceId}`} download>
                  Document justificativ
                </a>
              </p>
              <div className="acc-actions">
                {entry.correctsJournalId ? (
                  <button
                    className="acc-secondary"
                    onClick={() => showJournal(entry.correctsJournalId!)}
                  >
                    Înregistrarea corectată #
                    {state.journals.find((item) => item.id === entry.correctsJournalId)?.number}
                  </button>
                ) : null}
                {entry.correctedByJournalId ? (
                  <button
                    className="acc-secondary"
                    onClick={() => showJournal(entry.correctedByJournalId!)}
                  >
                    Corectată prin înregistrarea #
                    {state.journals.find((item) => item.id === entry.correctedByJournalId)?.number}
                  </button>
                ) : canWrite && (entry.kind === 'purchase' || entry.kind === 'correction') ? (
                  <button
                    className="acc-secondary"
                    disabled={busy}
                    onClick={() => {
                      const draft = pending.find(
                        (proposal) =>
                          proposal.kind === 'correction' &&
                          'journalId' in proposal.body &&
                          proposal.body.journalId === entry.id,
                      );
                      if (draft) setTab('review');
                      else setCorrectionTarget(entry.id);
                    }}
                  >
                    {pending.some(
                      (proposal) =>
                        'journalId' in proposal.body && proposal.body.journalId === entry.id,
                    )
                      ? 'Revizuiește corecția'
                      : 'Corectează'}
                  </button>
                ) : null}
              </div>
              {correctionTarget === entry.id ? (
                <CorrectionForm
                  state={state}
                  run={run}
                  busy={busy}
                  journalId={entry.id}
                  cancel={() => setCorrectionTarget(null)}
                  done={() => {
                    setCorrectionTarget(null);
                    setTab('review');
                    window.scrollTo({ top: 0 });
                  }}
                />
              ) : null}
            </details>
          ))}
          {canWrite ? (
            <details className="acc-disclosure">
              <summary>Închiderea unei luni</summary>
              <p>Închiderea blochează înregistrările contabile în luna selectată.</p>
              <form
                className="acc-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void run(
                    () => command(`${path}/periods/${field(data, 'month')}-01/close`, {}),
                    'Luna a fost închisă contabil.',
                  );
                }}
              >
                <label>
                  Luna
                  <input
                    type="month"
                    name="month"
                    min={state.financialYear.from.slice(0, 7)}
                    max={state.financialYear.to.slice(0, 7)}
                    required
                  />
                </label>
                <button disabled={busy}>Închide luna contabilă</button>
              </form>
            </details>
          ) : null}
        </section>
      ) : null}

      {tab === 'documents' ? (
        <section className="acc-content">
          <h2>Documente originale</h2>
          {canWrite ? (
            <form
              className="acc-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const file = new FormData(event.currentTarget).get('file');
                if (file instanceof File)
                  void run(() => upload(companyId, file), 'Documentul original a fost păstrat.');
              }}
            >
              <label>
                Fișier original
                <input type="file" name="file" required />
              </label>
              <button disabled={busy}>Păstrează documentul</button>
            </form>
          ) : null}
          <ul className="acc-document-list">
            {state.evidence.map((source) => (
              <li key={source.id}>
                <a href={`${path}/evidence/${source.id}`} download>
                  {source.filename}
                </a>
                <span>{source.size.toLocaleString('ro-RO')} octeți</span>
                <details>
                  <summary>Verifică integritatea</summary>
                  <code>{source.hash}</code>
                </details>
              </li>
            ))}
          </ul>
          <h2 className="acc-spaced">Exporturi</h2>
          <p>
            Exportul include înregistrările și documentele originale, pentru versiunea solicitată.
          </p>
          {!state.jobs.length ? (
            <p className="acc-empty">Solicită un export folosind „Export complet”.</p>
          ) : (
            <ul className="acc-document-list">
              {state.jobs.map((job) => (
                <li key={job.id}>
                  <span>{new Date(job.createdAt).toLocaleString('ro-RO')}</span>
                  {job.status === 'done' ? (
                    <a href={`${path}/exports/${job.id}`} download>
                      Descarcă exportul
                    </a>
                  ) : job.status === 'failed' ? (
                    <span className="acc-error">
                      {job.error || 'Exportul nu a reușit. Solicită un export nou.'}
                    </span>
                  ) : (
                    <span role="status">În pregătire…</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {state.role === 'owner' ? (
            <details className="acc-disclosure">
              <summary>Invită un colaborator</summary>
              <p>
                Invitația acordă acces acestei companii. Contul colaboratorului este creat de
                operatorul instanței.
              </p>
              <form
                className="acc-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void run(async () => {
                    const result = await command<{ token: string }>(`${path}/invitations`, {
                      email: field(data, 'email'),
                      role: field(data, 'role'),
                    });
                    setInviteLink(`${location.origin}/contabilitate#invite=${result.token}`);
                  }, 'Invitația este valabilă 48 de ore. Copiază linkul și trimite-l colaboratorului.');
                }}
              >
                <label>
                  Email
                  <input name="email" type="email" required />
                </label>
                <label>
                  Drept de acces
                  <select name="role">
                    <option value="reviewer">Introducere și revizuire</option>
                    <option value="viewer">Doar citire</option>
                  </select>
                </label>
                <button disabled={busy}>Creează invitația</button>
              </form>
              {inviteLink ? (
                <label>
                  Link de invitație
                  <input
                    readOnly
                    value={inviteLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
