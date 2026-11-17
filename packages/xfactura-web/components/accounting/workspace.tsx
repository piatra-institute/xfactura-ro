'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, invoke, upload } from './api';
import Worklist from './worklist';
import { useAccountingNavigation, yearForReturn, type Section } from './navigation';
import Home from './home';
import Documents from './documents';
import Bank from './bank';
import Registers, { registerReset, registerTabs } from './registers';
import Periods from './periods';
import Settings from './settings';
import Questions from './questions';
import Deadlines from './deadlines';
import { Feedback, LinkButton, Select, Tabs, icons } from './ui';

export type Company = { id: string; name: string; cui: string };
export type Year = {
  id: string;
  kind: 'financial' | 'fiscal';
  label: string;
  from: string;
  to: string;
};
export type Evidence = {
  id: string;
  hash: string;
  filename: string;
  mediaType: string;
  size: number;
};
type Capability = { id: string };
/** What every list operation returns: one page of items, and the cursor of the next or null. */
export type List<T> = { items: T[]; next: string | null };

/** What every section needs: the company, its capabilities and a way to act and report. */
export type Workspace = {
  company: Company;
  can: (operation: string) => boolean;
  invoke: <T>(operation: string, input?: unknown) => Promise<T>;
  upload: (file: File) => Promise<{ id: string }>;
  years: Year[];
  year: Year | undefined;
  evidence: Evidence[];
  version: number;
  /** Runs an action, reports its outcome and refreshes every section. */
  act: (
    action: () => Promise<unknown>,
    success: string,
    onError?: (reason: unknown) => void,
  ) => Promise<boolean>;
  refresh: () => void;
};
const Context = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error('useWorkspace outside a workspace');
  return value;
}

const sectionComponents: Record<Section, typeof Documents> = {
  home: Home,
  review: Worklist,
  questions: Questions,
  deadlines: Deadlines,
  registers: Registers,
  documents: Documents,
  bank: Bank,
  settings: Settings,
  periods: Periods,
};

export default function WorkspaceView({ company }: { company: Company }) {
  const { section, params, href } = useAccountingNavigation();
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const [years, setYears] = useState<Year[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const financial = years.filter((year) => year.kind === 'financial');
  const year =
    financial.find((year) => year.id === params.get('year')) ??
    yearForReturn(financial, params.get('return')) ??
    financial.at(-1);

  const chooseYear = (id: string) => {
    const selected = financial.find((year) => year.id === id);
    if (!selected) return;
    const month = params.get('month');
    window.history.pushState(
      null,
      '',
      href(section, {
        year: id,
        ...(params.get('return') && yearForReturn(financial, params.get('return'))?.id !== id
          ? { return: null }
          : {}),
        ...(month && (month < selected.from.slice(0, 7) || month > selected.to.slice(0, 7))
          ? { month: null }
          : {}),
      }),
    );
  };

  const call = useCallback(
    <T,>(operation: string, input: unknown = {}) => invoke<T>(company.id, operation, input),
    [company.id],
  );
  useEffect(() => {
    let active = true;
    (async () => {
      const [available, known, files] = await Promise.all([
        call<{ capabilities: Capability[] }>('capabilities.list'),
        call<List<Year>>('years.list'),
        call<List<Evidence>>('evidence.list'),
      ]);
      if (!active) return;
      setCapabilities(new Set(available.capabilities.map((capability) => capability.id)));
      setYears(known.items);
      setEvidence(files.items);
    })().catch(
      (reason) => active && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      active = false;
    };
  }, [call, version]);

  const act = useCallback(
    async (
      action: () => Promise<unknown>,
      success: string,
      onError?: (reason: unknown) => void,
    ) => {
      setError('');
      setNotice('');
      try {
        await action();
        setNotice(success);
        setVersion((value) => value + 1);
        return true;
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === 'STALE') {
          if (!onError)
            setError(`Registrele s-au schimbat. Datele se reîncarcă. ${reason.message}`);
          setVersion((value) => value + 1);
        } else if (!onError) {
          setError(reason instanceof Error ? reason.message : 'Operațiunea nu a reușit.');
        }
        onError?.(reason);
        return false;
      }
    },
    [],
  );
  const workspace: Workspace = {
    company,
    can: (operation) => capabilities.has(operation),
    invoke: call,
    upload: (file) => upload(company.id, file),
    years,
    year,
    evidence,
    version,
    act,
    refresh: () => setVersion((value) => value + 1),
  };

  return (
    <Context.Provider value={workspace}>
      <SectionFrame financial={financial} chooseYear={chooseYear} error={error} notice={notice} />
    </Context.Provider>
  );
}

/**
 * A section in the shell: the context bar with the section's title, the financial year and the
 * section's primary action; the section's parts as tabs; then the last outcome and the content.
 */
function SectionFrame({
  financial,
  chooseYear,
  error,
  notice,
}: {
  financial: Year[];
  chooseYear: (id: string) => void;
  error: string;
  notice: string;
}) {
  const { can, year } = useWorkspace();
  const { view, section, params, href, navigate, filter } = useAccountingNavigation();
  const Content = sectionComponents[section];
  const registers = registerTabs(can, params.get('register'));
  const tabs =
    view.id === 'registers' && registers.active
      ? {
          label: 'Registre',
          items: registers.items,
          selectedKey: registers.active,
          onSelect: (id: string) => filter({ register: id, ...registerReset }),
        }
      : view.sections.length > 1
        ? {
            label: view.navigationLabel,
            items: view.sections,
            selectedKey: section as string,
            onSelect: (id: string) => navigate(id as Section),
          }
        : null;
  const body = (
    <div className="acc-body">
      <Feedback error={error} notice={notice} />
      <section className="acc-content" aria-label={view.label}>
        <Content />
      </section>
    </div>
  );
  return (
    <>
      <div className="acc-contextbar">
        <h1>{view.label}</h1>
        <div className="acc-contextbar-tools">
          <Select
            label="Exercițiu"
            className="acc-year"
            options={financial.map((choice) => ({ id: choice.id, label: choice.label }))}
            value={year?.id ?? null}
            onChange={(id) => id && chooseYear(id)}
          />
          {view.id !== 'documents' ? (
            <LinkButton href={href('documents')} variant="primary">
              {icons.plus}
              Adaugă documente
            </LinkButton>
          ) : null}
        </div>
      </div>
      {tabs ? (
        <Tabs
          label={tabs.label}
          items={tabs.items}
          selectedKey={tabs.selectedKey}
          onSelect={tabs.onSelect}
        >
          {body}
        </Tabs>
      ) : (
        body
      )}
    </>
  );
}

/** Loads a list operation's items and reloads them whenever the workspace changes. */
export function useList<T>(operation: string, input: unknown, enabled = true) {
  const { data, error } = useLoad<List<T>>(operation, input, enabled);
  return { data: data?.items ?? null, error };
}

/** Loads a capability's result and reloads it whenever the workspace changes. */
export function useLoad<T>(operation: string, input: unknown, enabled = true) {
  const { invoke: call, version } = useWorkspace();
  const [result, setResult] = useState<{
    key: string;
    version: number;
    data?: T;
    error?: string;
  } | null>(null);
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    call<T>(operation, JSON.parse(key))
      .then((data) => active && setResult({ key, version, data }))
      .catch(
        (reason) =>
          active &&
          setResult({
            key,
            version,
            error: reason instanceof Error ? reason.message : 'Datele nu au putut fi încărcate.',
          }),
      );
    return () => {
      active = false;
    };
  }, [call, operation, key, version, enabled]);
  const current = enabled && result?.key === key && result.version === version ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? '' };
}
