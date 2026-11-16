'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, formatMoney, invoke, upload } from './api';
import Worklist from './worklist';
import {
  accountingViews,
  useAccountingNavigation,
  yearForReturn,
  type Section,
} from './navigation';
import Documents from './documents';
import Bank from './bank';
import Registers from './registers';
import Periods from './periods';
import Settings from './settings';
import Questions from './questions';
import Deadlines from './deadlines';

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
type Balance = { rows: { account: string; closing: { debit: string; credit: string } }[] };

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
  review: Worklist,
  questions: Questions,
  deadlines: Deadlines,
  registers: Registers,
  documents: Documents,
  bank: Bank,
  settings: Settings,
  periods: Periods,
};

/** The net closing balance of accounts with a prefix, positive on their normal side. */
const net = (balance: Balance | null, prefix: string, normal: 'debit' | 'credit' = 'debit') => {
  let bani = 0n;
  for (const row of balance?.rows ?? [])
    if (row.account.startsWith(prefix)) {
      const toBani = (value: string) => BigInt(value.replace('.', ''));
      bani += toBani(row.closing.debit) - toBani(row.closing.credit);
    }
  if (normal === 'credit') bani = -bani;
  const negative = bani < 0n;
  const digits = (negative ? -bani : bani).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

export default function WorkspaceView({ company }: { company: Company }) {
  const { section, view, navigate, params, href } = useAccountingNavigation();
  const Content = sectionComponents[section];
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const [years, setYears] = useState<Year[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const financial = years.filter((year) => year.kind === 'financial');
  const year =
    financial.find((year) => year.id === params.get('year')) ??
    yearForReturn(financial, params.get('return')) ??
    financial.at(-1);
  const yearId = year?.id ?? '';

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
  useEffect(() => {
    if (!yearId) return;
    let active = true;
    call<Balance>('ledger.trialBalance', { financialYearId: yearId })
      .then((balance) => {
        if (active) setBalance(balance);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : 'Soldurile nu au putut fi încărcate.',
          );
      });
    return () => {
      active = false;
    };
  }, [call, yearId, version]);

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
      <div className="acc-workspace-title">
        <div>
          <h1>{company.name}</h1>
          <p>CUI {company.cui}</p>
        </div>
        <div className="acc-workspace-tools">
          <button onClick={() => navigate('documents')}>Adaugă documente</button>
          <label>
            Exercițiu
            <select value={yearId} onChange={(event) => chooseYear(event.target.value)}>
              {years
                .filter((year) => year.kind === 'financial')
                .map((year) => (
                  <option key={year.id} value={year.id}>
                    {year.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
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
          <dt>Bancă și casă</dt>
          <dd>{formatMoney(net(balance, '5'))}</dd>
        </div>
        <div>
          <dt>De încasat de la clienți</dt>
          <dd>{formatMoney(net(balance, '411'))}</dd>
        </div>
        <div>
          <dt>De plătit furnizorilor</dt>
          <dd>{formatMoney(net(balance, '401', 'credit'))}</dd>
        </div>
      </dl>
      <nav className="acc-tabs" aria-label="Secțiuni contabilitate">
        {accountingViews.map(({ id, label, sections }) => (
          <button
            key={id}
            className={view.id === id ? 'acc-active' : ''}
            aria-pressed={view.id === id}
            onClick={() => navigate(sections[0].id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view.sections.length > 1 ? (
        <nav className="acc-subnav" aria-label={view.navigationLabel}>
          {view.sections.map(({ id, label }) => (
            <button key={id} aria-pressed={section === id} onClick={() => navigate(id)}>
              {label}
            </button>
          ))}
        </nav>
      ) : null}
      <section className="acc-content">
        <Content />
      </section>
    </Context.Provider>
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
