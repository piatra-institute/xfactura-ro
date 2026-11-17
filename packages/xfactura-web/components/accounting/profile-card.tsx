'use client';

import { useId, useMemo, useState } from 'react';
import { ApiError } from './api';
import { useAccountingData } from './use-data';
import { Button, DateField, Select } from './ui';
import { factSteps, refusal, type WorkItem, type WorkStepView } from './work-model';
import { useWorkspace } from './workspace';

/** One axis of `profile.current`, as the card reads it. */
type ProfileAxis = {
  axis: string;
  name: string;
  yearly: boolean;
  values: { value: string; label: string; applies: boolean }[];
};
type ProfileCurrent = { items: ProfileAxis[] };

/** One missing fact: an axis (of a year, for a fact the law decides each year) and the steps that
 * record it, merged from every item that names it. */
export type FactRow = {
  key: string;
  axis: string;
  name: string;
  year: string | null;
  /** The earliest day the steps name: recording from it covers every item. */
  effectiveFrom: string;
  /** A step the person may take, else the first, whose refusal the row shows. */
  step: WorkStepView;
  values: { id: string; label: string }[];
  items: WorkItem[];
};

/** The worklist's kinds that may carry a person's `profile.record` step. */
const factKinds = [
  'closure.need',
  'question.needed',
  'determination.missing',
  'vat.prorata',
  'yearend.review',
] as const;

/** The anchor of a fact's row, which a worklist row that waits on the fact moves focus to. */
export const factAnchor = (key: string) => `fapt-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** Moves to a fact's row in the card and puts focus on its first control. */
export function focusFact(key: string) {
  const row = document.getElementById(factAnchor(key));
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  (row.querySelector<HTMLElement>('button, input, [tabindex="0"]') ?? row).focus();
}

/**
 * The company facts people must record: every item waiting on a person's `profile.record` step,
 * one row per axis however many items name it, its values from `profile.current`. `facts` maps
 * the items' cause ids to their row, for the worklist rows that wait on the same fact.
 */
export function useFactRows() {
  const { can } = useWorkspace();
  const work = useAccountingData<WorkItem[]>(
    'work.list',
    { by: 'human', kinds: [...factKinds], limit: 200 },
    can('work.list'),
    true,
  );
  const named = can('profile.current');
  const profile = useAccountingData<ProfileCurrent>(
    'profile.current',
    {},
    named && !!work.data?.length,
  );
  // Rows wait for the axes' names and values, unless this role cannot read them.
  const ready = !named || !!profile.data || !!profile.error;
  return useMemo(() => {
    const axes = new Map((profile.data?.items ?? []).map((axis) => [axis.axis, axis]));
    const rows = new Map<string, FactRow>();
    const facts = new Map<string, string>();
    for (const item of ready ? (work.data ?? []) : []) {
      for (const step of factSteps(item)) {
        const axis = String(step.inputHint.axis ?? '');
        const from = String(step.inputHint.effectiveFrom ?? '');
        if (!axis || !/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
        const known = axes.get(axis);
        const year = known?.yearly ? from.slice(0, 4) : null;
        const key = year ? `${axis}/${year}` : axis;
        const row = rows.get(key);
        if (row) {
          if (!row.items.includes(item)) row.items.push(item);
          if (from < row.effectiveFrom) row.effectiveFrom = from;
          if (step.allowed && !row.step.allowed) row.step = step;
        } else
          rows.set(key, {
            key,
            axis,
            name: known?.name ?? axis,
            year,
            effectiveFrom: from,
            step,
            values: (known?.values ?? [])
              .filter((value) => value.applies)
              .map((value) => ({ id: value.value, label: value.label })),
            items: [item],
          });
        // The causes these items name, and the fact itself (`fact:<axis>`, of its year on a
        // yearly axis), are what other items wait on when they wait on this row.
        for (const cause of item.causes ?? []) if (!facts.has(cause.id)) facts.set(cause.id, key);
        if (!facts.has(`fact:${key}`)) facts.set(`fact:${key}`, key);
      }
    }
    return {
      rows: [...rows.values()],
      facts,
      loading: work.loading || (!!work.data?.length && !ready),
      error: work.error || profile.error,
    };
  }, [work.data, work.loading, work.error, profile.data, profile.error, ready]);
}
export type FactRows = ReturnType<typeof useFactRows>;

/**
 * „Profilul firmei”: each missing fact with its control in place, recorded with the person's own
 * statement (`profile.record` without a document). A recorded fact leaves the card when the
 * worklist no longer waits on it.
 */
export function ProfileCard({ needs, level = 2 }: { needs: FactRows; level?: 2 | 3 }) {
  const heading = useId();
  if (!needs.rows.length && !needs.error) return null;
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className="acc-facts" aria-labelledby={heading} aria-busy={needs.loading}>
      <Heading id={heading}>Profilul firmei</Heading>
      {needs.error ? (
        <p role="alert" className="acc-error">
          {needs.error}
        </p>
      ) : null}
      <ul className="acc-fact-list">
        {needs.rows.map((row) => (
          <FactRowView key={row.key} row={row} />
        ))}
      </ul>
    </section>
  );
}

function FactRowView({ row }: { row: FactRow }) {
  const { invoke, act } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = row.year ? `${row.name} · ${row.year}` : row.name;
  const save = async (value: string, from: string) => {
    if (!value || !from) return;
    setBusy(true);
    setError('');
    await act(
      () => invoke('profile.record', { axis: row.axis, value, effectiveFrom: from }),
      'Faptul a fost înregistrat.',
      (reason) =>
        setError(
          reason instanceof ApiError || reason instanceof Error
            ? reason.message
            : 'Faptul nu a putut fi înregistrat.',
        ),
    );
    setBusy(false);
  };
  return (
    <li className="acc-fact" id={factAnchor(row.key)} data-fact={row.key}>
      {row.step.allowed && row.values.length ? (
        <form
          className="acc-fact-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void save(String(data.get('value') ?? ''), String(data.get('effectiveFrom') ?? ''));
          }}
        >
          <Select
            label={label}
            name="value"
            className="acc-fact-value"
            options={row.values}
            isRequired
            errorMessage="Alege o valoare."
          />
          <DateField
            label="De la"
            name="effectiveFrom"
            className="acc-fact-date"
            defaultValue={row.effectiveFrom}
            isRequired
          />
          <Button type="submit" size="small" isDisabled={busy}>
            Salvează
          </Button>
        </form>
      ) : (
        <div className="acc-fact-form">
          <span className="acc-fact-name">{label}</span>
          <p className="acc-fact-refusal">
            {row.step.allowed ? 'Nicio valoare nu se aplică formei juridice.' : refusal(row.step)}
          </p>
        </div>
      )}
      {error ? (
        <p role="alert" className="acc-fact-error acc-error">
          {error}
        </p>
      ) : null}
    </li>
  );
}
