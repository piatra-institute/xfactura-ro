'use client';

import { useSearchParams } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';
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

/** The section order also declares each view's default section and owned URL filters. */
export const accountingViews = [
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
    id: 'deadlines',
    label: 'Termene',
    navigationLabel: 'Termene și declarații',
    filters: ['month', 'return', 'declarationStatus'],
    sections: [{ id: 'deadlines', label: 'Termene' }],
  },
  {
    id: 'registers',
    label: 'Registre',
    navigationLabel: 'Secțiuni registre',
    filters: [],
    sections: [
      { id: 'registers', label: 'Registre contabile' },
      { id: 'documents', label: 'Documente' },
      { id: 'bank', label: 'Bancă' },
    ],
  },
  {
    id: 'settings',
    label: 'Setări',
    navigationLabel: 'Secțiuni setări',
    filters: [],
    sections: [
      { id: 'settings', label: 'Profil și acces' },
      { id: 'periods', label: 'Luni' },
    ],
  },
] as const;
export type Section = (typeof accountingViews)[number]['sections'][number]['id'];
export const sectionLabels = Object.fromEntries(
  accountingViews.flatMap((view) => view.sections.map((section) => [section.id, section.label])),
) as Record<Section, string>;

/** Native history keeps filters and section links shareable without refetching the route. */
export function useAccountingNavigation() {
  const params = useSearchParams() ?? new URLSearchParams();
  const view =
    accountingViews.find((choice) => choice.id === params.get('view')) ?? accountingViews[0];
  const section =
    view.sections.find((choice) => choice.id === params.get('section')) ?? view.sections[0];
  const url = (target: Section, changes: Record<string, string | null> = {}) => {
    const owner = accountingViews.find((choice) =>
      choice.sections.some((child) => child.id === target),
    )!;
    const next = new URLSearchParams(params.toString());
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
    return `/contabilitate?${next}`;
  };
  const href = (target: Section, changes: Record<string, string | null> = {}) =>
    url(target, changes);
  return {
    view,
    section: section.id,
    params,
    href,
    navigate: (target: Section) => window.history.pushState(null, '', href(target)),
    filter: (changes: Record<string, string | null>) =>
      window.history.pushState(null, '', url(section.id, changes)),
  };
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
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, '', event.currentTarget.href);
  };
  return (
    <a href={href(section, changes)} onClick={follow}>
      {children}
    </a>
  );
}
