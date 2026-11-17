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
import Members from './members';
import Exports from './exports';
import Setup, { SetupPrompt } from './setup';
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

/** An amount as `company.summary` states it: integer minor units and their currency. */
export type Money = { minor: string; currency: string };
type OpenSide = {
  count: number;
  currencies: {
    currency: string;
    total: string;
    count: number;
    overdue: string;
    overdueCount: number;
  }[];
  unrepresented: { code: 'UNSUPPORTED'; accounts: { account: string; balance: Money }[] } | null;
};
/** The company on a day, every amount the engine's (`company.summary`). */
export type Summary = {
  date: string;
  cash: {
    accounts: {
      id: string;
      kind: 'bank' | 'cash';
      name: string;
      ledgerAccount: string;
      currency: string;
      balance: Money;
      ledgerBalance: Money;
    }[];
    totals: Money[];
  };
  receivables: OpenSide;
  payables: OpenSide;
  tax: { owed: Money; overdue: Money; claims: Money; net: Money; obligations: number } | null;
  taxReason: { code: 'RULE_GAP'; message: string; details: unknown } | null;
  work: {
    total: number;
    by: { person: number; agent: number; neither: number };
    severity: { block: number; warn: number; info: number };
    complete: boolean;
    next: string | null;
    asOfSeq: number;
  };
  deadlines: {
    kind: string;
    period: string;
    deadline: string;
    due: string | null;
    status: string;
    artifactId: string | null;
  }[];
};

/** A count beside a section in the sidebar; `more` when the engine stopped counting early. */
export type SectionCount = { count: number; more: boolean };
export type SectionCounts = Partial<Record<'review' | 'questions', SectionCount>>;

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
  /** The last `company.summary` read: no data before the first read or when it could not be read,
   * `loading` while it is read again. */
  summary: { data: Summary | null; error: string; loading: boolean };
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
  members: Members,
  export: Exports,
  setup: Setup,
};

/** A summary is read whole; anything else is reported as not read rather than shown in part. */
const isSummary = (value: unknown): value is Summary =>
  !!value &&
  typeof value === 'object' &&
  'cash' in value &&
  'receivables' in value &&
  'payables' in value &&
  'work' in value &&
  'deadlines' in value;

export default function WorkspaceView({
  company,
  onCounts,
}: {
  company: Company;
  /** Receives the sidebar's counts each time the workspace is read again. */
  onCounts?: (counts: SectionCounts) => void;
}) {
  const { section, params, href } = useAccountingNavigation();
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const [years, setYears] = useState<Year[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [summary, setSummary] = useState<{
    read: string;
    data: Summary | null;
    error: string;
  } | null>(null);
  // The summary is read again on every change to the books and each time Acasă is opened, so
  // Acasă never shows a position older than its visit.
  const [homeVisits, setHomeVisits] = useState({ section, count: 0 });
  if (homeVisits.section !== section)
    setHomeVisits({ section, count: homeVisits.count + (section === 'home' ? 1 : 0) });
  const summaryRead = `${version}:${homeVisits.count}`;
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

  // The company's summary and its open questions, read again whenever the workspace changes: Acasă
  // shows the summary, the sidebar counts what waits on a person.
  useEffect(() => {
    let active = true;
    const failure = (reason: unknown) =>
      reason instanceof Error ? reason.message : 'Situația companiei nu a putut fi citită.';
    Promise.all([
      call<unknown>('company.summary').then(
        (data) =>
          isSummary(data)
            ? { data, error: '' }
            : { data: null, error: 'Situația companiei nu a putut fi citită.' },
        (reason: unknown) => ({ data: null, error: failure(reason) }),
      ),
      call<Partial<List<unknown>>>('questions.list', { status: 'open', limit: 200 }).catch(
        () => null,
      ),
    ]).then(([read, questions]) => {
      if (!active) return;
      setSummary({ read: summaryRead, ...read });
      onCounts?.({
        ...(read.data
          ? { review: { count: read.data.work.by.person, more: !read.data.work.complete } }
          : {}),
        ...(Array.isArray(questions?.items)
          ? { questions: { count: questions.items.length, more: !!questions.next } }
          : {}),
      });
    });
    return () => {
      active = false;
    };
  }, [call, summaryRead, onCounts]);

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
    summary: {
      data: summary?.data ?? null,
      error: summary?.error ?? '',
      loading: summary?.read !== summaryRead,
    },
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
  // A part without a tab (the company's setup) is a flow of its own: no tabs, no year, no action.
  const parts = view.sections.filter((part) => !('hidden' in part));
  const flow = !parts.some((part) => part.id === section);
  const tabs =
    view.id === 'registers' && registers.active
      ? {
          label: 'Registre',
          items: registers.items,
          selectedKey: registers.active,
          onSelect: (id: string) => filter({ register: id, ...registerReset }),
        }
      : parts.length > 1 && !flow
        ? {
            label: view.navigationLabel,
            items: parts,
            selectedKey: section as string,
            onSelect: (id: string) => navigate(id as Section),
          }
        : null;
  // Registrul jurnal's primary action is a new journal entry; elsewhere it is adding documents.
  const primary =
    view.id === 'registers' && registers.active === 'jurnal' && can('ledger.general.propose')
      ? {
          label: 'Notă contabilă nouă',
          href: href('registers', {
            register: 'jurnal',
            entry: 'new',
            registerEntry: null,
            registerEntryDate: null,
          }),
        }
      : view.id !== 'documents'
        ? { label: 'Adaugă documente', href: href('documents') }
        : null;
  const body = (
    <div className="acc-body">
      <Feedback error={error} notice={notice} />
      {section === 'home' ? <SetupPrompt /> : null}
      <section className="acc-content" aria-label={view.label}>
        <Content />
      </section>
    </div>
  );
  return (
    <>
      <div className="acc-contextbar">
        <h1>{view.label}</h1>
        {flow ? null : (
          <div className="acc-contextbar-tools">
            <Select
              label="Exercițiu"
              className="acc-year"
              options={financial.map((choice) => ({ id: choice.id, label: choice.label }))}
              value={year?.id ?? null}
              onChange={(id) => id && chooseYear(id)}
            />
            {primary ? (
              <LinkButton href={primary.href} variant="primary">
                {icons.plus}
                {primary.label}
              </LinkButton>
            ) : null}
          </div>
        )}
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
