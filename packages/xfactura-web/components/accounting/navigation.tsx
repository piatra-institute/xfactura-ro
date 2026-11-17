'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { useWorkspace, type Year } from './workspace';

/** Match the reporting period to the financial intervals supplied by the engine. */
export function yearForReturn(years: Year[], key: string | null | undefined) {
  const period = key?.split('|')[1];
  if (!period) return undefined;
  const candidates = years.filter(
    (year) =>
      year.kind === 'financial' &&
      (/^\d{4}-\d{2}$/.test(period)
        ? year.from.slice(0, 7) <= period && period <= year.to.slice(0, 7)
        : year.from.slice(0, 4) <= period.slice(0, 4) && period.slice(0, 4) <= year.to.slice(0, 4)),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The sidebar's sections in order. Each view declares its default section and the URL filters it
 * owns; leaving a view drops them. The first view is the default when `view` is absent.
 */
export const accountingViews = [
  {
    id: 'home',
    label: 'Acasă',
    navigationLabel: 'Acasă',
    filters: [],
    sections: [{ id: 'home', label: 'Acasă' }],
  },
  {
    id: 'review',
    label: 'De verificat',
    navigationLabel: 'Secțiuni de verificat',
    filters: ['family', 'severity'],
    sections: [{ id: 'review', label: 'De verificat' }],
  },
  {
    id: 'questions',
    label: 'Întrebări',
    navigationLabel: 'Întrebări pentru persoane',
    filters: ['question', 'questionStatus', 'questionKind'],
    sections: [{ id: 'questions', label: 'Întrebări' }],
  },
  {
    id: 'documents',
    label: 'Documente',
    navigationLabel: 'Documente',
    filters: [],
    sections: [{ id: 'documents', label: 'Documente' }],
  },
  {
    id: 'bank',
    label: 'Bancă',
    navigationLabel: 'Bancă',
    filters: [],
    sections: [{ id: 'bank', label: 'Bancă' }],
  },
  {
    id: 'registers',
    label: 'Registre',
    navigationLabel: 'Registre',
    filters: [
      'register',
      'registerMonth',
      'vatPeriod',
      'registerAccount',
      'registerEntry',
      'registerEntryDate',
      'stockItem',
      'stockWarehouse',
      'registerAsset',
      'payrollRun',
    ],
    sections: [{ id: 'registers', label: 'Registre contabile' }],
  },
  {
    id: 'deadlines',
    label: 'Declarații',
    navigationLabel: 'Declarații',
    filters: ['month', 'return', 'declarationStatus'],
    sections: [{ id: 'deadlines', label: 'Declarații' }],
  },
  {
    id: 'settings',
    label: 'Setări',
    navigationLabel: 'Părțile setărilor',
    filters: ['export'],
    // The company's setup is a part of Setări without a tab: „Companie nouă” and Acasă open it.
    sections: [
      { id: 'settings', label: 'Companie' },
      { id: 'periods', label: 'Exerciții și luni' },
      { id: 'members', label: 'Membri' },
      { id: 'export', label: 'Export' },
      { id: 'setup', label: 'Configurarea companiei', hidden: true },
    ],
  },
] as const;
export type AccountingView = (typeof accountingViews)[number];
export type ViewId = AccountingView['id'];
export type Section = AccountingView['sections'][number]['id'];
export const sectionLabels = Object.fromEntries(
  accountingViews.flatMap((view) => view.sections.map((section) => [section.id, section.label])),
) as Record<Section, string>;

/** Sections that were parts of Registre and are now views of their own. */
const movedSections = new Map<string, Section>([
  ['documents', 'documents'],
  ['bank', 'bank'],
]);

/**
 * The address of a section, built from the address as it is: the view's own filters and the
 * shared `company` and `year` stay, every other view's filters go.
 */
export function sectionUrl(
  target: Section,
  changes: Record<string, string | null> = {},
  current = '',
) {
  const owner = accountingViews.find((choice) =>
    choice.sections.some((child) => child.id === target),
  )!;
  const next = new URLSearchParams(current);
  for (const choice of accountingViews)
    for (const key of choice.filters)
      if (!(owner.filters as readonly string[]).includes(key)) next.delete(key);
  next.delete('view');
  next.delete('section');
  if (owner.id !== accountingViews[0].id) next.set('view', owner.id);
  if (target !== owner.sections[0].id) next.set('section', target);
  for (const [key, value] of Object.entries(changes)) {
    if (key !== 'year' && !(owner.filters as readonly string[]).includes(key)) continue;
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `/contabilitate?${query}` : '/contabilitate';
}

/** The address an old link stands for, when the section it names has moved to its own view. */
export function movedUrl(search: string) {
  const params = new URLSearchParams(search);
  const moved =
    params.get('view') === 'registers' ? movedSections.get(params.get('section') ?? '') : undefined;
  return moved ? sectionUrl(moved, {}, search) : null;
}

/** Native history keeps filters and section links shareable without refetching the route. */
export function useAccountingNavigation() {
  const params = useSearchParams() ?? new URLSearchParams();
  // An old Registre link shows the moved section at once; useMovedSections fixes the address.
  const requested =
    params.get('view') === 'registers'
      ? (movedSections.get(params.get('section') ?? '') ?? 'registers')
      : params.get('view');
  const view = accountingViews.find((choice) => choice.id === requested) ?? accountingViews[0];
  const section =
    view.sections.find((choice) => choice.id === params.get('section')) ?? view.sections[0];
  const href = (target: Section, changes: Record<string, string | null> = {}) =>
    sectionUrl(target, changes, params.toString());
  return {
    view,
    section: section.id as Section,
    params,
    href,
    navigate: (target: Section) => window.history.pushState(null, '', href(target)),
    /** Changes filters on the address as it is now, not as it was at the last render, so a change
     * made before the view re-renders (a register chosen, then a month) is kept. */
    filter: (changes: Record<string, string | null>) =>
      window.history.pushState(
        null,
        '',
        sectionUrl(section.id, changes, window.location.search.slice(1)),
      ),
    /** Writes a value the view already shows into the address, without a history entry, on the
     * address as it is now, so several views may write in the same render. */
    replace: (changes: Record<string, string | null>) =>
      window.history.replaceState(
        null,
        '',
        sectionUrl(section.id, changes, window.location.search.slice(1)),
      ),
  };
}

/** Replaces an old Registre link to Documente or Bancă with the section's own address. */
export function useMovedSections() {
  const params = useSearchParams();
  const search = params?.toString() ?? '';
  useEffect(() => {
    const moved = movedUrl(search);
    if (moved) window.history.replaceState(null, '', moved);
  }, [search]);
}

/** Follows a same-page link through the history, so the page keeps its state; a modified click
 * (new tab, new window) is left to the browser. Returns whether the link was followed here. */
export function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false;
  event.preventDefault();
  window.history.pushState(null, '', event.currentTarget.href);
  return true;
}

export function SectionLink({
  section,
  filters = {},
  children,
}: {
  section: Section;
  filters?: Record<string, string | null>;
  children: ReactNode;
}) {
  const { href } = useAccountingNavigation();
  const { years } = useWorkspace();
  const changes =
    section === 'deadlines' && filters.return
      ? { ...filters, year: yearForReturn(years, filters.return)?.id ?? null }
      : filters;
  return (
    <a href={href(section, changes)} onClick={followLink}>
      {children}
    </a>
  );
}
