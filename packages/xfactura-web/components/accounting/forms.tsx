'use client';

import { useState, type FormEvent } from 'react';
import type { Overview } from 'xfactura-api/accounting-types';
import { correctionBodySchema } from 'xfactura-api/accounting';
import { amountField, command, companyPath, field, formatMoney, upload } from './api';

export type Run = (action: () => Promise<unknown>, success: string) => Promise<boolean>;
type Props = { state: Overview; run: Run; busy: boolean };

function SourceInput({
  sources,
  selectedId = '',
}: {
  sources: Overview['evidence'];
  selectedId?: string;
}) {
  return (
    <div className="acc-source-input">
      <label>
        Document existent
        <select name="evidenceId" defaultValue={selectedId}>
          <option value="">Alege sau încarcă un fișier</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.filename}
            </option>
          ))}
        </select>
      </label>
      <label>
        Fișier original <span className="acc-hint">max. 10 MB</span>
        <input name="file" type="file" />
      </label>
    </div>
  );
}
async function sourceId(companyId: string, data: FormData) {
  const file = data.get('file');
  if (file instanceof File && file.size > 0) return (await upload(companyId, file)).id;
  const existing = field(data, 'evidenceId');
  if (!existing) throw new Error('Selectează documentul original sau încarcă un fișier.');
  return existing;
}
function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export function OpeningForm({ state, run, busy }: Props) {
  return (
    <form
      className="acc-form"
      onSubmit={(event) => {
        const data = submit(event);
        void run(
          async () =>
            command(`${companyPath(state.company.id)}/opening-proposals`, {
              date: `${state.company.year}-01-01`,
              amount: amountField(data, 'amount'),
              evidenceId: await sourceId(state.company.id, data),
            }),
          'Poziția inițială este pregătită pentru revizuire.',
        );
      }}
    >
      <h2>Poziția inițială</h2>
      <p>
        Sold bancar și capital vărsat la 1 ianuarie {state.company.year}. Păstrează documentul care
        susține aceste sume.
      </p>
      <SourceInput sources={state.evidence} />
      <label>
        Sold inițial în RON
        <input name="amount" inputMode="decimal" placeholder="0,00" required />
      </label>
      <button disabled={busy} type="submit">
        Pregătește poziția inițială
      </button>
    </form>
  );
}

export function PurchaseForm({ state, run, busy }: Props) {
  return (
    <details className="acc-disclosure">
      <summary>Adaugă o factură de servicii</summary>
      <form
        className="acc-form"
        onSubmit={(event) => {
          const data = submit(event),
            form = event.currentTarget;
          void run(
            async () =>
              command(`${companyPath(state.company.id)}/purchase-proposals`, {
                evidenceId: await sourceId(state.company.id, data),
                supplier: field(data, 'supplier'),
                supplierCui: field(data, 'supplierCui'),
                invoiceNumber: field(data, 'invoiceNumber'),
                date: field(data, 'date'),
                serviceDate: field(data, 'serviceDate'),
                amount: amountField(data, 'amount'),
                description: field(data, 'description'),
                supplierCountry: 'RO',
                currency: 'RON',
                vatTreatment: 'NON_VAT',
              }),
            'Factura este pregătită pentru revizuire.',
          ).then((ok) => {
            if (ok) form.reset();
          });
        }}
      >
        <p>
          Servicii interne în RON, fără TVA. Serviciul și factura trebuie să aparțină aceleiași
          luni.
        </p>
        <SourceInput sources={state.evidence} />
        <div className="acc-form-grid">
          <label>
            Furnizor
            <input name="supplier" autoComplete="organization" required />
          </label>
          <label>
            CUI furnizor
            <input name="supplierCui" inputMode="numeric" pattern="[0-9]{2,10}" required />
          </label>
          <label>
            Număr factură
            <input name="invoiceNumber" required />
          </label>
          <label>
            Sumă în RON
            <input name="amount" inputMode="decimal" placeholder="0,00" required />
          </label>
          <label>
            Data facturii
            <input
              name="date"
              type="date"
              min={`${state.company.year}-01-01`}
              max={`${state.company.year}-12-31`}
              required
            />
          </label>
          <label>
            Data serviciului
            <input
              name="serviceDate"
              type="date"
              min={`${state.company.year}-01-01`}
              max={`${state.company.year}-12-31`}
              required
            />
          </label>
        </div>
        <label>
          Serviciul și scopul cheltuielii
          <input name="description" minLength={3} required />
        </label>
        <button disabled={busy} type="submit">
          Pregătește factura
        </button>
      </form>
    </details>
  );
}

export function StatementForm({ state, run, busy }: Props) {
  return (
    <details className="acc-disclosure">
      <summary>Importă un extras bancar</summary>
      <form
        className="acc-form"
        onSubmit={(event) => {
          const data = submit(event),
            form = event.currentTarget;
          void run(
            async () =>
              command(`${companyPath(state.company.id)}/statements`, {
                evidenceId: await sourceId(state.company.id, data),
                bankAccount: field(data, 'bankAccount'),
                statementId: field(data, 'statementId'),
                from: field(data, 'from'),
                to: field(data, 'to'),
                opening: amountField(data, 'opening'),
                closing: amountField(data, 'closing'),
              }),
            'Extrasul a fost importat. Verifică și confirmă plățile.',
          ).then((ok) => {
            if (ok) form.reset();
          });
        }}
      >
        <p>
          CSV în RON, cu identificatori stabili pentru mișcări.{' '}
          <a href="/accounting-example.csv" download>
            Descarcă modelul CSV
          </a>
          .
        </p>
        <SourceInput sources={state.evidence} />
        <div className="acc-form-grid">
          <label>
            Cont bancar
            <input
              name="bankAccount"
              defaultValue={state.statements[0]?.bankAccount ?? ''}
              required
              minLength={4}
            />
          </label>
          <label>
            Identificator extras
            <input name="statementId" required />
          </label>
          <label>
            De la
            <input name="from" type="date" required />
          </label>
          <label>
            Până la
            <input name="to" type="date" required />
          </label>
          <label>
            Sold inițial în RON
            <input name="opening" inputMode="decimal" placeholder="0,00" required />
          </label>
          <label>
            Sold final în RON
            <input name="closing" inputMode="decimal" placeholder="0,00" required />
          </label>
        </div>
        <button disabled={busy} type="submit">
          Importă și verifică soldurile
        </button>
      </form>
    </details>
  );
}

export function CorrectionForm({
  state,
  run,
  busy,
  journalId,
  draft,
  done,
  cancel,
}: Props & {
  journalId: string;
  draft?: Overview['proposals'][number];
  done: () => void;
  cancel: () => void;
}) {
  const initial = draft ? correctionBodySchema.parse(draft.body) : null;
  const purchase = state.proposals.find(
    (item) =>
      item.kind === 'purchase' &&
      (item.currentJournalId === journalId || item.id === initial?.purchaseProposalId),
  );
  const target = state.journals.find(
    (item) => item.id === (purchase?.currentJournalId ?? journalId),
  )!;
  const [action, setAction] = useState(initial?.action ?? 'replace');
  const today = new Date().toLocaleDateString('en-CA');
  let defaultDate =
    initial?.date ??
    (today.startsWith(`${state.company.year}-`) && today >= target.date ? today : target.date);
  while (
    state.closedPeriods.some(
      (period) => period.month === `${defaultDate.slice(0, 7)}-01` && period.closedAt,
    )
  ) {
    const next = new Date(`${defaultDate.slice(0, 7)}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    defaultDate = next.toISOString().slice(0, 10);
  }
  return (
    <form
      className="acc-form"
      onSubmit={(event) => {
        const data = submit(event);
        void run(
          async () =>
            command(
              `${companyPath(state.company.id)}/correction-proposals${draft ? `/${draft.id}` : ''}`,
              {
                journalId: target.id,
                evidenceId: await sourceId(state.company.id, data),
                date: field(data, 'date'),
                reason: field(data, 'reason'),
                action,
                method: 'inverse_entry',
                amount: action === 'reverse' ? '0.00' : amountField(data, 'amount'),
                ...(draft ? { version: draft.version } : {}),
              },
              draft ? 'PUT' : 'POST',
            ),
          'Corecția este pregătită pentru revizuire.',
        ).then((ok) => {
          if (ok) done();
        });
      }}
    >
      <h3>{draft ? 'Modifică propunerea' : `Corecție pentru înregistrarea #${target.number}`}</h3>
      <p>
        Sumă înregistrată:{' '}
        {formatMoney(purchase?.currentAmount ?? initial?.previousAmount ?? '0.00')}
      </p>
      <SourceInput sources={state.evidence} selectedId={initial?.evidenceId} />
      <div className="acc-form-grid">
        <label>
          Acțiune
          <select
            name="action"
            value={action}
            onChange={(event) => setAction(event.target.value as 'replace' | 'reverse')}
          >
            <option value="replace">Corectează suma</option>
            <option value="reverse">Stornează înregistrarea</option>
          </select>
        </label>
        <label>
          Data corecției
          <input
            name="date"
            type="date"
            min={target.date}
            max={`${state.company.year}-12-31`}
            defaultValue={defaultDate}
            required
          />
        </label>
        {action === 'replace' ? (
          <label>
            Sumă corectată în RON
            <input
              name="amount"
              inputMode="decimal"
              defaultValue={initial?.action === 'replace' ? initial.amount : ''}
              placeholder="0,00"
              required
            />
          </label>
        ) : null}
      </div>
      <label>
        Motivul corecției
        <input
          name="reason"
          minLength={10}
          maxLength={1000}
          defaultValue={initial?.reason ?? ''}
          required
        />
      </label>
      <div className="acc-actions">
        <button disabled={busy} type="submit">
          {draft ? 'Salvează propunerea' : 'Pregătește corecția'}
        </button>
        <button className="acc-secondary" disabled={busy} type="button" onClick={cancel}>
          Renunță
        </button>
      </div>
    </form>
  );
}
