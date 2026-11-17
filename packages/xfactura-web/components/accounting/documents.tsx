'use client';

import { useState } from 'react';
import { companyPath, field } from './api';
import { useList, useWorkspace } from './workspace';
import { formatMoney } from './format';

type Document = {
  id: string;
  kind: string;
  number: string | null;
  date: string;
  currency: string | null;
  totals: { net: string; tax: string; gross: string } | null;
};
const kindLabels: Record<string, string> = {
  'invoice.issued': 'Factură emisă',
  'invoice.received': 'Factură primită',
  'creditNote.issued': 'Notă de credit emisă',
  'creditNote.received': 'Notă de credit primită',
};

export default function Documents() {
  const { company, can, evidence, upload, invoke, act, year } = useWorkspace();
  const { data: documents } = useList<Document>('documents.list', {});
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    await act(action, success);
    setBusy(false);
  };
  return (
    <>
      {can('evidence.record') ? (
        <form
          className="acc-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const file = (event.currentTarget.elements.namedItem('file') as HTMLInputElement)
              .files?.[0];
            if (file) void run(() => upload(file), `${file.name} a fost păstrat.`);
          }}
        >
          <label>
            Document original
            <input name="file" type="file" required />
          </label>
          <button disabled={busy}>Păstrează documentul</button>
        </form>
      ) : null}
      <div className="acc-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Fișier</th>
              <th scope="col">Amprentă</th>
              <th scope="col">Import</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((file) => (
              <tr key={file.id}>
                <td>
                  <a href={`${companyPath(company.id)}/evidence/${file.id}`}>{file.filename}</a>
                </td>
                <td>
                  <code>{file.hash.slice(0, 12)}</code>
                </td>
                <td className="acc-actions">
                  {can('invoices.import') ? (
                    <button
                      className="acc-secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => invoke('invoices.import', { evidenceId: file.id }),
                          'Documentul e-Factura a fost importat.',
                        )
                      }
                    >
                      Factură e-Factura
                    </button>
                  ) : null}
                  {can('bank.import') && year ? (
                    <button
                      className="acc-secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            invoke('bank.import', {
                              evidenceId: file.id,
                              financialYearId: year.id,
                            }),
                          'Extrasul a fost importat.',
                        )
                      }
                    >
                      Extras bancar
                    </button>
                  ) : null}
                  {can('fx.importBnr') ? (
                    <button
                      className="acc-secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => invoke('fx.importBnr', { evidenceId: file.id }),
                          'Cursurile BNR au fost importate.',
                        )
                      }
                    >
                      Cursuri BNR
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Facturi și note de credit</h2>
      {documents && documents.length === 0 ? (
        <p className="acc-empty">Nu există documente importate.</p>
      ) : null}
      {(documents ?? []).map((document) => (
        <DocumentRow key={document.id} document={document} documents={documents ?? []} />
      ))}
    </>
  );
}

function DocumentRow({ document, documents }: { document: Document; documents: Document[] }) {
  const { can, invoke, act } = useWorkspace();
  const sale = document.kind.endsWith('.issued');
  const credit = document.kind.startsWith('creditNote');
  const originals = documents.filter(
    (other) => other.kind === (sale ? 'invoice.issued' : 'invoice.received'),
  );
  const treatment = credit ? 'invoices.credit' : 'invoices.recognize';
  return (
    <article className="acc-review">
      <div className="acc-review-heading">
        <div>
          <h3>
            {kindLabels[document.kind] ?? document.kind} {document.number}
          </h3>
          <p>{document.date}</p>
        </div>
        {document.totals ? (
          <strong>{formatMoney(document.totals.gross, document.currency ?? 'RON')}</strong>
        ) : null}
      </div>
      {can(`${treatment}.propose`) ? (
        <form
          className="acc-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void act(
              () =>
                invoke(`${treatment}.propose`, {
                  documentId: document.id,
                  account: field(data, 'account'),
                  ...(sale ? {} : { deduction: field(data, 'deduction') }),
                  ...(credit ? { originalDocumentId: field(data, 'original') } : {}),
                }),
              'Propunerea a fost pregătită pentru verificare.',
            );
          }}
        >
          <label>
            {sale ? 'Cont de venituri' : 'Cont de cheltuieli'}
            <input name="account" defaultValue={sale ? '704' : '628'} required />
          </label>
          {sale ? null : (
            <label>
              Deducere TVA
              <select name="deduction" defaultValue="full">
                <option value="full">Integrală</option>
                <option value="none">Fără deducere</option>
              </select>
            </label>
          )}
          {credit ? (
            <label>
              Factura inițială
              <select name="original" required>
                {originals.map((original) => (
                  <option key={original.id} value={original.id}>
                    {original.number} · {original.date}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button>Pregătește înregistrarea</button>
        </form>
      ) : null}
    </article>
  );
}
