'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccountingNavigation } from './navigation';
import { JournalForm } from './review';
import { useLoad, useWorkspace } from './workspace';
import { WorkItemDetail } from './work-item-detail';
import { groupCauses } from './work-causes';
import {
  deniedReason,
  families,
  groups,
  kindFamilies,
  priority,
  severities,
  type Family,
  type WorkItem,
} from './work-model';

type Page = { items: WorkItem[]; next: string | null; asOfSeq: number };
type ItemRead = {
  state: 'open' | 'disposed' | 'resolved';
  item: WorkItem | null;
  disposition: { reason: string } | null;
};

export default function Worklist() {
  const { can, refresh } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const familyParam = params.get('family') ?? '';
  const severityParam = params.get('severity') ?? '';
  const family = Object.hasOwn(families, familyParam) ? (familyParam as Family) : '';
  const severity = Object.hasOwn(severities, severityParam)
    ? (severityParam as WorkItem['severity'])
    : '';
  return (
    <>
      <div className="acc-section-tools">
        <button className="acc-secondary" onClick={refresh}>
          Reîncarcă lista
        </button>
      </div>
      <div className="acc-work-filters">
        <label>
          Familie
          <select value={family} onChange={(event) => filter({ family: event.target.value })}>
            <option value="">Toate</option>
            {Object.entries(families).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severitate
          <select value={severity} onChange={(event) => filter({ severity: event.target.value })}>
            <option value="">Toate</option>
            <option value="block">Doar blocante</option>
            <option value="warn">Avertismente și blocante</option>
            <option value="info">Informări, avertismente și blocante</option>
          </select>
        </label>
      </div>
      <WorkPages key={`${family}:${severity}`} family={family} severity={severity} />
      {can('ledger.general.propose') ? <JournalForm /> : null}
    </>
  );
}

function WorkPages({
  family,
  severity,
}: {
  family: Family | '';
  severity: WorkItem['severity'] | '';
}) {
  const { invoke, version } = useWorkspace();
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const loadedPages = useRef(1);
  const generation = useRef(0);
  const input = JSON.stringify({
    limit: 50,
    ...(family
      ? {
          kinds: Object.entries(kindFamilies)
            .filter(([, group]) => group === family)
            .map(([kind]) => kind),
        }
      : {}),
    ...(severity ? { severity } : {}),
  });
  useEffect(() => {
    const request = ++generation.current;
    setLoading(true);
    setError('');
    (async () => {
      let result = await invoke<Page>('work.list', JSON.parse(input));
      // Rebuild the pages already visited, using fresh cursors after a decision changes the list.
      for (let index = 1; index < loadedPages.current && result.next; index++) {
        const more = await invoke<Page>('work.list', { ...JSON.parse(input), after: result.next });
        result = { ...more, items: [...result.items, ...more.items] };
      }
      if (generation.current === request) setPage(result);
    })()
      .catch((reason) => {
        if (generation.current === request)
          setError(reason instanceof Error ? reason.message : 'Lista nu a putut fi încărcată.');
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [input, invoke, version, retry]);

  const more = async () => {
    if (!page?.next || loading) return;
    const request = generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await invoke<Page>('work.list', { ...JSON.parse(input), after: page.next });
      if (generation.current !== request) return;
      loadedPages.current++;
      setPage({
        ...result,
        items: [
          ...new Map([...page.items, ...result.items].map((item) => [item.id, item])).values(),
        ],
      });
    } catch (reason) {
      if (generation.current === request)
        setError(reason instanceof Error ? reason.message : 'Lista nu a putut fi încărcată.');
    } finally {
      if (generation.current === request) setLoading(false);
    }
  };
  return (
    <div className="acc-worklist" aria-busy={loading}>
      {loading ? <p className="acc-hint">Se încarcă lista…</p> : null}
      {error ? (
        <div className="acc-work-error">
          <p role="alert" className="acc-error">
            {error}
          </p>
          <button
            className="acc-secondary"
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            Reîncearcă
          </button>
        </div>
      ) : null}
      {!loading && !error && page?.items.length === 0 ? (
        <p className="acc-empty">
          {page.next
            ? 'Continuă încărcarea listei.'
            : family || severity
              ? 'Niciun element pentru filtrele alese.'
              : 'Nimic nu așteaptă verificare.'}
        </p>
      ) : null}
      {groups.map((label, index) => {
        const items = (page?.items ?? []).filter((item) => priority(item) === index);
        return items.length ? (
          <section key={label} className="acc-work-group" aria-label={label}>
            <h2>{label}</h2>
            {groupCauses(items).map((group) => {
              const rows = group.items.map((item) => {
                const key =
                  item.subject.kind === 'proposal' ? `proposal:${item.subject.id}` : item.id;
                return (
                  <WorkRow
                    key={key}
                    item={item}
                    grouped={!!group.label && group.items.length > 1}
                    open={expanded.has(key)}
                    toggle={(open) =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                );
              });
              return group.label && group.items.length > 1 ? (
                <details className="acc-work-cause" key={group.key}>
                  <summary>
                    <span className="acc-work-cause-label">{group.label}</span>
                    <span className="acc-work-meta">
                      {group.items.length} declarații · deschide pentru perioade și pași
                    </span>
                  </summary>
                  {rows}
                </details>
              ) : (
                rows
              );
            })}
          </section>
        ) : null;
      })}
      {page?.next ? (
        <button className="acc-secondary" disabled={loading} onClick={more}>
          Mai multe elemente
        </button>
      ) : null}
    </div>
  );
}

function WorkRow({
  item,
  open,
  toggle,
  grouped,
}: {
  item: WorkItem;
  grouped: boolean;
  open: boolean;
  toggle: (open: boolean) => void;
}) {
  const { data, error } = useLoad<ItemRead>('work.get', { id: item.id }, open);
  const shown = data?.item ?? item;
  return (
    <details
      className="acc-work-item"
      data-work-kind={item.kind}
      data-work-id={item.id}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) toggle(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="acc-work-message">
          {grouped
            ? `Declarația ${String(shown.details.kind)} · ${shown.period ?? 'perioadă nespecificată'}`
            : shown.message}
        </span>
        <span className="acc-work-meta">
          <span className={shown.severity === 'block' ? 'acc-error' : ''}>
            {severities[shown.severity]}
          </span>
          <span>Termen: {shown.due ?? 'nespecificat'}</span>
          <span>Perioadă: {shown.period ?? 'nespecificată'}</span>
        </span>
        {shown.next
          .filter((step) => !step.allowed)
          .map((step, index) => (
            <span className="acc-work-access" key={index}>
              {deniedReason(step)}
            </span>
          ))}
      </summary>
      {open ? (
        <div className="acc-work-body">
          {error ? (
            <p role="alert" className="acc-error">
              {error}
            </p>
          ) : !data ? (
            <p className="acc-hint">Se încarcă elementul…</p>
          ) : data.state !== 'open' ? (
            <p>
              {data.state === 'disposed'
                ? `Elementul a fost închis. ${data.disposition?.reason ?? ''}`
                : 'Elementul nu mai așteaptă verificare.'}
            </p>
          ) : data.item ? (
            <>
              {grouped ? <p>{data.item.message}</p> : null}
              <WorkItemDetail item={data.item} />
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
