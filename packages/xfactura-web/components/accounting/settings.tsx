'use client';

import { useState, type FormEvent } from 'react';
import { FileTrigger } from 'react-aria-components';
import { companyPath } from './api';
import { formatDate, formatDateTime } from './format';
import { ActorName, RecordNames } from './record-names';
import { useAccountingData } from './use-data';
import { Button, Chip, ComboBox, DateField, IconButton, Select, icons } from './ui';
import { useWorkspace, type Evidence, type Year } from './workspace';

export type ProfileValue = { value: string; label: string };
export type ProfileFact = ProfileValue & {
  effectiveFrom: string;
  factId: string;
  evidenceId: string;
  recordedBy: string;
};
export type ProfileItem = {
  axis: string;
  name: string;
  group: string;
  /** Whether any value applies to the company's legal form and recorded facts. */
  applies: boolean;
  /** A fact the law decides each year, stated or confirmed for every year. */
  yearly: boolean;
  values: (ProfileValue & { applies: boolean })[];
  current: (ProfileFact & { confirmedFor?: number; needsConfirmation?: boolean }) | null;
  impliedDefault: ProfileValue | null;
  history: (ProfileFact & {
    supersedesId: string | null;
    superseded: boolean;
    recordedAt: string;
  })[];
};
export type ProfileCurrent = {
  date: string;
  items: ProfileItem[];
  next: string | null;
  groups: { group: string; name: string }[];
};

/** A person's own statement, which the engine keeps as the evidence of a fact without a document. */
export const statementType = 'application/vnd.xfactura.answer+json';

/** The company's profile on the engine's today, kept on screen while it reloads after a change. */
export function useProfile(enabled = true) {
  return useAccountingData<ProfileCurrent>('profile.current', {}, enabled);
}

/** The financial year a day falls in. */
export const yearOf = (years: Year[], day: string) =>
  years.find((year) => year.kind === 'financial' && year.from <= day && day <= year.to);

/** The documents a fact may cite: kept files, not the statements the engine keeps itself. */
const documentsOf = (evidence: Evidence[]) =>
  evidence.filter((file) => file.mediaType !== statementType && file.filename);

type Panel = { axis: string; mode: 'change' | 'correct' | 'history' };

/** Companie: every axis that applies to the company, grouped as the engine groups them. */
export default function Settings() {
  const { can } = useWorkspace();
  const { data: profile, error, loading } = useProfile();
  const [panel, setPanel] = useState<Panel | null>(null);
  if (!profile)
    return error ? (
      <p role="alert" className="acc-error">
        {error}
      </p>
    ) : (
      <p className="acc-loading" aria-busy="true">
        Se încarcă profilul…
      </p>
    );
  const groups = (profile.groups ?? [])
    .map((group) => ({
      ...group,
      items: (profile.items ?? []).filter((item) => item.group === group.group && item.applies),
    }))
    .filter((group) => group.items.length);
  const toggle = (axis: string, mode: Panel['mode']) =>
    setPanel((open) => (open?.axis === axis && open.mode === mode ? null : { axis, mode }));
  return (
    <RecordNames>
      {error ? (
        <p role="alert" className="acc-error">
          {error}
        </p>
      ) : null}
      <div className="acc-profile" aria-busy={loading || undefined}>
        {groups.map((group) => (
          <section
            key={group.group}
            className="acc-profile-group"
            aria-labelledby={`profile-${group.group}`}
          >
            <h2 id={`profile-${group.group}`}>{group.name}</h2>
            <table className="acc-profile-table">
              <thead className="acc-visually-hidden">
                <tr>
                  <th scope="col">Denumire</th>
                  <th scope="col">Valoare</th>
                  <th scope="col">De la</th>
                  <th scope="col">Acțiuni</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => (
                  <ProfileRow
                    key={item.axis}
                    item={item}
                    profile={profile}
                    open={panel?.axis === item.axis ? panel.mode : null}
                    onToggle={(mode) => toggle(item.axis, mode)}
                    onClose={() => setPanel(null)}
                    canRecord={can('profile.record')}
                  />
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </RecordNames>
  );
}

function ProfileRow({
  item,
  profile,
  open,
  onToggle,
  onClose,
  canRecord,
}: {
  item: ProfileItem;
  profile: ProfileCurrent;
  open: Panel['mode'] | null;
  onToggle: (mode: Panel['mode']) => void;
  onClose: () => void;
  canRecord: boolean;
}) {
  const { invoke, act } = useWorkspace();
  const current = item.current;
  const year = Number(profile.date.slice(0, 4));
  const panelId = `profile-panel-${item.axis}`;
  const toggle = (mode: Panel['mode'], label: string) => (
    <Button
      size="small"
      variant="quiet"
      aria-expanded={open === mode}
      aria-controls={open === mode ? panelId : undefined}
      onPress={() => onToggle(mode)}
    >
      {label}
    </Button>
  );
  return (
    <>
      <tr className="acc-profile-row" data-open={open ? 'true' : undefined}>
        <th scope="row">{item.name}</th>
        <td className="acc-profile-value">
          {current ? (
            current.label
          ) : item.impliedDefault ? (
            <>
              {item.impliedDefault.label} <Chip>implicit</Chip>
            </>
          ) : (
            <span className="acc-profile-none">—</span>
          )}
        </td>
        <td className="acc-profile-date">{current ? formatDate(current.effectiveFrom) : null}</td>
        <td className="acc-profile-actions">
          <div className="acc-row-actions">
            {canRecord && current?.needsConfirmation ? (
              <Button
                size="small"
                onPress={() =>
                  act(
                    () =>
                      invoke('profile.record', {
                        axis: item.axis,
                        value: current.value,
                        effectiveFrom: `${year}-01-01`,
                      }),
                    `Faptul a fost confirmat pentru ${year}.`,
                  )
                }
              >
                Confirmă pentru {year}
              </Button>
            ) : null}
            {canRecord ? toggle('change', 'Schimbă') : null}
            {canRecord && current ? toggle('correct', 'Corectează') : null}
            {item.history.length ? toggle('history', 'Istoric') : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="acc-profile-panel" id={panelId}>
          <td colSpan={4}>
            {open === 'history' ? (
              <FactHistory item={item} />
            ) : (
              <FactEditor key={open} item={item} mode={open} profile={profile} onDone={onClose} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * „Schimbă” records a value from a day; „Corectează” replaces the fact in effect
 * (`supersedesId`). A document is optional: without one the engine keeps the person's statement.
 */
function FactEditor({
  item,
  mode,
  profile,
  onDone,
}: {
  item: ProfileItem;
  mode: 'change' | 'correct';
  profile: ProfileCurrent;
  onDone: () => void;
}) {
  const { years, evidence, invoke, upload, act } = useWorkspace();
  const current = mode === 'correct' ? item.current : null;
  const choices = item.values.filter((choice) => choice.applies);
  const [value, setValue] = useState<string | null>(
    current && choices.some((choice) => choice.value === current.value) ? current.value : null,
  );
  // A yearly fact is stated from the first day of its financial year; any other from today.
  const [date, setDate] = useState<string | null>(
    current?.effectiveFrom ??
      (item.yearly
        ? (yearOf(years, profile.date)?.from ?? `${profile.date.slice(0, 4)}-01-01`)
        : profile.date),
  );
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value) return setProblem('Alege valoarea.');
    if (!date) return;
    setProblem('');
    setBusy(true);
    const saved = await act(
      async () => {
        const evidenceId = file ? (await upload(file)).id : documentId;
        await invoke('profile.record', {
          axis: item.axis,
          value,
          effectiveFrom: date,
          ...(evidenceId ? { evidenceId } : {}),
          ...(current ? { supersedesId: current.factId } : {}),
        });
      },
      current ? 'Faptul a fost corectat.' : 'Faptul a fost înregistrat.',
      // A refusal is shown in the form it concerns, not at the top of a long page.
      (reason) =>
        setProblem(reason instanceof Error ? reason.message : 'Faptul nu a putut fi înregistrat.'),
    );
    setBusy(false);
    if (saved) onDone();
  };
  return (
    <form
      className="acc-fact-editor"
      aria-label={current ? 'Corectare' : 'Schimbare'}
      onSubmit={submit}
    >
      {current ? (
        <p className="acc-fact-replaces">
          Înlocuiește {current.label}, de la {formatDate(current.effectiveFrom)}
        </p>
      ) : null}
      <div className="acc-fact-fields">
        <Select
          label="Valoare"
          options={choices.map((choice) => ({ id: choice.value, label: choice.label }))}
          value={value}
          onChange={(chosen) => {
            setValue(chosen);
            setProblem('');
          }}
        />
        <DateField label="De la" value={date} onChange={setDate} isRequired />
        <ComboBox
          label="Document"
          options={documentsOf(evidence).map((kept) => ({ id: kept.id, name: kept.filename }))}
          value={file ? null : documentId}
          onChange={setDocumentId}
          placeholder="Fără document"
          emptyMessage="Niciun document păstrat"
          isDisabled={!!file}
        />
        <div className="acc-fact-upload">
          {file ? (
            <span className="acc-fact-file">
              {icons.documents}
              <span>{file.name}</span>
              <IconButton
                label="Renunță la fișier"
                icon={icons.close}
                size="small"
                onPress={() => setFile(null)}
              />
            </span>
          ) : (
            <FileTrigger
              onSelect={(files) => {
                const chosen = files?.[0] ?? null;
                setFile(chosen);
                if (chosen) setDocumentId(null);
              }}
            >
              <Button size="small" variant="quiet">
                {icons.plus}
                Încarcă un fișier
              </Button>
            </FileTrigger>
          )}
        </div>
      </div>
      {problem ? (
        <p role="alert" className="acc-field-error">
          {problem}
        </p>
      ) : null}
      <div className="acc-form-actions">
        <Button type="submit" variant="primary" isDisabled={busy}>
          Salvează
        </Button>
        <Button variant="quiet" onPress={onDone}>
          Renunță
        </Button>
      </div>
    </form>
  );
}

/** Every fact recorded on an axis, in effect order; a replaced one stays, marked. */
function FactHistory({ item }: { item: ProfileItem }) {
  const { company, evidence } = useWorkspace();
  return (
    <table className="acc-history-table">
      <caption className="acc-visually-hidden">Istoric: {item.name}</caption>
      <thead>
        <tr>
          <th scope="col">Valoare</th>
          <th scope="col">De la</th>
          <th scope="col">Înregistrat de</th>
          <th scope="col">Document</th>
          <th scope="col">Înregistrat la</th>
        </tr>
      </thead>
      <tbody>
        {item.history.map((fact) => {
          const file = evidence.find((kept) => kept.id === fact.evidenceId);
          return (
            <tr key={fact.factId} data-superseded={fact.superseded || undefined}>
              <td>
                <span className="acc-history-value">{fact.label}</span>
                {fact.superseded ? <Chip>înlocuit</Chip> : null}
                {fact.factId === item.current?.factId ? (
                  <Chip tone="success">în vigoare</Chip>
                ) : null}
              </td>
              <td className="acc-history-date" data-label="De la">
                {formatDate(fact.effectiveFrom)}
              </td>
              <td data-label="Înregistrat de">
                <ActorName person={fact.recordedBy} />
              </td>
              <td data-label="Document">
                {!file?.filename ? null : file.mediaType === statementType ? (
                  'Declarație'
                ) : (
                  <a href={`${companyPath(company.id)}/evidence/${fact.evidenceId}`}>
                    {file.filename}
                  </a>
                )}
              </td>
              <td className="acc-history-date" data-label="Înregistrat la">
                {formatDateTime(fact.recordedAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
