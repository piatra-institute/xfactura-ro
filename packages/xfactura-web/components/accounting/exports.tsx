'use client';

import { useEffect, useState } from 'react';
import type { JobView } from 'xfactura-api/contracts';
import { companyPath } from './api';
import { useAccountingNavigation } from './navigation';
import { Button, Chip, EmptyState, type Tone } from './ui';
import { useWorkspace } from './workspace';

const states: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'În așteptare', tone: 'neutral' },
  running: { label: 'Se pregătește', tone: 'info' },
  done: { label: 'Gata de descărcat', tone: 'success' },
  failed: { label: 'Nu a reușit', tone: 'danger' },
};
const preparing = (job: JobView) => job.status === 'pending' || job.status === 'running';

/**
 * Export: the company's complete export, requested here and followed until it can be downloaded.
 * The address keeps the export (`export`), so it is still there after a reload.
 */
export default function Exports() {
  const { company, can, invoke, act } = useWorkspace();
  const { params, replace } = useAccountingNavigation();
  const id = params.get('export');
  const readable = can('exports.get');
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState('');
  // The export the address names is read, and read again while it is being prepared.
  useEffect(() => {
    if (!id || !readable) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await invoke<JobView>('exports.get', { id });
        if (!active) return;
        setJob(next);
        setError('');
        if (preparing(next)) timer = setTimeout(read, 1500);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Exportul nu a putut fi citit.');
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, readable, invoke]);

  const request = () =>
    act(async () => {
      const created = await invoke<JobView>('exports.request');
      setJob(created);
      replace({ export: created.id });
    }, 'Exportul a fost cerut.');
  const shown = job && job.id === id ? job : null;
  const mayRequest = can('exports.request');

  if (error)
    return (
      <div className="acc-export">
        <p role="alert" className="acc-error">
          {error}
        </p>
        {mayRequest ? <Button onPress={request}>Cere un export nou</Button> : null}
      </div>
    );
  if (id && readable && !shown)
    return (
      <p className="acc-loading" aria-busy="true">
        Se citește exportul…
      </p>
    );
  if (!shown)
    return (
      <div className="acc-export">
        {mayRequest ? (
          <EmptyState
            message="Toate înregistrările și documentele companiei, inclusiv datele personale."
            action={{ label: 'Cere exportul', onPress: () => void request() }}
          />
        ) : (
          <EmptyState message="Exportul complet poate fi cerut de proprietar sau de un revizor." />
        )}
      </div>
    );
  const state = states[shown.status] ?? { label: shown.status, tone: 'neutral' as const };
  return (
    <div className="acc-export" aria-busy={preparing(shown) || undefined}>
      <dl className="acc-export-state">
        <div>
          <dt>Exportul complet</dt>
          <dd>
            <Chip tone={state.tone}>{state.label}</Chip>
          </dd>
        </div>
      </dl>
      {shown.error ? (
        <p role="alert" className="acc-error">
          {shown.error}
        </p>
      ) : null}
      <div className="acc-form-actions">
        {shown.status === 'done' ? (
          <a
            className="acc-button acc-button--primary acc-button--normal"
            href={`${companyPath(company.id)}/exports/${shown.id}`}
            download
          >
            Descarcă exportul
          </a>
        ) : null}
        {!preparing(shown) && mayRequest ? (
          <Button onPress={request}>Cere un export nou</Button>
        ) : null}
      </div>
    </div>
  );
}
