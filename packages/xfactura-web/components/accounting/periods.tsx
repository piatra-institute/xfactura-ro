'use client';

import { useState } from 'react';
import type { ActionView } from 'xfactura-api/contracts';
import { field } from './api';
import { useLoad, useWorkspace } from './workspace';

type Finding = { code: string; severity: 'block' | 'warn'; message: string; count?: number };
type Preview = {
  month: string;
  findings: Finding[];
  balances?: { account: string; closing: string }[];
};

export default function Periods() {
  const { can, invoke, act } = useWorkspace();
  const { data: states } = useLoad<{ month: string; state: 'closed' | 'open' }[]>(
    'periods.list',
    {},
  );
  const [request, setRequest] = useState<ActionView | null>(null);
  const preview = request?.preview as Preview | undefined;
  const blocking = preview?.findings.some((finding) => finding.severity === 'block') ?? true;
  const refresh = async (id: string) => setRequest(await invoke<ActionView>('actions.get', { id }));
  return (
    <>
      <div className="acc-section-heading">
        <h2>Închiderea lunii</h2>
        <p>
          Previzualizarea arată toate verificările; închiderea se execută doar dacă nu s-a schimbat
          nimic.
        </p>
      </div>
      <ul>
        {(states ?? []).map((state) => (
          <li key={state.month}>
            {state.month}: {state.state === 'closed' ? 'închisă' : 'redeschisă'}
          </li>
        ))}
      </ul>
      {can('periods.close.request') ? (
        <form
          className="acc-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const month = field(new FormData(event.currentTarget), 'month');
            void act(
              async () => setRequest(await invoke<ActionView>('periods.close.request', { month })),
              'Verificările au fost rulate.',
            );
          }}
        >
          <label>
            Luna
            <input name="month" type="month" required />
          </label>
          <button>Verifică luna</button>
        </form>
      ) : null}
      {request && preview ? (
        <article className="acc-review">
          <div className="acc-review-heading">
            <div>
              <h3>Închidere {preview.month}</h3>
              <p>{request.status}</p>
            </div>
          </div>
          {preview.findings.length === 0 ? <p>Nicio constatare.</p> : null}
          <ul className="acc-warning">
            {preview.findings.map((finding) => (
              <li
                key={finding.code}
                className={finding.severity === 'block' ? 'acc-error' : undefined}
              >
                {finding.message}
                {finding.count ? ` (${finding.count})` : ''}
              </li>
            ))}
          </ul>
          <div className="acc-actions">
            {request.status === 'requested' && can('actions.approve') ? (
              <button
                disabled={blocking}
                onClick={() =>
                  act(async () => {
                    await invoke('actions.approve', {
                      id: request.id,
                      previewHash: request.previewHash,
                    });
                    await refresh(request.id);
                  }, 'Închiderea a fost aprobată.')
                }
              >
                Aprobă închiderea
              </button>
            ) : null}
            {request.status === 'approved' && can('actions.execute') ? (
              <button
                onClick={() =>
                  act(async () => {
                    await invoke('actions.execute', { id: request.id });
                    await refresh(request.id);
                  }, 'Luna a fost închisă.')
                }
              >
                Închide luna
              </button>
            ) : null}
          </div>
        </article>
      ) : null}
    </>
  );
}
