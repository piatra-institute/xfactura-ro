'use client';

import { useRef, useState } from 'react';
import type { BankStatementEntryPage } from 'xfactura-api/accounting-types';
import { ApiError, command, formatMoney } from './api';

export default function BankStatementEntries({
  path,
  sourceId,
}: {
  path: string;
  sourceId: string;
}) {
  const [page, setPage] = useState<BankStatementEntryPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    pending = useRef(false);
  async function load(cursor?: number) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await command<BankStatementEntryPage>(
        `${path}/capabilities/bank.statementEntries`,
        { sourceId, limit: 25, ...(cursor === undefined ? {} : { cursor }) },
      );
      setPage((previous) => ({
        ...next,
        items: cursor !== undefined && previous ? [...previous.items, ...next.items] : next.items,
      }));
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) setPage(null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Înregistrările nu au putut fi încărcate. Reîncercați.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="acc-bank-source"
      onToggle={(event) => {
        if (event.currentTarget.open && !page) void load();
      }}
    >
      <summary>Detalii din extras</summary>
      {busy ? (
        <p className="acc-hint" role="status">
          Se încarcă înregistrările…
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
            Reîncarcă înregistrările
          </button>
        </>
      ) : null}
      {page?.items.length === 0 ? <p className="acc-hint">Fără mișcări în acest interval</p> : null}
      {page?.items.map((entry) => (
        <article className="acc-bank-entry" key={entry.id}>
          <dl className="acc-review-meta">
            <div>
              <dt>Data înregistrării</dt>
              <dd>{entry.date}</dd>
            </div>
            <div>
              <dt>Data valutei</dt>
              <dd>{entry.valueDate ?? '—'}</dd>
            </div>
            <div>
              <dt>Sumă</dt>
              <dd>{formatMoney(entry.amount)}</dd>
            </div>
            {entry.bankReference ? (
              <div>
                <dt>Referință bancară</dt>
                <dd>{entry.bankReference}</dd>
              </div>
            ) : null}
            {entry.customerReference ? (
              <div>
                <dt>Referință client</dt>
                <dd>{entry.customerReference}</dd>
              </div>
            ) : null}
            {entry.reversal ? (
              <div>
                <dt>Tip</dt>
                <dd>Reversare bancară</dd>
              </div>
            ) : null}
          </dl>
          <p className="acc-bank-reference">{entry.reference}</p>
          {entry.details.length ? (
            <ul className="acc-document-list">
              {entry.details.map((detail, index) => (
                <li key={index}>
                  {[detail.debtor, detail.creditor].filter(Boolean).join(' · ')}
                  {detail.amount ? <span>{formatMoney(detail.amount)}</span> : null}
                  {detail.remittance.map((text, i) => (
                    <span key={i}>{text}</span>
                  ))}
                  {Object.entries(detail.references).map(([name, value]) => (
                    <span key={name}>
                      {name}: {value}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.charges.length ? (
            <p className="acc-hint">
              Comisioane raportate în extras:{' '}
              {entry.charges.map((row) => formatMoney(row.amount)).join(' · ')}
            </p>
          ) : null}
        </article>
      ))}
      {page?.nextCursor !== null && page?.nextCursor !== undefined && !error ? (
        <button
          className="acc-secondary"
          disabled={busy}
          onClick={() => void load(page.nextCursor!)}
        >
          Mai multe înregistrări
        </button>
      ) : null}
    </details>
  );
}
