'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountingNavigation } from './navigation';
import { ProfileCard, useFactRows } from './profile-card';
import { Button, EmptyState, Select } from './ui';
import { useWorkspace } from './workspace';
import { WorkGroups, useExpanded } from './work-rows';
import {
  arrangeWork,
  families,
  isFactItem,
  kindFamilies,
  severities,
  type Family,
  type WorkItem,
} from './work-model';

type Page = { items: WorkItem[]; next: string | null; asOfSeq: number };

/** The choice of every family or severity, which sets no filter. */
const all = 'toate';
const severityChoices = [
  { id: all, label: 'Toate' },
  { id: 'block', label: 'Doar blocante' },
  { id: 'warn', label: 'Avertismente și blocante' },
  { id: 'info', label: 'Informări, avertismente și blocante' },
];

/** De verificat: the facts to record first, then the worklist's rows by who acts. */
export default function Worklist() {
  const { refresh } = useWorkspace();
  const { params, filter } = useAccountingNavigation();
  const familyParam = params.get('family') ?? '';
  const severityParam = params.get('severity') ?? '';
  const family = Object.hasOwn(families, familyParam) ? (familyParam as Family) : '';
  const severity = Object.hasOwn(severities, severityParam)
    ? (severityParam as WorkItem['severity'])
    : '';
  const needs = useFactRows();
  return (
    <div className="acc-review-view">
      <ProfileCard needs={needs} />
      <div className="acc-work-toolbar">
        <Select
          label="Familie"
          className="acc-filter"
          options={[
            { id: all, label: 'Toate' },
            ...Object.entries(families).map(([id, label]) => ({ id, label })),
          ]}
          value={family || all}
          onChange={(value) => filter({ family: value === all ? null : value })}
        />
        <Select
          label="Severitate"
          className="acc-filter"
          options={severityChoices}
          value={severity || all}
          onChange={(value) => filter({ severity: value === all ? null : value })}
        />
        <Button variant="quiet" size="small" className="acc-work-reload" onPress={refresh}>
          Reîncarcă lista
        </Button>
      </div>
      <WorkPages
        key={`${family}:${severity}`}
        family={family}
        severity={severity}
        facts={needs.facts}
        withFacts={needs.rows.length > 0}
      />
    </div>
  );
}

function WorkPages({
  family,
  severity,
  facts,
  withFacts,
}: {
  family: Family | '';
  severity: WorkItem['severity'] | '';
  facts: ReadonlyMap<string, string>;
  /** Whether „Profilul firmei” lists facts: the list is then not reported as empty. */
  withFacts: boolean;
}) {
  const { invoke, version } = useWorkspace();
  const { filter, href } = useAccountingNavigation();
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const loadedPages = useRef(1);
  const generation = useRef(0);
  // Rows collapse items by cause, so a page reads as many items as the engine gives at once.
  const input = JSON.stringify({
    limit: 200,
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
  // Items a person settles by recording a fact are rows of „Profilul firmei”, above.
  const groups = useMemo(
    () =>
      arrangeWork(
        (page?.items ?? []).filter((item) => !isFactItem(item)),
        facts,
      ),
    [page, facts],
  );
  const expanded = useExpanded();
  return (
    <div className="acc-worklist" aria-busy={loading}>
      {loading ? <p className="acc-hint">Se încarcă lista…</p> : null}
      {error ? (
        <div className="acc-work-error">
          <p role="alert" className="acc-error">
            {error}
          </p>
          <Button size="small" isDisabled={loading} onPress={() => setRetry((value) => value + 1)}>
            Reîncearcă
          </Button>
        </div>
      ) : null}
      {!loading && !error && page && !groups.length && !(withFacts && !family && !severity) ? (
        page.next ? (
          <EmptyState message="Continuă încărcarea listei." />
        ) : family || severity ? (
          <EmptyState
            message="Niciun element pentru filtrele alese."
            action={{
              label: 'Toate elementele',
              onPress: () => filter({ family: null, severity: null }),
            }}
          />
        ) : (
          <EmptyState
            message="Nimic nu așteaptă verificare."
            action={{ label: 'Adaugă documente', href: href('documents') }}
          />
        )
      ) : null}
      <WorkGroups groups={groups} expanded={expanded} />
      {page?.next ? (
        <Button isDisabled={loading} onPress={more} className="acc-work-more">
          Mai multe elemente
        </Button>
      ) : null}
    </div>
  );
}
