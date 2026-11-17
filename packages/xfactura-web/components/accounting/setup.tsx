'use client';

import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useAccountingNavigation } from './navigation';
import { useProfile, type ProfileCurrent, type ProfileItem } from './settings';
import { Button, DateField, LinkButton, icons } from './ui';
import { useWorkspace } from './workspace';

/** The setup's questions in the order they are asked, by profile axis. */
export const setupAxes = [
  'entity.form',
  'vat.status',
  'vat.period',
  'vat.cash',
  'income_tax',
  'employer',
  'payroll.period',
  'activity.goods',
  'regime.excluded',
  'size.category',
] as const;

type Answers = Readonly<Record<string, string>>;

const itemOf = (profile: ProfileCurrent, axis: string) =>
  (profile.items ?? []).find((item) => item.axis === axis);

/** The value an axis holds for the setup: the answer given now, else the fact in effect. */
const holds = (profile: ProfileCurrent, answers: Answers, axis: string) =>
  answers[axis] ?? itemOf(profile, axis)?.current?.value;

/**
 * Whether the setup asks about an axis: the engine says it applies to the company's legal form,
 * and no earlier answer makes it irrelevant (VAT returns for a VAT payer, the micro or profit tax
 * for an SRL, the 112's period for an employer).
 */
function asks(profile: ProfileCurrent, answers: Answers, axis: string) {
  const item = itemOf(profile, axis);
  if (!item?.applies) return false;
  if (axis === 'vat.period' || axis === 'vat.cash')
    return holds(profile, answers, 'vat.status') === 'normal_vat';
  if (axis === 'income_tax')
    return (
      (holds(profile, answers, 'entity.form') ??
        itemOf(profile, 'entity.form')?.impliedDefault?.value) === 'srl'
    );
  if (axis === 'payroll.period') return holds(profile, answers, 'employer') === 'yes';
  return true;
}

/** The setup's answers the profile already holds. */
function recordedAnswers(profile: ProfileCurrent) {
  const answers: Record<string, string> = {};
  for (const axis of setupAxes) {
    const value = itemOf(profile, axis)?.current?.value;
    if (value) answers[axis] = value;
  }
  return answers;
}

/** The questions still to ask, in order. */
function remaining(profile: ProfileCurrent, answers: Answers, skipped: ReadonlySet<string>) {
  return setupAxes.filter(
    (axis) => !answers[axis] && !skipped.has(axis) && asks(profile, answers, axis),
  );
}

const reasonOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Răspunsul nu a putut fi înregistrat.';

/**
 * The company's setup: one question per screen, each answer recorded with `profile.record` as it
 * is given. Questions answered before are not asked again; it ends on Acasă.
 */
export default function Setup() {
  const { years, can, invoke, act } = useWorkspace();
  const { href } = useAccountingNavigation();
  const { data: profile, error, loading } = useProfile();
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  // The questions answered or skipped here, in order, and the one shown again after „Înapoi”.
  const [trail, setTrail] = useState<string[]>([]);
  const [back, setBack] = useState<number | null>(null);
  // The facts recorded here: going back and answering again corrects them.
  const [facts, setFacts] = useState<Record<string, { id: string; date: string }>>({});
  const [dates, setDates] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (profile && answers === null) setAnswers(recordedAnswers(profile));

  const left = profile && answers ? remaining(profile, answers, skipped) : [];
  const axis = back !== null ? trail[back] : left[0];
  const done = !!profile && !!answers && !axis;
  const home = href('home');
  // Opened with nothing left to ask, the setup gives way to Acasă.
  useEffect(() => {
    if (done && !loading) window.history.replaceState(null, '', home);
  }, [done, loading, home]);

  if (!profile || !answers)
    return error ? (
      <p role="alert" className="acc-error">
        {error}
      </p>
    ) : (
      <p className="acc-loading" aria-busy="true">
        Se încarcă profilul…
      </p>
    );
  const item = axis ? itemOf(profile, axis) : undefined;
  // Nothing left to ask: Acasă replaces the setup.
  if (!axis || !item) return <></>;

  const firstYear = years.find((year) => year.kind === 'financial');
  const date =
    axis in dates
      ? (dates[axis] ?? null)
      : (facts[axis]?.date ?? firstYear?.from ?? `${profile.date.slice(0, 4)}-01-01`);
  // The progress counts the questions shown that still apply, and those still to ask.
  const before = trail.slice(0, back ?? trail.length);
  const shown = trail.filter((asked) => asks(profile, answers, asked));
  const position = before.filter((asked) => asks(profile, answers, asked)).length;
  // „Înapoi” shows the last question before this one that an answer since has not made irrelevant.
  const earlier = before.findLastIndex((asked) => asks(profile, answers, asked));

  /** Moves on from the question shown: to the next one shown before that still applies, else
   * to the first question not yet answered, else to Acasă. */
  const advance = (nextAnswers: Answers, nextSkipped: ReadonlySet<string>) => {
    setProblem('');
    if (back === null) setTrail((shown) => [...shown, axis]);
    else
      for (let index = back + 1; index < trail.length; index++)
        if (asks(profile, nextAnswers, trail[index]!)) return setBack(index);
    setBack(null);
    if (!remaining(profile, nextAnswers, nextSkipped).length)
      window.history.pushState(null, '', home);
  };

  const choose = async (value: string) => {
    if (!date) return;
    const previous = facts[axis];
    if (answers[axis] !== value || (previous && previous.date !== date)) {
      setBusy(true);
      const result: { fact?: { id: string } } = {};
      const saved = await act(
        async () => {
          result.fact = await invoke<{ id: string }>('profile.record', {
            axis,
            value,
            effectiveFrom: date,
            ...(previous ? { supersedesId: previous.id } : {}),
          });
        },
        '',
        (reason) => setProblem(reasonOf(reason)),
      );
      setBusy(false);
      if (!saved || !result.fact) return;
      const id = result.fact.id;
      setFacts((known) => ({ ...known, [axis]: { id, date } }));
    }
    const nextAnswers = { ...answers, [axis]: value };
    const nextSkipped = new Set(skipped);
    nextSkipped.delete(axis);
    setAnswers(nextAnswers);
    setSkipped(nextSkipped);
    advance(nextAnswers, nextSkipped);
  };

  // „Mai târziu” leaves an answer given before as it is.
  const later = () => {
    const nextSkipped = answers[axis] ? skipped : new Set(skipped).add(axis);
    setSkipped(nextSkipped);
    advance(answers, nextSkipped);
  };

  return (
    <SetupQuestion
      key={axis}
      item={item}
      position={position}
      total={shown.length + left.length}
      chosen={answers[axis]}
      date={date}
      onDate={(next) => setDates((known) => ({ ...known, [axis]: next }))}
      busy={busy}
      refused={can('profile.current') && !can('profile.record')}
      problem={problem}
      onBack={
        earlier >= 0
          ? () => {
              setProblem('');
              setBack(earlier);
            }
          : undefined
      }
      onLater={later}
      onChoose={choose}
    />
  );
}

function SetupQuestion({
  item,
  position,
  total,
  chosen,
  date,
  onDate,
  busy,
  refused,
  problem,
  onBack,
  onLater,
  onChoose,
}: {
  item: ProfileItem;
  position: number;
  total: number;
  chosen: string | undefined;
  date: string | null;
  onDate: (date: string | null) => void;
  busy: boolean;
  /** The person's role records no facts. */
  refused: boolean;
  problem: string;
  onBack?: () => void;
  onLater: () => void;
  onChoose: (value: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Each question takes the focus, so the keyboard and a screen reader start from it.
  useEffect(() => heading.current?.focus(), []);
  const choices = item.values.filter((choice) => choice.applies);
  return (
    <div className="acc-setup">
      <div className="acc-setup-progress">
        <span>
          Întrebarea {position + 1} din {total}
        </span>
        <span className="acc-setup-track" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              data-state={index < position ? 'done' : index === position ? 'current' : undefined}
            />
          ))}
        </span>
      </div>
      <h2 ref={heading} tabIndex={-1} className="acc-setup-question">
        {item.name}
      </h2>
      <DateField
        label="De la"
        className="acc-setup-date"
        value={date}
        onChange={onDate}
        isRequired
      />
      <div className="acc-setup-choices" role="group" aria-label={item.name}>
        {choices.map((choice) => (
          <AriaButton
            key={choice.value}
            className="acc-setup-choice"
            aria-pressed={choice.value === chosen ? true : undefined}
            isDisabled={busy || refused || !date}
            onPress={() => onChoose(choice.value)}
          >
            <span>{choice.label}</span>
            {choice.value === chosen ? icons.check : null}
          </AriaButton>
        ))}
      </div>
      {refused ? (
        <p className="acc-hint">Rolul tău în companie nu înregistrează fapte.</p>
      ) : !date ? (
        <p className="acc-hint">Completează data de la care se aplică răspunsul.</p>
      ) : null}
      {problem ? (
        <p role="alert" className="acc-error">
          {problem}
        </p>
      ) : null}
      <div className="acc-setup-actions">
        {onBack ? (
          <Button variant="quiet" onPress={onBack}>
            {icons.chevronLeft}
            Înapoi
          </Button>
        ) : (
          <span />
        )}
        <Button variant="quiet" onPress={onLater}>
          Mai târziu
        </Button>
      </div>
    </div>
  );
}

/** On Acasă, while setup questions that apply have no answer, the way back to them. */
export function SetupPrompt() {
  const { can } = useWorkspace();
  const { href } = useAccountingNavigation();
  const allowed = can('profile.record');
  const { data: profile } = useProfile(allowed);
  if (!allowed || !profile) return null;
  const count = remaining(profile, recordedAnswers(profile), new Set()).length;
  if (!count) return null;
  return (
    <div className="acc-setup-prompt">
      <p>{count === 1 ? 'O întrebare' : `${count} întrebări`} de configurare fără răspuns</p>
      <LinkButton href={href('setup')} variant="primary" size="small">
        Configurează compania
      </LinkButton>
    </div>
  );
}
