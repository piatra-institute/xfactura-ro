'use client';

import { useState, type ComponentType } from 'react';
import type { ActionView, ProposalView } from 'xfactura-api/contracts';
import { SectionLink, sectionLabels, useAccountingNavigation } from './navigation';
import { ProposalCard } from './review';
import { WorkDetails } from './work-details';
import {
  deniedReason,
  directStep,
  hasCollector,
  stepLabel,
  stepSection,
  type WorkItem,
  type WorkStepView,
} from './work-model';
import { useLoad, useWorkspace } from './workspace';

type DetailProps = { item: WorkItem };
function ItemDetails({ item }: DetailProps) {
  return (
    <WorkDetails
      value={item.details}
      technical={{
        id: item.id,
        subject: item.subject,
        fingerprint: item.fingerprint,
        asOfSeq: item.asOfSeq,
        next: item.next,
      }}
    />
  );
}
function GenericDetail({ item }: DetailProps) {
  return (
    <>
      <ItemDetails item={item} />
      <Steps item={item} />
    </>
  );
}
function ProposalDetail({ item }: DetailProps) {
  const { data, error } = useLoad<ProposalView>('proposals.get', {
    id: item.subject.id,
    recheck: true,
  });
  return (
    <>
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : data ? (
        <ProposalCard
          key={`${data.id}:${data.version}:${data.effectHash}`}
          proposal={data}
          steps={item.next}
        />
      ) : (
        <p className="acc-hint">Se încarcă propunerea și efectul…</p>
      )}
      <Steps item={item} proposal />
    </>
  );
}
function ActionDetail({ item }: DetailProps) {
  const { data, error } = useLoad<ActionView>('actions.get', { id: item.subject.id });
  return (
    <>
      <ItemDetails item={item} />
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : data ? (
        <>
          <h4>Efectul acțiunii</h4>
          <WorkDetails value={data.preview} />
          {item.next.some(
            (step) =>
              step.operation === 'actions.approve' &&
              step.inputHint.previewHash !== data.previewHash,
          ) ? (
            <p className="acc-hint">
              Previzualizarea s-a schimbat. Reîncarcă lista înainte de aprobare.
            </p>
          ) : null}
        </>
      ) : (
        <p className="acc-hint">Se încarcă previzualizarea…</p>
      )}
      <Steps item={item} previewHash={data?.previewHash} />
    </>
  );
}

/** Subjects select the read and review surface; operations select their own collectors. */
const detailRenderers: Record<string, ComponentType<DetailProps>> = {
  proposal: ProposalDetail,
  action: ActionDetail,
};
export function WorkItemDetail({ item }: DetailProps) {
  const Detail = detailRenderers[item.subject.kind] ?? GenericDetail;
  if (item.kind === 'obligation.due')
    return (
      <>
        <ItemDetails item={item} />
        <SectionLink
          section="deadlines"
          filters={{ return: item.subject.id, month: null, declarationStatus: null }}
        >
          Deschide declarația în Termene
        </SectionLink>
      </>
    );
  const questionIds = item.kind.startsWith('question.')
    ? [
        ...new Set([
          ...(item.subject.kind === 'question' ? [item.subject.id] : []),
          ...item.next.flatMap((step) =>
            typeof step.inputHint.questionId === 'string' ? [step.inputHint.questionId] : [],
          ),
          ...(Array.isArray(item.details.questions)
            ? item.details.questions.flatMap((question) =>
                question &&
                typeof question === 'object' &&
                !Array.isArray(question) &&
                typeof question.questionId === 'string'
                  ? [question.questionId]
                  : [],
              )
            : []),
        ]),
      ]
    : [];
  return (
    <>
      <Detail item={item} />
      {questionIds.map((id, index) => (
        <p key={id}>
          <SectionLink
            section="questions"
            filters={{ question: id, questionStatus: null, questionKind: null }}
          >
            Deschide întrebarea{questionIds.length > 1 ? ` ${index + 1}` : ''} în Întrebări
          </SectionLink>
        </p>
      ))}
    </>
  );
}

function Steps({
  item,
  proposal = false,
  previewHash,
}: DetailProps & { proposal?: boolean; previewHash?: string }) {
  return (
    <>
      <ul className="acc-work-steps" aria-label="Pași următori">
        {item.next.map((step, index) => (
          <li key={`${step.operation}:${index}`}>
            <WorkStep
              item={item}
              step={step}
              proposal={proposal}
              previewReady={
                step.operation !== 'actions.approve' ||
                (!!previewHash && previewHash === step.inputHint.previewHash)
              }
            />
          </li>
        ))}
      </ul>
      {item.next.length === 0 ? (
        <p className="acc-hint">Acest element necesită verificarea persoanei responsabile.</p>
      ) : null}
    </>
  );
}

function WorkStep({
  item,
  step,
  proposal,
  previewReady,
}: {
  item: WorkItem;
  step: WorkStepView;
  proposal: boolean;
  previewReady: boolean;
}) {
  const { invoke, act } = useWorkspace();
  const { section: currentSection } = useAccountingNavigation();
  const [busy, setBusy] = useState(false);
  const section = stepSection(step);
  const run = async (input: unknown) => {
    setBusy(true);
    await act(
      () => invoke(step.operation, input),
      step.operation === 'work.dispose'
        ? 'Elementul a fost închis cu motivul indicat.'
        : 'Operațiunea a fost finalizată.',
    );
    setBusy(false);
  };
  if (!step.allowed) return <p className="acc-hint">{deniedReason(step)}</p>;
  if (step.operation === 'work.dispose') {
    if (item.severity === 'block')
      return (
        <p className="acc-hint">
          Acest element blochează și nu poate fi închis până când problema nu este rezolvată.
        </p>
      );
    const { id, fingerprint, disposition } = step.inputHint;
    if (
      typeof id === 'string' &&
      typeof fingerprint === 'string' &&
      ['no_booking', 'dealt_with'].includes(String(disposition))
    )
      return (
        <form
          className="acc-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
            void run({ ...step.inputHint, reason });
          }}
        >
          <label>
            Motivul închiderii
            <input name="reason" required minLength={10} maxLength={1000} />
          </label>
          <button className="acc-secondary" disabled={busy}>
            Închide cu motiv
          </button>
        </form>
      );
  }
  // All proposal decisions and posting stay in ProposalCard, bound to its exact version/hash.
  if (
    proposal &&
    ['proposals.approve', 'ledger.post', 'proposals.withdraw'].includes(step.operation)
  )
    return step.by === 'agent' ? (
      <p className="acc-hint">
        Așteaptă un agent: {stepLabel(step)}. Poți folosi și acțiunea propunerii de mai sus.
      </p>
    ) : null;
  if (directStep(step))
    return (
      <button disabled={busy || !previewReady} onClick={() => run(step.inputHint)}>
        {stepLabel(step)}
      </button>
    );
  return (
    <>
      <p className="acc-hint">
        {step.by === 'agent'
          ? `Așteaptă un agent: ${stepLabel(step)}.`
          : `${stepLabel(step)}: sunt necesare date suplimentare.`}
      </p>
      {step.by === 'human' && !hasCollector(step) ? (
        <p className="acc-hint">Datele acestui pas nu au un formular în această interfață.</p>
      ) : null}
      {section && section !== currentSection ? (
        <SectionLink section={section}>
          {hasCollector(step) ? 'Deschide' : 'Vezi contextul în'} {sectionLabels[section]}
        </SectionLink>
      ) : null}
    </>
  );
}
