'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { formatMoney, invoke, upload } from './api';
import Review from './review';
import Documents from './documents';
import Bank from './bank';
import Registers from './registers';
import Periods from './periods';
import Settings from './settings';

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
  act: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
};
const Context = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error('useWorkspace outside a workspace');
  return value;
}

const tabs = [
  ['review', 'De verificat'],
  ['documents', 'Documente'],
  ['bank', 'Bancă'],
  ['registers', 'Registre'],
  ['periods', 'Luni'],
  ['settings', 'Configurare'],
] as const;
type Tab = (typeof tabs)[number][0];

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
  const [tab, setTab] = useState<Tab>('review');
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const [years, setYears] = useState<Year[]>([]);
  const [yearId, setYearId] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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
      const financial = known.items.filter((year) => year.kind === 'financial');
      const current = financial.find((year) => year.id === yearId) ?? financial.at(-1);
      if (current) {
        setYearId(current.id);
        setBalance(await call<Balance>('ledger.trialBalance', { financialYearId: current.id }));
      }
    })().catch(
      (reason) => active && setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      active = false;
    };
  }, [call, version, yearId]);

  const act = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      setVersion((value) => value + 1);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Operațiunea nu a reușit.');
      return false;
    }
  }, []);
  const workspace: Workspace = {
    company,
    can: (operation) => capabilities.has(operation),
    invoke: call,
    upload: (file) => upload(company.id, file),
    years,
    year: years.find((year) => year.id === yearId),
    evidence,
    version,
    act,
  };

  return (
    <Context.Provider value={workspace}>
      <div className="acc-workspace-title">
        <div>
          <h1>{company.name}</h1>
          <p>CUI {company.cui}</p>
        </div>
        <label>
          Exercițiu
          <select value={yearId} onChange={(event) => setYearId(event.target.value)}>
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
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'acc-active' : ''}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="acc-content">
        {tab === 'review' ? <Review /> : null}
        {tab === 'documents' ? <Documents /> : null}
        {tab === 'bank' ? <Bank /> : null}
        {tab === 'registers' ? <Registers /> : null}
        {tab === 'periods' ? <Periods /> : null}
        {tab === 'settings' ? <Settings /> : null}
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
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    call<T>(operation, JSON.parse(key))
      .then((result) => active && setData(result))
      .catch(
        (reason) => active && setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      active = false;
    };
  }, [call, operation, key, version, enabled]);
  return { data, error };
}
