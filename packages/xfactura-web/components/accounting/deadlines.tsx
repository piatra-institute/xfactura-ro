'use client';

import { useState } from 'react';
import type { ActionView } from 'xfactura-api/contracts';
import { ApiError, companyPath } from './api';
import { SectionLink, useAccountingNavigation } from './navigation';
import { ActorName, RecordNames } from './record-names';
import { ReviewedDeclarationAction } from './review';
import { useAccountingData } from './use-data';
import { EvidenceName, WorkDetails } from './work-details';
import { useWorkspace } from './workspace';
import { AccountingTime, monthLabel, useOpenedHeading } from './presentation';
import { D300Summary } from './d300-summary';

type Obligation = {
  kind: string;
  period: string;
  deadline: string;
  start: string;
  end: string;
  due: string | null;
  nominal: string | null;
  status: string;
  artifactId: string | null;
  versions: string[];
  gap: string | null;
  conflict: { due: string; nominal: string; clauses: string[]; text: string }[] | null;
  basis: { rule: string; facts: string[]; clauses: string[] };
  blockers: string[];
  waiting: number | null;
};
export type Declaration = {
  id: string;
  kind: string;
  period: string;
  format: string;
  state: string;
  evidenceId: string;
  xmlHash: string;
  supersedesId: string | null;
  steps: {
    state: string;
    actor: string | null;
    detail: string | null;
    evidenceId: string | null;
    at: string;
  }[];
};
type Parameter = { id: string; citations: { clause: string; source: string; locator: string }[] };
const states: Record<string, string> = {
  due: 'De pregătit',
  overdue: 'Termen depășit',
  blocked: 'Blocată',
  prepared: 'Pregătită',
  validation_failed: 'Validare nereușită',
  validated_official: 'Validată de validatorul ANAF',
  authorized: 'Autorizată pe XML-ul exact',
  exported_for_signing: 'PDF exportat pentru semnare',
  signed_imported: 'PDF semnat și importat',
  submitted: 'Depunere înregistrată',
  filed: 'Depunere înregistrată',
  accepted: 'Acceptată de ANAF',
  rejected: 'Respinsă de ANAF',
  superseded: 'Înlocuită',
};
const keyOf = (item: { kind: string; period: string }) => `${item.kind}|${item.period}`;
const raw = (data: FormData, name: string) => String(data.get(name) ?? '');
/** These registered preparations either have fields here or accept an empty options object. */
const preparations = new Set(['D300', 'D398', 'D406']);

export default function Deadlines() {
  const { can, year, refresh } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const month = params.get('month') ?? '';
  const selected = params.get('return');
  const calendarYear = year;
  const status = params.get('declarationStatus') ?? '';
  const calendar = useAccountingData<Obligation[]>(
    'obligations.calendar',
    {
      from: month || calendarYear?.from.slice(0, 7),
      to: month || calendarYear?.to.slice(0, 7),
    },
    can('obligations.calendar') && !!calendarYear,
    true,
  );
  const declarations = useAccountingData<Declaration[]>(
    'declarations.list',
    {},
    can('declarations.list'),
    true,
  );
  const shown = (calendar.data ?? []).filter(
    (item) =>
      !status ||
      (declarations.data?.find((artifact) => artifact.id === item.artifactId)?.state ??
        item.status) === status ||
      (status === 'submitted' && item.status === 'filed'),
  );
  const unavailable = calendar.unavailable || declarations.unavailable;
  return (
    <RecordNames>
      <div className="acc-section-heading">
        <h2>Termene</h2>
        <button className="acc-secondary" onClick={refresh}>
          Reîncarcă termenele
        </button>
      </div>
      <p className="acc-hint">
        Termenele și stările vin din motor. Pregătești declarația aici; semnarea și depunerea la
        ANAF au loc în afara aplicației.
      </p>
      <div className="acc-work-filters">
        <div className="acc-month-filter">
          <label>
            Luna încheierii perioadei
            <input
              type="month"
              value={month}
              onChange={(event) => filter({ month: event.target.value, return: null })}
            />
          </label>
          {month ? (
            <p className="acc-hint">
              Luna selectată: <time dateTime={month}>{monthLabel(month)}</time>
            </p>
          ) : null}
        </div>
        <label>
          Starea declarației
          <select
            value={status}
            onChange={(event) => filter({ declarationStatus: event.target.value })}
          >
            <option value="">Toate</option>
            {Object.entries(states)
              .filter(([key]) => !['filed', 'superseded'].includes(key))
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </label>
      </div>
      {month ? (
        <SectionLink section="deadlines" filters={{ month: null }}>
          Toate lunile exercițiului
        </SectionLink>
      ) : calendarYear ? (
        <p className="acc-hint">
          Perioade încheiate între {calendarYear.from} și {calendarYear.to}
        </p>
      ) : null}
      {!can('obligations.calendar') ? (
        <p className="acc-hint">Nu ai acces la calendarul obligațiilor.</p>
      ) : null}
      {calendar.loading || declarations.loading || !calendarYear ? (
        <p className="acc-hint" aria-busy="true">
          Se încarcă termenele și declarațiile…
        </p>
      ) : null}
      {calendar.error || declarations.error ? (
        <p role="alert" className="acc-error">
          {calendar.error || declarations.error} Reîncarcă termenele.
        </p>
      ) : null}
      {!calendar.unavailable && !shown.length ? (
        <p className="acc-empty">
          {status
            ? 'Nicio declarație pentru filtrele alese.'
            : 'Nimic de depus pentru perioadele alese.'}
        </p>
      ) : null}
      {selected && calendar.data && !shown.some((item) => keyOf(item) === selected) ? (
        <p role="status">Declarația selectată nu apare pentru perioadele și starea afișate.</p>
      ) : null}
      {shown.map((item) => (
        <ObligationRow
          key={keyOf(item)}
          item={item}
          artifacts={(declarations.data ?? []).filter(
            (artifact) => keyOf(artifact) === keyOf(item),
          )}
          open={selected === keyOf(item)}
          unavailable={unavailable}
        />
      ))}
    </RecordNames>
  );
}

function ObligationRow({
  item,
  artifacts,
  open,
  unavailable,
}: {
  item: Obligation;
  artifacts: Declaration[];
  open: boolean;
  unavailable: boolean;
}) {
  const { filter } = useAccountingNavigation();
  const heading = useOpenedHeading(open);
  const artifact = artifacts.find((artifact) => artifact.id === item.artifactId);
  return (
    <details className="acc-work-item acc-obligation" open={open} data-return={keyOf(item)}>
      <summary
        onClick={(event) => {
          // Only activation changes navigation; render-driven native toggle events can arrive late.
          event.preventDefault();
          filter({ return: open ? null : keyOf(item) });
        }}
      >
        <h3
          ref={heading}
          tabIndex={-1}
          className="acc-work-message acc-return-heading acc-opened-heading"
        >
          {item.kind} · {item.period}
        </h3>
        <span className="acc-work-meta">
          <span className={item.status === 'overdue' ? 'acc-error' : ''}>
            Termen: {item.due ?? 'necunoscut'}
          </span>
          <span>{states[artifact?.state ?? item.status] ?? 'Stare neindicată'}</span>
          <span>
            Perioadă: {item.start} — {item.end}
          </span>
        </span>
      </summary>
      {open ? (
        <div className="acc-work-body">
          <ObligationBasis item={item} />
          <ReturnLife item={item} artifacts={artifacts} unavailable={unavailable} />
        </div>
      ) : null}
    </details>
  );
}

function ObligationBasis({ item }: { item: Obligation }) {
  const { can } = useWorkspace();
  const parameters = useAccountingData<Parameter[]>(
    'rules.parameters',
    {},
    can('rules.parameters'),
    true,
  );
  const cited = parameters.data?.filter((parameter) => item.versions.includes(parameter.id));
  return (
    <>
      <dl className="acc-work-details">
        <div>
          <dt>Regula termenului</dt>
          <dd>{item.deadline}</dd>
        </div>
        <div>
          <dt>Termen nominal</dt>
          <dd>{item.nominal ?? 'Necunoscut'}</dd>
        </div>
        <div>
          <dt>Termen aplicabil</dt>
          <dd>{item.due ?? 'Necunoscut'}</dd>
        </div>
        <div>
          <dt>Regula obligației</dt>
          <dd>{item.basis.rule}</dd>
        </div>
        <div>
          <dt>Faptele citite de motor</dt>
          <dd>
            <ul>
              {item.basis.facts.map((fact, index) => (
                <li key={index}>{fact}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Clauzele obligației</dt>
          <dd>
            <ul>
              {item.basis.clauses.map((clause) => (
                <li key={clause}>{clause}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      {cited?.length ? (
        <div className="acc-deadline-citations">
          <h4>Sursele termenului</h4>
          <ul>
            {cited.flatMap((parameter) =>
              parameter.citations.map((citation, index) => (
                <li key={`${parameter.id}:${index}`}>
                  {citation.source} · {citation.locator} · {citation.clause}
                </li>
              )),
            )}
          </ul>
        </div>
      ) : item.versions.length ? (
        <p className="acc-hint">
          {parameters.loading
            ? 'Se încarcă sursele termenului…'
            : 'Sursele versiunilor termenului nu sunt disponibile.'}
        </p>
      ) : null}
      {parameters.error ? <p className="acc-error">{parameters.error}</p> : null}
      {item.conflict?.map((reading, index) => (
        <div className="acc-warning acc-filing-note" key={index}>
          <p>{reading.text}</p>
          <p>
            Termen: {reading.due} · termen nominal: {reading.nominal}
          </p>
          <ul>
            {reading.clauses.map((clause) => (
              <li key={clause}>{clause}</li>
            ))}
          </ul>
        </div>
      ))}
      {item.gap ? (
        <div className="acc-filing-note">
          <h4>Ce blochează declarația</h4>
          <p className="acc-error">{item.gap}</p>
          {item.waiting ? (
            <p>Regulile pentru {item.waiting} așteaptă verificarea expertului contabil.</p>
          ) : null}
          <SectionLink section="questions">Deschide Întrebări</SectionLink>
        </div>
      ) : null}
      <WorkDetails value={{ versions: item.versions, blockers: item.blockers }} />
    </>
  );
}

function ReturnLife({
  item,
  artifacts,
  unavailable,
}: {
  item: Obligation;
  artifacts: Declaration[];
  unavailable: boolean;
}) {
  const { company, can, invoke, upload, act, refresh } = useWorkspace();
  const actions = useAccountingData<ActionView[]>(
    'actions.list',
    { limit: 200 },
    can('actions.list'),
    true,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{
    code?: string;
    message: string;
    details?: unknown;
  } | null>(null);
  const [requested, setRequested] = useState<ActionView | null>(null);
  const [pdf, setPdf] = useState<{ artifactId: string; evidenceId: string } | null>(null);
  const current =
    artifacts.find((artifact) => artifact.id === item.artifactId) ??
    artifacts.findLast((artifact) => artifact.state !== 'superseded');
  const disabled = busy || unavailable;
  const latest = (kind: string) =>
    (actions.data ?? [])
      .filter(
        (action) =>
          action.operation === kind &&
          action.input &&
          typeof action.input === 'object' &&
          !Array.isArray(action.input) &&
          action.input.artifactId === current?.id,
      )
      .at(-1);
  const currentRequest =
    requested?.input &&
    typeof requested.input === 'object' &&
    !Array.isArray(requested.input) &&
    requested.input.artifactId === current?.id
      ? requested
      : null;
  const authorization =
    currentRequest?.operation === 'declarations.authorize'
      ? currentRequest
      : latest('declarations.authorize');
  const reopening =
    currentRequest?.operation === 'declarations.reopen'
      ? currentRequest
      : latest('declarations.reopen');
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setProblem(null);
    const succeeded = await act(async () => {
      try {
        await action();
      } catch (reason) {
        setProblem({
          code: reason instanceof ApiError ? reason.code : undefined,
          message: reason instanceof Error ? reason.message : 'Operațiunea nu a reușit.',
          details: reason instanceof ApiError ? reason.details : undefined,
        });
        throw reason;
      }
    }, success);
    if (!succeeded) refresh();
    setBusy(false);
  };
  const request = (operation: string, input: Record<string, unknown>) =>
    run(async () => {
      setRequested(await invoke<ActionView>(operation, input));
    }, 'Previzualizarea a fost pregătită pentru verificare.');
  const fileEvidence = async (data: FormData, name: string) => {
    const file = data.get(name);
    if (!(file instanceof File) || !file.size) throw new Error('Alege documentul justificativ.');
    return (await upload(file)).id;
  };
  return (
    <section
      className="acc-return-life"
      aria-label={`Parcursul declarației ${item.kind} ${item.period}`}
      aria-busy={busy}
    >
      <h3>Parcursul declarației</h3>
      {problem ? (
        <div className="acc-filing-note">
          <p role="alert" className="acc-error">
            {problem.code ? `${problem.code}: ` : ''}
            {problem.message}
          </p>
          {problem.details ? <WorkDetails value={problem.details} /> : null}
        </div>
      ) : null}
      {current ? (
        <>
          <p className="acc-hint">
            {states[current.state] ?? current.state} · format {current.format}
          </p>
          <p>
            XML-ul pregătit: <EvidenceName id={current.evidenceId} />
          </p>
          <DeclarationHistory artifact={current} />
        </>
      ) : (
        <p className="acc-hint">
          Nu există o declarație pregătită în motor pentru această perioadă.
        </p>
      )}
      {artifacts
        .filter((artifact) => artifact.id !== current?.id)
        .map((artifact) => (
          <details key={artifact.id} className="acc-disclosure">
            <summary>
              Versiune anterioară ·{' '}
              {artifact.steps[0] ? <AccountingTime instant={artifact.steps[0].at} /> : null} ·{' '}
              {states[artifact.state] ?? artifact.state}
            </summary>
            <p>
              XML: <EvidenceName id={artifact.evidenceId} />
            </p>
            <DeclarationHistory artifact={artifact} />
          </details>
        ))}
      {!preparations.has(item.kind) ? (
        <p className="acc-hint">
          Pregătirea declarației {item.kind} necesită detalii pe care această interfață nu le
          colectează.
        </p>
      ) : null}
      {preparations.has(item.kind) && can('declarations.prepare') && !current ? (
        <div className="acc-filing-action">
          <p>
            Pregătirea calculează declarația din registre și păstrează XML-ul. Motorul verifică
            formatul și regulile perioadei.
          </p>
          <DeclarationPreparation
            kind={item.kind}
            disabled={disabled}
            submit={(options) =>
              run(
                () =>
                  invoke('declarations.prepare', { kind: item.kind, period: item.period, options }),
                'Declarația a fost pregătită.',
              )
            }
          />
        </div>
      ) : null}
      {current?.state === 'prepared' && can('declarations.validate') ? (
        <div className="acc-filing-action">
          <p>Validarea rulează validatorul oficial ANAF pe XML-ul pregătit.</p>
          <button
            disabled={disabled}
            onClick={() =>
              run(
                () => invoke('declarations.validate', { artifactId: current.id }),
                'Rezultatul validării a fost păstrat.',
              )
            }
          >
            Validează cu validatorul ANAF
          </button>
        </div>
      ) : null}
      {current?.state === 'validated_official' && can('declarations.authorize.request') ? (
        <div className="acc-filing-action">
          <p>Verifică exact XML-ul care va fi autorizat și blocajele raportate de motor.</p>
          <button
            className="acc-secondary"
            disabled={disabled}
            onClick={() => request('declarations.authorize.request', { artifactId: current.id })}
          >
            Cere previzualizarea autorizării
          </button>
        </div>
      ) : null}
      {authorization &&
      current &&
      ['validated_official', 'prepared', 'validation_failed'].includes(current.state) ? (
        <ReviewedDeclarationAction
          key={authorization.id}
          id={authorization.id}
          disabled={disabled}
        />
      ) : null}
      {current &&
      ['authorized', 'exported_for_signing'].includes(current.state) &&
      can('declarations.pdf') ? (
        <div className="acc-filing-action">
          <p>
            Motorul produce PDF-ul din XML-ul autorizat, prin instrumentul ANAF. Descarcă-l pentru
            semnare în afara aplicației.
          </p>
          <button
            disabled={disabled}
            onClick={() =>
              run(async () => {
                const artifact = await invoke<Declaration>('declarations.pdf', {
                  artifactId: current.id,
                });
                const evidenceId = artifact.steps.findLast(
                  (step) => step.state === 'exported_for_signing',
                )?.evidenceId;
                if (!evidenceId) throw new Error('Motorul nu a indicat PDF-ul exportat.');
                setPdf({ artifactId: artifact.id, evidenceId });
                const response = await fetch(
                  `${companyPath(company.id)}/evidence/${encodeURIComponent(evidenceId)}`,
                  { credentials: 'same-origin', cache: 'no-store' },
                );
                if (!response.ok)
                  throw new Error(
                    'PDF-ul a fost produs, dar descărcarea nu a reușit. Folosește documentul din parcursul declarației.',
                  );
                const url = URL.createObjectURL(await response.blob());
                const link = document.createElement('a');
                link.href = url;
                link.download = `${artifact.kind}-${artifact.period}.pdf`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }, 'PDF-ul a fost exportat pentru semnare.')
            }
          >
            Descarcă PDF-ul pentru semnare
          </button>
        </div>
      ) : null}
      {pdf && pdf.artifactId === current?.id ? (
        <p>
          PDF exportat: <EvidenceName id={pdf.evidenceId} />
        </p>
      ) : null}
      {current?.state === 'exported_for_signing' &&
      can('declarations.importSigned') &&
      can('evidence.record') ? (
        <form
          className="acc-form acc-filing-action"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const evidenceId = await fileEvidence(data, 'signed');
              await invoke('declarations.importSigned', { artifactId: current.id, evidenceId });
            }, 'PDF-ul semnat a fost păstrat și importat.');
          }}
        >
          <p>
            PDF-ul semnat se păstrează ca document justificativ. Motorul verifică prezența
            semnăturii și a XML-ului autorizat atașat.
          </p>
          <label>
            PDF semnat
            <input type="file" name="signed" accept="application/pdf,.pdf" required />
          </label>
          <button disabled={disabled}>Păstrează și importă PDF-ul semnat</button>
        </form>
      ) : null}
      {current?.state === 'signed_imported' &&
      can('declarations.recordSubmission') &&
      can('evidence.record') ? (
        <form
          className="acc-form acc-filing-action"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const receiptEvidenceId = await fileEvidence(data, 'receipt');
              await invoke('declarations.recordSubmission', {
                artifactId: current.id,
                registrationNumber: raw(data, 'registrationNumber'),
                submittedOn: raw(data, 'submittedOn'),
                receiptEvidenceId,
              });
            }, 'Depunerea și recipisa au fost înregistrate.');
          }}
        >
          <p>
            Înregistrează o depunere făcută în afara aplicației, pe baza recipisei. Această acțiune
            nu trimite declarația la ANAF.
          </p>
          <label>
            Număr de înregistrare
            <input name="registrationNumber" required maxLength={60} />
          </label>
          <label>
            Data depunerii
            <input name="submittedOn" type="date" required />
          </label>
          <label>
            Recipisa depunerii
            <input name="receipt" type="file" required />
          </label>
          <button disabled={disabled}>Înregistrează depunerea și recipisa</button>
        </form>
      ) : null}
      {current?.state === 'submitted' &&
      can('declarations.recordOutcome') &&
      can('evidence.record') ? (
        <form
          className="acc-form acc-filing-action"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const evidenceId = await fileEvidence(data, 'outcomeReceipt');
              await invoke('declarations.recordOutcome', {
                artifactId: current.id,
                outcome: raw(data, 'outcome'),
                evidenceId,
                ...(raw(data, 'detail') ? { detail: raw(data, 'detail') } : {}),
              });
            }, 'Răspunsul ANAF și documentul lui au fost înregistrate.');
          }}
        >
          <p>
            Înregistrează răspunsul primit de la ANAF și păstrează documentul care îl dovedește.
          </p>
          <label>
            Răspuns ANAF
            <select name="outcome" required defaultValue="">
              <option value="">Alege</option>
              <option value="accepted">Acceptată</option>
              <option value="rejected">Respinsă</option>
            </select>
          </label>
          <label>
            Documentul răspunsului ANAF
            <input type="file" name="outcomeReceipt" required />
          </label>
          <label>
            Mesajul ANAF (opțional)
            <textarea name="detail" maxLength={4000} />
          </label>
          <button disabled={disabled}>Înregistrează răspunsul ANAF</button>
        </form>
      ) : null}
      {current &&
      ['authorized', 'exported_for_signing', 'signed_imported', 'accepted', 'rejected'].includes(
        current.state,
      ) &&
      can('declarations.reopen.request') ? (
        <details className="acc-disclosure">
          <summary>Redeschide perioada pentru corectare</summary>
          <form
            className="acc-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void request('declarations.reopen.request', {
                artifactId: current.id,
                reason: raw(data, 'reason'),
              });
            }}
          >
            <p>Solicită o decizie revizuită pentru deblocarea perioadei fiscale a declarației.</p>
            <label>
              Motivul redeschiderii
              <input name="reason" required minLength={10} maxLength={1000} />
            </label>
            <button className="acc-secondary" disabled={disabled}>
              Cere previzualizarea redeschiderii
            </button>
          </form>
        </details>
      ) : null}
      {reopening ? (
        <ReviewedDeclarationAction key={reopening.id} id={reopening.id} disabled={disabled} />
      ) : null}
      {actions.error ? (
        <p role="alert" className="acc-error">
          {actions.error} Cererile de aprobare nu au putut fi încărcate.
        </p>
      ) : null}
      {preparations.has(item.kind) &&
      current &&
      [
        'prepared',
        'validation_failed',
        'validated_official',
        'authorized',
        'exported_for_signing',
        'signed_imported',
        'accepted',
        'rejected',
      ].includes(current.state) &&
      can('declarations.prepare') ? (
        <details className="acc-disclosure">
          <summary>Pregătește o versiune nouă</summary>
          <div className="acc-filing-action">
            <p>
              Motorul recalculează din registre și leagă noua versiune de declarația înlocuită. Noua
              versiune are propriul parcurs de validare și autorizare.
            </p>
            <DeclarationPreparation
              kind={item.kind}
              disabled={disabled}
              replacement
              submit={(options) =>
                run(async () => {
                  await invoke('declarations.prepare', {
                    kind: item.kind,
                    period: item.period,
                    supersedesId: current.id,
                    options,
                  });
                  setRequested(null);
                  setPdf(null);
                }, 'Noua versiune a declarației a fost pregătită.')
              }
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** Required identity options belong to D300; D398 and D406 accept empty options. */
function DeclarationPreparation({
  kind,
  disabled,
  replacement = false,
  submit,
}: {
  kind: string;
  disabled: boolean;
  replacement?: boolean;
  submit: (options: Record<string, unknown>) => Promise<void>;
}) {
  if (!preparations.has(kind)) return null;
  return (
    <form
      className="acc-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const options: Record<string, unknown> = {};
        if (kind === 'D300') {
          options.declarant = {
            lastName: raw(data, 'lastName'),
            firstName: raw(data, 'firstName'),
            role: raw(data, 'role'),
          };
          for (const field of ['caen', 'bank', 'account', 'phone', 'email', 'proRata'])
            if (raw(data, field)) options[field] = raw(data, field);
          if (raw(data, 'refundRequested'))
            options.refundRequested = raw(data, 'refundRequested') === 'true';
        }
        void submit(options);
      }}
    >
      {kind === 'D300' ? (
        <fieldset disabled={disabled} className="acc-preparation-fields">
          <legend>Identificarea declarantului D300</legend>
          <div className="acc-form-grid">
            <label>
              Nume declarant
              <input name="lastName" required maxLength={75} />
            </label>
            <label>
              Prenume declarant
              <input name="firstName" required maxLength={75} />
            </label>
            <label>
              Funcția declarantului
              <input name="role" required maxLength={50} />
            </label>
            <label>
              Cod CAEN
              <input name="caen" inputMode="numeric" required pattern="[0-9]{4}" />
            </label>
            <label>
              Bancă
              <input name="bank" required maxLength={50} />
            </label>
            <label>
              Cont bancar
              <input name="account" required maxLength={50} />
            </label>
            <label>
              Telefon (opțional)
              <input name="phone" type="tel" maxLength={15} />
            </label>
            <label>
              Email (opțional)
              <input name="email" type="email" maxLength={200} />
            </label>
            <label>
              Prorată (%) (opțional)
              <input name="proRata" inputMode="decimal" className="acc-decimal-input" />
            </label>
            <label>
              Sold negativ (opțional)
              <select name="refundRequested" defaultValue="">
                <option value="">Folosește răspunsul păstrat în motor</option>
                <option value="true">Solicit rambursarea</option>
                <option value="false">Reportez soldul</option>
              </select>
            </label>
          </div>
        </fieldset>
      ) : null}
      <button disabled={disabled}>
        {replacement ? 'Pregătește versiunea care o înlocuiește' : 'Pregătește declarația'}
      </button>
    </form>
  );
}

function DeclarationHistory({ artifact }: { artifact: Declaration }) {
  return (
    <>
      <ol className="acc-declaration-history" aria-label="Etapele declarației">
        {artifact.steps.map((step, index) => (
          <li key={index} data-declaration-state={step.state}>
            <h4>{states[step.state] ?? step.state}</h4>
            <p className="acc-hint">
              <AccountingTime instant={step.at} /> ·{' '}
              {step.state === 'submitted' && step.actor ? (
                `Număr de înregistrare: ${step.actor}`
              ) : ['validation_failed', 'validated_official', 'exported_for_signing'].includes(
                  step.state,
                ) && step.actor ? (
                `Instrument: ${step.actor}`
              ) : (
                <ActorName person={step.actor} />
              )}
            </p>
            {step.detail ? (
              step.state === 'prepared' ? (
                <PreparedDetail detail={step.detail} kind={artifact.kind} />
              ) : (
                <p
                  className={
                    step.state === 'validation_failed' || step.state === 'rejected'
                      ? 'acc-error acc-engine-message'
                      : 'acc-engine-message'
                  }
                >
                  {step.detail}
                </p>
              )
            ) : null}
            {step.evidenceId ? (
              <p>
                Document păstrat: <EvidenceName id={step.evidenceId} />
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <WorkDetails
        value={{}}
        technical={{ steps: artifact.steps.map(({ state, at }) => ({ state, at })) }}
      />
    </>
  );
}
function PreparedDetail({ detail, kind }: { detail: string; kind: string }) {
  try {
    const value: unknown = JSON.parse(detail);
    return kind === 'D300' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) ? (
      <D300Summary summary={value as Record<string, unknown>} />
    ) : (
      <WorkDetails value={value} />
    );
  } catch {
    return <p className="acc-engine-message">{detail}</p>;
  }
}
