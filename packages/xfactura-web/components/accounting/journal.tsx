'use client';

import { useEffect, useState } from 'react';
import {
  EntryLink,
  failure,
  hiddenAmount,
  monthDays,
  State,
  type JournalEntry,
  type JournalPage,
} from './register-common';
import { useWorkspace } from './workspace';
import { formatMoney } from './format';

type Loaded = {
  key: string;
  entries: JournalEntry[];
  next: number | null;
  error: string;
  loading: boolean;
};
const limit = 100;

/** Registrul jurnal for a month, a page at a time on the engine's cursor. */
export default function Journal({ month }: { month: string }) {
  const { invoke, version, year } = useWorkspace();
  const { from, to } = monthDays(month, year);
  const key = `${from}|${to}|${version}`;
  const [state, setState] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    invoke<JournalPage>('ledger.journal', { from, to, limit })
      .then((page) => {
        if (active)
          setState({ key, entries: page.entries, next: page.next, error: '', loading: false });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            key,
            entries: [],
            next: null,
            error: failure(reason, 'Registrul jurnal nu a putut fi citit.'),
            loading: false,
          });
      });
    return () => {
      active = false;
    };
  }, [invoke, key]);
  const current = state?.key === key ? state : null;
  const entries = current?.entries ?? [];

  const more = () => {
    if (!current || current.next === null) return;
    setState({ ...current, loading: true, error: '' });
    invoke<JournalPage>('ledger.journal', { from, to, after: current.next, limit })
      .then((page) =>
        setState((previous) =>
          previous?.key === key
            ? {
                ...previous,
                entries: [...previous.entries, ...page.entries],
                next: page.next,
                loading: false,
              }
            : previous,
        ),
      )
      .catch((reason: unknown) =>
        setState((previous) =>
          previous?.key === key
            ? {
                ...previous,
                loading: false,
                error: failure(reason, 'Registrul jurnal nu a putut fi citit.'),
              }
            : previous,
        ),
      );
  };

  return (
    <section>
      <h2>Registrul jurnal</h2>
      <State
        loading={!current}
        error={current?.error ?? ''}
        empty={!!current && !current.error && entries.length === 0}
      >
        Nu există înregistrări în luna aleasă.
      </State>
      {entries.map((entry) => (
        <div key={entry.id} className="acc-journal-row">
          <details className="acc-journal">
            <summary>
              {entry.number}. {entry.date} · {entry.journalCode} · {entry.description}
            </summary>
            {entry.document ? (
              <p>
                Document justificativ: {entry.document.type}
                {entry.document.number ? ` ${entry.document.number}` : ''} · {entry.document.date}
              </p>
            ) : null}
            <ul>
              {entry.lines.map((line, index) => (
                <li key={index}>
                  {line.side === 'D' ? 'Debit' : 'Credit'} {line.account} ·{' '}
                  {line.amount === null ? hiddenAmount : formatMoney(line.amount)}
                </li>
              ))}
            </ul>
          </details>
          <EntryLink
            entry={entry}
            label={`Deschide înregistrarea ${entry.number} din ${entry.date}`}
          >
            Deschide înregistrarea
          </EntryLink>
        </div>
      ))}
      {current && entries.length > 0 && current.next !== null ? (
        <button className="acc-secondary" disabled={current.loading} onClick={more}>
          {current.loading ? 'Se încarcă…' : 'Mai multe înregistrări'}
        </button>
      ) : null}
    </section>
  );
}
