'use client';

import { useRef, useState } from 'react';
import type { InvoiceSourcePage } from 'xfactura-api/accounting-types';
import { command } from './api';

export default function InvoiceSources({
  path,
  invoiceId,
  count,
}: {
  path: string;
  invoiceId: string;
  count: number;
}) {
  const [page, setPage] = useState<InvoiceSourcePage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    pending = useRef(false);
  async function load(cursor?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await command<InvoiceSourcePage>(`${path}/capabilities/invoices.sources`, {
        invoiceId,
        limit: 25,
        ...(cursor ? { cursor } : {}),
      });
      setPage((previous) => ({
        ...next,
        items: cursor && previous ? [...previous.items, ...next.items] : next.items,
      }));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Sursele nu au putut fi încărcate. Reîncercați.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="acc-invoice-sources"
      onToggle={(event) => {
        if (event.currentTarget.open && !page) void load();
      }}
    >
      <summary>Arhive sursă · {count}</summary>
      {busy ? (
        <p className="acc-hint" role="status">
          Se încarcă sursele…
        </p>
      ) : null}
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            className="acc-secondary"
            disabled={busy}
            onClick={() => void load(page?.nextCursor ?? undefined)}
          >
            Reîncarcă sursele
          </button>
        </>
      ) : null}
      {page ? (
        <ul className="acc-document-list">
          {page.items.map((source) => (
            <li key={source.id}>
              <a href={`${path}/evidence/${source.archiveEvidenceId}`} download>
                {source.archiveFilename}
              </a>
              <code>{source.path}</code>
              <a href={`${path}/evidence/${source.evidenceId}`} download>
                XML din arhivă
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {page?.nextCursor && !error ? (
        <button
          className="acc-secondary"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          Mai multe surse
        </button>
      ) : null}
    </details>
  );
}
