'use client';

import { useEffect, useState } from 'react';
import { useWorkspace, type List, type Workspace } from './workspace';

/** Follow engine cursors, including an empty page that still has a next cursor. */
export async function readPages<T>(
  invoke: Workspace['invoke'],
  operation: string,
  input: Record<string, unknown> = {},
) {
  const items: T[] = [];
  let after: string | null = null;
  do {
    const page: List<T> = await invoke(operation, { ...input, ...(after ? { after } : {}) });
    items.push(...page.items);
    after = page.next;
  } while (after);
  return items;
}

/** Keep the displayed evidence during a refresh, with all decisions disabled until it completes. */
export function useAccountingData<T>(
  operation: string,
  input: Record<string, unknown> = {},
  enabled = true,
  paged = false,
) {
  const { invoke, version } = useWorkspace();
  const key = JSON.stringify([operation, input]);
  const [result, setResult] = useState<{
    key: string;
    version: number;
    data: T | null;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const [operation, input] = JSON.parse(key) as [string, Record<string, unknown>];
    const request = paged ? readPages(invoke, operation, input) : invoke(operation, input);
    request
      .then((data) => {
        if (active) setResult({ key, version, data: data as T, error: '' });
      })
      .catch((reason: unknown) => {
        if (active)
          setResult((previous) => ({
            key,
            version,
            data: previous?.key === key ? previous.data : null,
            error: reason instanceof Error ? reason.message : 'Datele nu au putut fi încărcate.',
          }));
      });
    return () => {
      active = false;
    };
  }, [invoke, key, version, enabled, paged]);
  const current = enabled && result?.key === key ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? '',
    loading: enabled && current?.version !== version,
    unavailable: !enabled || current?.version !== version || !!current?.error,
  };
}
