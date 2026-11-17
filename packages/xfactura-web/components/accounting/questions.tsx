'use client';

import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { ProposalView } from 'xfactura-api/contracts';
import { canonical } from 'xfactura-core/hash';
import { questionKind } from 'xfactura-core/questions/kinds';
import { SectionLink, useAccountingNavigation } from './navigation';
import { answerVariants, enteredAnswer, questionLabels } from './question-schema';
import { ActorName, RecordNames, StockItemName, useSubjectName, withoutIds } from './record-names';
import { AccountingTime, useOpenedHeading } from './presentation';
import { readPages, useAccountingData } from './use-data';
import { DocumentName, EvidenceName, WorkDetails } from './work-details';
import { treatmentLabels, type WorkItem } from './work-model';
import { DateField, MonthField } from './ui';
import { useWorkspace } from './workspace';

export type Question = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  params: Record<string, unknown>;
  prompt: string;
  status: 'open' | 'answered' | 'withdrawn';
  askedBy: string;
  agentId: string | null;
  createdAt: string;
  due: string | null;
  answer: {
    id: string;
    value: unknown;
    redacted?: true;
    evidenceId: string;
    answeredBy: string;
    at: string;
  } | null;
};
const statuses = { open: 'Deschisă', answered: 'Cu răspuns', withdrawn: 'Retrasă' };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sameRequest(request: unknown, question: Question) {
  return (
    record(request) &&
    request.kind === question.kind &&
    record(request.subject) &&
    request.subject.kind === question.subject.kind &&
    request.subject.id === question.subject.id &&
    (questionKind(question.kind)?.holds === 'untilChanged' ||
      (record(request.params) && canonical(request.params) === canonical(question.params)))
  );
}

/** Read dependencies from engine issues and retained answer citations, never infer a fiscal effect. */
function dependsOn(proposal: ProposalView, question: Question) {
  return (
    proposal.basis?.answers.some((answer) => answer.questionId === question.id) ||
    proposal.issues.some((issue) => {
      const request = issue.details && record(issue.details) ? issue.details.question : null;
      return sameRequest(request, question);
    })
  );
}

export default function Questions() {
  const { can, refresh } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const questions = useAccountingData<Question[]>(
    'questions.list',
    { limit: 200 },
    can('questions.list'),
    true,
  );
  const proposals = useAccountingData<ProposalView[]>(
    'proposals.list',
    { limit: 200, withInput: true },
    can('proposals.list'),
    true,
  );
  const work = useAccountingData<WorkItem[]>(
    'work.list',
    { limit: 200 },
    can('work.list') && !!questions.data?.length,
    true,
  );
  const status = params.get('questionStatus') ?? '';
  const kind = params.get('questionKind') ?? '';
  const selected = params.get('question');
  const shown = (questions.data ?? [])
    .filter(
      (question) => (!status || question.status === status) && (!kind || question.kind === kind),
    )
    .toSorted(
      (a, b) =>
        Number(b.status === 'open') - Number(a.status === 'open') ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return (
    <RecordNames>
      <div className="acc-section-tools">
        <button className="acc-secondary" onClick={refresh}>
          Reîncarcă întrebările
        </button>
      </div>
      <div className="acc-work-filters">
        <label>
          Starea întrebării
          <select
            value={status}
            onChange={(event) => filter({ questionStatus: event.target.value })}
          >
            <option value="">Toate</option>
            {Object.entries(statuses).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipul întrebării
          <select value={kind} onChange={(event) => filter({ questionKind: event.target.value })}>
            <option value="">Toate</option>
            {Object.entries(questionLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!can('questions.list') ? (
        <p className="acc-hint">Nu ai acces la întrebările companiei.</p>
      ) : null}
      {questions.loading ? (
        <p aria-busy="true" className="acc-hint">
          Se încarcă întrebările…
        </p>
      ) : null}
      {questions.error ? (
        <p role="alert" className="acc-error">
          {questions.error} Reîncarcă întrebările.
        </p>
      ) : null}
      {proposals.error ? (
        <p role="alert" className="acc-error">
          {proposals.error} Dependențele propunerilor nu au putut fi citite.
        </p>
      ) : null}
      {work.error ? (
        <p role="alert" className="acc-error">
          {work.error} Elementele care așteaptă răspunsul nu au putut fi citite.
        </p>
      ) : null}
      {!questions.unavailable && !shown.length ? (
        <p className="acc-empty">
          {status || kind ? 'Nicio întrebare pentru filtrele alese.' : 'Nu sunt întrebări.'}
        </p>
      ) : null}
      {selected &&
      questions.data &&
      !questions.data.some((question) => question.id === selected) ? (
        <p role="status">Întrebarea nu este disponibilă în această companie.</p>
      ) : null}
      {shown.map((question, index) => (
        <Fragment key={question.id}>
          {index === 0 || (question.status !== 'open' && shown[index - 1]?.status === 'open') ? (
            <h2 className="acc-spaced">
              {question.status === 'open' ? 'Așteaptă răspuns' : 'Răspunsuri și retrageri'}
            </h2>
          ) : null}
          <QuestionCard
            question={question}
            selected={selected === question.id}
            unavailable={questions.unavailable}
            proposals={proposals.data}
            work={work.data}
          />
        </Fragment>
      ))}
    </RecordNames>
  );
}

function QuestionCard({
  question,
  selected,
  unavailable,
  proposals,
  work,
}: {
  question: Question;
  selected: boolean;
  unavailable: boolean;
  proposals: ProposalView[] | null;
  work: WorkItem[] | null;
}) {
  const { can, invoke, act } = useWorkspace();
  const { filter } = useAccountingNavigation();
  const subject = useSubjectName(question.subject);
  const heading = useOpenedHeading(selected);
  const [busy, setBusy] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const [impact, setImpact] = useState<ProposalView[] | null>(null);
  const [impactError, setImpactError] = useState('');
  const variants = answerVariants(question.kind, question.params);
  const waiting = proposals?.filter(
    (proposal) =>
      !['posted', 'withdrawn'].includes(proposal.status) && dependsOn(proposal, question),
  );
  const otherWaiting = work?.filter(
    (item) =>
      item.subject.kind !== 'question' &&
      !waiting?.some((proposal) => proposal.id === item.subject.id) &&
      (item.next.some((step) => step.inputHint.questionId === question.id) ||
        sameRequest(item.details.question, question) ||
        (Array.isArray(item.details.questions) &&
          item.details.questions.some(
            (entry) => record(entry) && entry.questionId === question.id,
          ))),
  );
  const changedByAnswer =
    impact?.filter(
      (proposal) =>
        proposal.check?.stale &&
        proposal.check.changed.some(
          (change) => change.kind === 'answer' && change.id === question.id,
        ),
    ) ?? [];
  const answer = async (value: Record<string, unknown>) => {
    setBusy(true);
    setImpact(null);
    setImpactError('');
    setAnswerError('');
    await act(
      async () => {
        await invoke('questions.answer', { questionId: question.id, value });
        filter({ question: question.id, questionStatus: null });
        try {
          const candidates = await readPages<ProposalView>(invoke, 'proposals.list', {
            limit: 200,
            withInput: true,
          });
          const citing = candidates.filter(
            (proposal) =>
              !['posted', 'withdrawn'].includes(proposal.status) &&
              proposal.basis?.answers.some((answer) => answer.questionId === question.id),
          );
          setImpact(
            await Promise.all(
              citing.map((proposal) =>
                invoke<ProposalView>('proposals.get', { id: proposal.id, recheck: true }),
              ),
            ),
          );
        } catch (reason) {
          setImpactError(
            reason instanceof Error ? reason.message : 'Propunerile nu au putut fi verificate.',
          );
        }
      },
      'Răspunsul a fost păstrat ca document justificativ.',
      (reason) => {
        setAnswerError(
          reason instanceof Error ? reason.message : 'Răspunsul nu a putut fi păstrat.',
        );
      },
    );
    setBusy(false);
  };
  const prompt = withoutIds(
    ['vehicle', 'account', 'year', 'vatPeriod'].includes(question.subject.kind)
      ? question.prompt
      : question.prompt.replaceAll(question.subject.id, subject.name),
  );
  return (
    <article className="acc-question" data-question-id={question.id} aria-busy={busy}>
      <div className="acc-section-heading">
        <h3 ref={heading} tabIndex={-1} className="acc-opened-heading">
          {questionLabels[question.kind] ?? 'Întrebare pentru o persoană'}
        </h3>
        <span className="acc-status">{statuses[question.status]}</span>
      </div>
      <p>{prompt}</p>
      <dl className="acc-work-details">
        <div>
          <dt>Despre</dt>
          <dd>{subject.name}</dd>
        </div>
        <div>
          <dt>Întrebat de</dt>
          <dd>
            <ActorName person={question.askedBy} agent={question.agentId} /> ·{' '}
            <AccountingTime instant={question.createdAt} />
          </dd>
        </div>
        {question.due ? (
          <div>
            <dt>Răspuns necesar până la</dt>
            <dd>
              <time>{question.due}</time>
            </dd>
          </div>
        ) : null}
      </dl>
      {subject.error ? <p className="acc-error">{subject.error}</p> : null}
      {typeof question.params.documentId === 'string' ? (
        <p className="acc-hint">
          Documentul care a ridicat întrebarea: <DocumentName id={question.params.documentId} />
        </p>
      ) : null}
      <div className="acc-question-waiting">
        <strong>Ce așteaptă răspunsul</strong>
        {waiting || otherWaiting ? (
          waiting?.length || otherWaiting?.length ? (
            <ul>
              {waiting?.map((proposal) => (
                <li key={proposal.id}>
                  {proposal.effect?.description ??
                    treatmentLabels[proposal.treatment] ??
                    'Propunere contabilă'}{' '}
                  · versiunea {proposal.version}
                </li>
              ))}
              {otherWaiting?.map((item) => (
                <li key={item.id}>
                  {item.kind === 'obligation.due' ? (
                    <SectionLink
                      section="deadlines"
                      filters={{ return: item.subject.id, month: null, declarationStatus: null }}
                    >
                      Declarația {String(item.details.kind)} · {item.period}
                    </SectionLink>
                  ) : (
                    withoutIds(item.message)
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="acc-hint">Niciun element deschis nu indică această întrebare.</p>
          )
        ) : (
          <p className="acc-hint">Dependențele nu sunt disponibile.</p>
        )}
      </div>
      {impact !== null ? (
        <div role="status" className="acc-answer-impact">
          {changedByAnswer.length ? (
            <>
              <p>
                Răspunsul a schimbat propunerile care îl citează. Motorul le marchează ca depășite;
                este necesară revizuirea lor.
              </p>
              <ul>
                {changedByAnswer.map((proposal) => (
                  <li key={proposal.id}>
                    {proposal.effect?.description ??
                      treatmentLabels[proposal.treatment] ??
                      'Propunere contabilă'}{' '}
                    · versiunea {proposal.version} · depășită
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>Motorul nu a raportat propuneri depășite care citează acest răspuns.</p>
          )}
          <SectionLink section="review">Deschide De verificat</SectionLink>
        </div>
      ) : null}
      {impactError ? (
        <p role="alert" className="acc-error">
          Răspunsul este păstrat. {impactError} Reîncarcă întrebările pentru a verifica
          dependențele.
        </p>
      ) : null}
      <SectionLink section="questions" filters={{ question: selected ? null : question.id }}>
        {selected
          ? 'Închide întrebarea'
          : question.answer
            ? 'Vezi răspunsul'
            : question.status === 'withdrawn'
              ? 'Vezi întrebarea retrasă'
              : 'Răspunde la întrebare'}
      </SectionLink>
      {selected ? (
        <div className="acc-question-body">
          {question.answer ? (
            <>
              <h4>Răspuns păstrat</h4>
              <p className="acc-hint">
                <ActorName person={question.answer.answeredBy} /> ·{' '}
                <AccountingTime instant={question.answer.at} />
              </p>
              {question.answer.redacted ? (
                <p>Răspunsul conține date cu acces restricționat.</p>
              ) : (
                <AnswerValue question={question} />
              )}
              <p>
                <EvidenceName id={question.answer.evidenceId} />
              </p>
              <WorkDetails
                value={{}}
                technical={{ createdAt: question.createdAt, answeredAt: question.answer.at }}
              />
            </>
          ) : null}
          {question.status !== 'withdrawn' &&
          !question.answer?.redacted &&
          can('questions.answer') ? (
            variants ? (
              <>
                <h4>{question.answer ? 'Înlocuiește răspunsul' : 'Răspunsul persoanei'}</h4>
                <AnswerForm
                  key={`${question.id}:${question.answer?.id ?? 'open'}`}
                  variants={variants}
                  busy={busy || unavailable}
                  error={answerError}
                  answer={answer}
                />
                {variants.some((variant) =>
                  variant.fields.some((field) => ['evidence', 'evidenceIds'].includes(field.type)),
                ) ? (
                  <UploadAnswerEvidence disabled={busy || unavailable} />
                ) : null}
              </>
            ) : (
              <p className="acc-hint">
                Schema acestui tip de întrebare nu poate fi redată prin câmpurile disponibile.
                Răspunsul nu poate fi introdus în această interfață.
              </p>
            )
          ) : null}
          {question.status === 'open' && can('questions.withdraw') ? (
            <details className="acc-disclosure">
              <summary>Retrage întrebarea</summary>
              <form
                className="acc-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
                  setBusy(true);
                  await act(
                    () => invoke('questions.withdraw', { questionId: question.id, reason }),
                    'Întrebarea a fost retrasă cu motivul indicat.',
                  );
                  setBusy(false);
                }}
              >
                <p className="acc-hint">
                  Retragerea închide întrebarea fără răspuns. Motivul se păstrează în motor.
                </p>
                <label>
                  Motivul retragerii
                  <input name="reason" required minLength={10} maxLength={1000} />
                </label>
                <button className="acc-secondary" disabled={busy || unavailable}>
                  Retrage întrebarea fără răspuns
                </button>
              </form>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function AnswerForm({
  variants,
  busy,
  answer,
  error,
}: {
  variants: NonNullable<ReturnType<typeof answerVariants>>;
  busy: boolean;
  answer: (value: Record<string, unknown>) => Promise<void>;
  error: string;
}) {
  const { evidence, can } = useWorkspace();
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const [variant, setVariant] = useState('0');
  const fields = variants[Number(variant)]!.fields;
  const facts = useAccountingData<
    { id: string; axis: string; value: string; effectiveFrom: string }[]
  >('profile.read', {}, fields.some((field) => field.type === 'fact') && can('profile.read'), true);
  const items = useAccountingData<{ id: string; name: string }[]>(
    'stock.items.list',
    {},
    fields.some((field) => field.type === 'item') && can('stock.items.list'),
    true,
  );
  return (
    <form
      className="acc-form"
      aria-describedby={error ? errorId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void answer(enteredAnswer(fields, new FormData(event.currentTarget)));
      }}
    >
      <fieldset disabled={busy}>
        <legend className="acc-hint">
          Fiecare valoare este trimisă motorului așa cum o introduci.
        </legend>
        {variants.length > 1 ? (
          <label>
            Felul răspunsului
            <select value={variant} onChange={(event) => setVariant(event.target.value)}>
              {variants.map((choice, index) => (
                <option key={index} value={index}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="acc-form-grid" key={variant}>
          {fields.map((field) => {
            const options =
              field.type === 'evidence' || field.type === 'evidenceIds'
                ? evidence.map((file) => ({ value: file.id, label: file.filename }))
                : field.type === 'fact'
                  ? (facts.data ?? []).map((fact) => ({
                      value: fact.id,
                      label: `${fact.axis} · ${fact.value} · ${fact.effectiveFrom}`,
                    }))
                  : field.type === 'item'
                    ? (items.data ?? []).map((item) => ({ value: item.id, label: item.name }))
                    : field.options;
            const label = `${field.label}${!field.required ? ` (${field.condition ?? 'opțional'})` : ''}`;
            if (field.type === 'date')
              return (
                <DateField
                  key={field.name}
                  label={label}
                  name={field.name}
                  isRequired={field.required}
                  isDisabled={busy}
                />
              );
            if (field.type === 'month')
              return (
                <MonthField
                  key={field.name}
                  label={label}
                  name={field.name}
                  isRequired={field.required}
                  isDisabled={busy}
                />
              );
            return (
              <label key={field.name}>
                {label}
                {options ? (
                  <select
                    name={field.name}
                    required={field.required}
                    multiple={field.type === 'evidenceIds'}
                    defaultValue={field.type === 'evidenceIds' ? [] : ''}
                  >
                    {field.type !== 'evidenceIds' ? <option value="">Alege</option> : null}
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name={field.name}
                    type={field.type === 'integer' ? 'number' : field.type}
                    inputMode={field.decimal ? 'decimal' : undefined}
                    className={field.decimal ? 'acc-decimal-input' : undefined}
                    required={field.required}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    min={field.min}
                    max={field.max}
                    step={field.type === 'integer' ? 1 : undefined}
                  />
                )}
              </label>
            );
          })}
        </div>
        {facts.error || items.error ? (
          <p role="alert" className="acc-error">
            {facts.error || items.error}
          </p>
        ) : null}
        <button type="submit">{busy ? 'Se păstrează…' : 'Păstrează răspunsul'}</button>
      </fieldset>
      {error ? (
        <p
          id={errorId}
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="acc-error acc-form-error"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

function AnswerValue({ question }: { question: Question }) {
  const { evidence } = useWorkspace();
  const variants = answerVariants(question.kind, question.params);
  const value = question.answer?.value;
  if (!variants || !record(value)) return <WorkDetails value={value} />;
  const fields = variants.find((variant) =>
    Object.keys(value).every((key) => variant.fields.some((field) => field.name === key)),
  )?.fields;
  if (!fields) return <WorkDetails value={value} />;
  return (
    <dl className="acc-work-details">
      {fields
        .filter((field) => value[field.name] !== undefined)
        .map((field) => {
          const entry = value[field.name];
          return (
            <div key={field.name}>
              <dt>{field.label}</dt>
              <dd className={field.decimal ? 'acc-decimal-input' : undefined}>
                {field.type === 'item' ? (
                  <StockItemName id={String(entry)} />
                ) : field.type === 'evidence' ? (
                  <EvidenceName id={String(entry)} />
                ) : field.type === 'evidenceIds' && Array.isArray(entry) ? (
                  entry
                    .map(
                      (id) =>
                        evidence.find((file) => file.id === id)?.filename ??
                        'Document indisponibil',
                    )
                    .join(' · ') || 'Niciun document'
                ) : (
                  (field.options?.find((option) => option.value === String(entry))?.label ??
                  (typeof entry === 'boolean' ? (entry ? 'Da' : 'Nu') : withoutIds(String(entry))))
                )}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}

function UploadAnswerEvidence({ disabled }: { disabled: boolean }) {
  const { upload, act } = useWorkspace();
  const [busy, setBusy] = useState(false);
  return (
    <details className="acc-disclosure">
      <summary>Păstrează un document pentru răspuns</summary>
      <form
        className="acc-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const file = new FormData(event.currentTarget).get('file');
          if (!(file instanceof File)) return;
          setBusy(true);
          await act(
            () => upload(file),
            'Documentul a fost păstrat. Alege-l în câmpul răspunsului.',
          );
          setBusy(false);
        }}
      >
        <label>
          Document pentru răspuns
          <input type="file" name="file" required />
        </label>
        <button disabled={disabled || busy}>Păstrează documentul pentru răspuns</button>
      </form>
    </details>
  );
}
