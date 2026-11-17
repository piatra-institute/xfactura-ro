'use client';

import type { ReactNode } from 'react';
import { companyPath } from './api';
import { Chip } from './ui';
import {
  isReturnKey,
  operationLabel,
  returnChips,
  treatmentLabels,
  type WorkItem,
} from './work-model';
import { useList, useLoad, useWorkspace } from './workspace';
import { formatCount, formatDate, formatMinor, formatMoney, formatPeriod } from './format';

/**
 * Labels for the generic value views of Declarații, Întrebări and the D300 summary, whose values
 * carry no labels of their own. A work item's details are labelled by the engine (`ItemDetails`).
 */
const labels: Record<string, string> = {
  treatment: 'Tratament',
  version: 'Versiune',
  effectHash: 'Amprenta efectului',
  previewHash: 'Amprenta previzualizării',
  operation: 'Operațiune',
  input: 'Date de intrare',
  preview: 'Previzualizare',
  findings: 'Constatări',
  blocking: 'Blocaje',
  issues: 'Probleme',
  code: 'Cod',
  message: 'Mesaj',
  severity: 'Severitate',
  questions: 'Întrebări',
  question: 'Întrebare',
  questionId: 'Identificatorul întrebării',
  kind: 'Tip',
  subject: 'Obiect',
  state: 'Stare',
  status: 'Stare',
  id: 'Identificator',
  period: 'Perioadă',
  month: 'Lună',
  year: 'An',
  date: 'Dată',
  createdAt: 'Data și ora întrebării (UTC)',
  answeredAt: 'Data și ora răspunsului (UTC)',
  at: 'Data și ora (UTC)',
  due: 'Termen',
  number: 'Număr',
  amount: 'Sumă',
  currency: 'Monedă',
  account: 'Cont',
  counterparty: 'Partener',
  reference: 'Referință',
  filename: 'Fișier',
  hash: 'Amprentă',
  reason: 'Motiv',
  differences: 'Diferențe',
  field: 'Câmp',
  value: 'Valoare',
  count: 'Număr de cazuri',
  changed: 'Modificări',
  params: 'Parametri',
  fact: 'Fapt',
  blocks: 'Declarații blocate',
  check: 'Verificare',
  redacted: 'Date cu acces restricționat',
  waiting: 'În așteptare',
  acknowledge: 'Avertismente de confirmat',
  rulesHash: 'Amprenta regulilor',
  balances: 'Solduri',
  closing: 'Sold final',
  debit: 'Debit',
  credit: 'Credit',
  scope: 'Domeniu',
  system: 'Decizie a sistemului',
  trigger: 'Cauză',
  format: 'Format',
  wanted: 'Date necesare',
  months: 'Luni',
  correct: 'Înregistrări corecte',
  pending: 'În așteptare',
  issueDate: 'Data emiterii',
  b2c: 'Client persoană fizică',
  totals: 'Totaluri',
  net: 'Valoare fără TVA',
  tax: 'TVA',
  gross: 'Total cu TVA',
  authority: 'Sursă',
  members: 'Copii ale documentului',
  bookingDate: 'Data înregistrării',
  treasuryAccountId: 'Cont bancar sau casă',
  outcome: 'Rezultat',
  uploadId: 'Identificatorul încărcării',
  detail: 'Detalii',
  deadline: 'Regula termenului',
  artifactId: 'Identificatorul declarației',
  gap: 'Ce lipsește',
  mediaType: 'Tipul fișierului',
  size: 'Dimensiune',
  values: 'Valori',
  rootId: 'Identificatorul documentului principal',
  partyId: 'Partener',
  evidenceId: 'Document justificativ',
  documentId: 'Document',
  amountMinor: 'Sumă în unități monetare minore',
  balance: 'Sold',
  base: 'Bază',
  deductible: 'TVA deductibilă',
  paid: 'Plătit',
  remaining: 'Rămas',
  taxPeriod: 'Perioadă fiscală',
  dates: 'Date',
  proposals: 'Propuneri',
  reasons: 'Motive',
  parameter: 'Parametru',
  reviewedThrough: 'Verificat până la',
  axis: 'Încadrare',
  determination: 'Încadrare fiscală',
  posted: 'Înregistrări contabilizate',
  documentKind: 'Tipul documentului',
  name: 'Denumire',
  description: 'Explicație',
  direction: 'Direcție',
  dueDate: 'Scadență',
  rate: 'Curs',
  referenceDate: 'Data de referință',
  details: 'Detalii',
  next: 'Pași următori',
  fingerprint: 'Amprenta elementului',
  asOfSeq: 'Poziție în jurnalul de audit',
  by: 'Responsabil',
  allowed: 'Permis',
  inputHint: 'Date pentru pas',
  disposition: 'Decizie',
  needs: 'Acces necesar',
};

const valueLabels: Record<string, string> = {
  'invoice.received': 'Factură primită',
  'invoice.issued': 'Factură emisă',
  'creditNote.received': 'Notă de credit primită',
  'creditNote.issued': 'Notă de credit emisă',
  'receipt.received': 'Bon fiscal primit',
  'receipt.issued': 'Bon fiscal emis',
  'profile.fact': 'Fapt despre companie',
  'determination.confirm': 'Confirmarea încadrării',
  efactura: 'e-Factura',
  issued: 'Emis în aplicație',
  ubl_upload: 'Fișier XML încărcat',
  invoicer: 'Aplicația de facturare',
  extracted: 'Date extrase din document',
  amef: 'Casă de marcat',
  blocked: 'Blocată',
  overdue: 'Cu termen depășit',
  due: 'De pregătit',
  prepared: 'Pregătită',
  authorized: 'Autorizată',
  rejected: 'Respinsă',
  filed: 'Depusă',
  accepted: 'Acceptată',
  open: 'Deschisă',
  answered: 'Cu răspuns',
  unasked: 'Întrebare netrimisă',
  unsettled: 'Necesită clarificare',
  error: 'Eroare',
  differs: 'Diferențe',
  recorded: 'Înregistrat',
  block: 'Blocant',
  warn: 'Avertisment',
  info: 'Informare',
  buyer_message: 'Mesaj de la cumpărător',
  anaf_error: 'Eroare ANAF',
};
const moneyKeys = new Set([
  'net',
  'tax',
  'gross',
  'amount',
  'balance',
  'closing',
  'debit',
  'credit',
  'base',
  'deductible',
  'paid',
  'remaining',
]);
const ronKeys = new Set(['closing', 'debit', 'credit']);
const referenceKeys = new Set([
  'partyId',
  'evidenceId',
  'documentId',
  'treasuryAccountId',
  'members',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type Split = { visible?: unknown; technical?: unknown };

/** Identifiers and unrecognised fields remain available without becoming product copy. Minor
 * units stay raw: converting them here would add a browser calculation. */
function split(value: unknown, key = ''): Split {
  if (referenceKeys.has(key)) return { visible: value, technical: value };
  if (
    key === 'id' ||
    key.endsWith('Id') ||
    key.endsWith('Ids') ||
    key.endsWith('Hash') ||
    key === 'hash' ||
    key.endsWith('Minor') ||
    key.endsWith('Bani')
  )
    return { technical: value };
  if (Array.isArray(value)) {
    const parts = value.map((item) => split(item));
    return {
      visible: parts.some((part) => part.visible !== undefined)
        ? parts.map((part) => part.visible ?? null)
        : undefined,
      technical: parts.some((part) => part.technical !== undefined)
        ? parts.map((part) => part.technical ?? null)
        : undefined,
    };
  }
  if (isRecord(value)) {
    const visible: Record<string, unknown> = {};
    const technical: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value)) {
      const part = labels[name] ? split(entry, name) : { technical: entry };
      if (part.visible !== undefined) visible[name] = part.visible;
      if (part.technical !== undefined) technical[name] = part.technical;
    }
    return {
      visible: Object.keys(visible).length ? visible : undefined,
      technical: Object.keys(technical).length ? technical : undefined,
    };
  }
  if (
    typeof value === 'string' &&
    (uuid.test(value) ||
      (key === 'operation' && !operationLabel(value)) ||
      (key === 'treatment' && !treatmentLabels[value]))
  )
    return { technical: value };
  return { visible: value };
}

function PartyName({ id }: { id: string }) {
  const { can } = useWorkspace();
  const { data, error } = useLoad<{ name: string }>(
    'parties.get',
    { partyId: id },
    can('parties.get'),
  );
  return (
    <span>
      {error ||
        data?.name ||
        (can('parties.get') ? 'Se încarcă partenerul…' : 'Partener cu acces restricționat')}
    </span>
  );
}
export function EvidenceName({ id }: { id: string }) {
  const { company, evidence } = useWorkspace();
  const file = evidence.find((candidate) => candidate.id === id);
  return file?.filename ? (
    <a href={`${companyPath(company.id)}/evidence/${encodeURIComponent(file.id)}`}>
      {file.filename}
    </a>
  ) : file ? (
    <span>Fișier cu acces restricționat</span>
  ) : (
    <a href={`${companyPath(company.id)}/evidence/${encodeURIComponent(id)}`}>
      Deschide documentul păstrat
    </a>
  );
}
export function DocumentName({ id }: { id: string }) {
  const { can } = useWorkspace();
  const { data, error } = useLoad<{
    number: string | null;
    date: string;
    evidenceId: string | null;
  }>('documents.get', { id }, can('documents.get'));
  if (!data)
    return (
      <span>
        {error ||
          (can('documents.get') ? 'Se încarcă documentul…' : 'Document cu acces restricționat')}
      </span>
    );
  return (
    <span>
      {data.number ? `${data.number} · ${formatDate(data.date)}` : formatDate(data.date)}
      {data.evidenceId ? (
        <>
          {' '}
          · <EvidenceName id={data.evidenceId} />
        </>
      ) : null}
    </span>
  );
}
function TreasuryName({ id }: { id: string }) {
  const { can } = useWorkspace();
  const { data, error } = useList<{ id: string; name: string }>(
    'treasury.accounts',
    {},
    can('treasury.accounts'),
  );
  return (
    <span>{error || data?.find((account) => account.id === id)?.name || 'Cont indisponibil'}</span>
  );
}

function DetailValue({
  value,
  field = '',
  currency,
}: {
  value: unknown;
  field?: string;
  currency?: string;
}) {
  if (value === null || value === undefined) return <span>—</span>;
  if (field === 'partyId' && typeof value === 'string') return <PartyName id={value} />;
  if (field === 'evidenceId' && typeof value === 'string') return <EvidenceName id={value} />;
  if (field === 'documentId' && typeof value === 'string') return <DocumentName id={value} />;
  if (field === 'treasuryAccountId' && typeof value === 'string')
    return <TreasuryName id={value} />;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            {field === 'members' && typeof item === 'string' ? (
              <DocumentName id={item} />
            ) : (
              <DetailValue value={item} currency={currency} />
            )}
          </li>
        ))}
      </ul>
    ) : (
      <span>—</span>
    );
  if (isRecord(value)) {
    const unit = typeof value.currency === 'string' ? value.currency : currency;
    return (
      <dl className="acc-work-details">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd>
              <DetailValue value={item} field={key} currency={unit} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof value === 'boolean') return <span>{value ? 'Da' : 'Nu'}</span>;
  if (typeof value === 'string' && moneyKeys.has(field) && /^-?\d+\.\d+$/.test(value))
    return (
      <span className="acc-work-amount">
        {formatMoney(value, currency ?? (ronKeys.has(field) ? 'RON' : ''))}
      </span>
    );
  if (field === 'operation' && typeof value === 'string')
    return <span>{operationLabel(value)}</span>;
  if (field === 'treatment' && typeof value === 'string')
    return <span>{treatmentLabels[value]}</span>;
  if (field === 'size') return <span>{String(value)} octeți</span>;
  return <span>{valueLabels[String(value)] ?? String(value)}</span>;
}

export function WorkDetails({
  value,
  technical,
}: {
  value: unknown;
  technical?: Record<string, unknown>;
}) {
  const parts = split(value);
  return (
    <>
      {parts.visible !== undefined ? <DetailValue value={parts.visible} /> : null}
      {parts.technical !== undefined || technical ? (
        <details className="acc-disclosure acc-technical">
          <summary>Detalii tehnice</summary>
          <TechnicalValue
            value={{
              ...technical,
              ...(parts.technical !== undefined ? { details: parts.technical } : {}),
            }}
          />
        </details>
      ) : null}
    </>
  );
}

type DetailLabel = WorkItem['labels'][string];

/** Detail keys that hold codes and internal references: they appear only under „Detalii tehnice”. */
const technicalKeys = new Set([
  'code',
  'fact',
  'question',
  'deadline',
  'params',
  'subject',
  'input',
  'axis',
  'key',
  'rule',
  'rules',
  'fingerprint',
]);
/** An internal identifier written as a value: `vat.status`, `FACT_UNKNOWN`, `inventory.lists`. */
const internalCode = /^(?:[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)$/;

/** Fields inside a detail's records, which the engine labels only at the top level. */
const nestedFields: Record<string, DetailLabel> = {
  net: { label: 'Fără TVA', type: 'amount' },
  tax: { label: 'TVA', type: 'amount' },
  gross: { label: 'Total', type: 'amount' },
  amount: { label: 'Sumă', type: 'amount' },
  message: { label: 'Mesaj', type: 'text' },
  state: { label: 'Stare', type: 'text' },
  field: { label: 'Câmp', type: 'text' },
  value: { label: 'Valoare', type: 'text' },
  values: { label: 'Valori', type: 'text' },
  authority: { label: 'Sursă', type: 'text' },
  number: { label: 'Număr', type: 'text' },
  name: { label: 'Denumire', type: 'text' },
  reason: { label: 'Motiv', type: 'text' },
  date: { label: 'Dată', type: 'date' },
  month: { label: 'Lună', type: 'period' },
  period: { label: 'Perioadă', type: 'period' },
};

/** The name an identifier resolves to, by the kind the engine's label gives it; null for a kind
 * no read names. */
function idName(kind: string, id: string): ReactNode | null {
  if (kind === 'party') return <PartyName id={id} />;
  if (kind === 'evidence') return <EvidenceName id={id} />;
  if (kind === 'document') return <DocumentName id={id} />;
  if (kind === 'treasuryAccount') return <TreasuryName id={id} />;
  return null;
}

/**
 * A detail's value as a person reads it, by its label's type; null when it is a code or an
 * identifier no read names, which only „Detalii tehnice” shows.
 */
function shownValue(
  key: string,
  value: unknown,
  label: DetailLabel,
  details: Record<string, unknown>,
): ReactNode | null {
  if (value === null || value === undefined || value === '') return null;
  if (label.type === 'id') return typeof value === 'string' ? idName(label.kind, value) : null;
  if (label.type === 'text' && (technicalKeys.has(key) || /(?:Id|Ids|Hash)$|^hash$/.test(key)))
    return null;
  const currency =
    'currency' in label && label.currency
      ? label.currency
      : 'currencyKey' in label && label.currencyKey
        ? String(details[label.currencyKey] ?? '')
        : typeof details.currency === 'string'
          ? details.currency
          : '';
  switch (label.type) {
    case 'date':
      return formatDate(String(value));
    case 'period':
      return formatPeriod(String(value));
    case 'count':
      return formatCount(String(value));
    case 'amount':
      return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? (
        <span className="acc-work-amount">{formatMoney(value, currency)}</span>
      ) : null;
    case 'minor':
      return typeof value === 'string' && /^-?\d+$/.test(value) && currency ? (
        <span className="acc-work-amount">{formatMinor(value, currency)}</span>
      ) : null;
  }
  if (typeof value === 'boolean') return value ? 'Da' : 'Nu';
  if (typeof value === 'number') return formatCount(value);
  if (typeof value === 'string') {
    if (key === 'treatment') return treatmentLabels[value] ?? null;
    if (key === 'operation') return operationLabel(value) ?? null;
    if (valueLabels[value]) return valueLabels[value];
    return uuid.test(value) || internalCode.test(value) ? null : value;
  }
  if (Array.isArray(value)) {
    if (value.length && value.every(isReturnKey))
      return (
        <span className="acc-chips">
          {returnChips(value).map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </span>
      );
    const parts = value
      .map((entry) => shownValue('', entry, { label: '', type: 'text' }, details))
      .filter((part) => part !== null);
    return parts.length ? (
      <ul>
        {parts.map((part, index) => (
          <li key={index}>{part}</li>
        ))}
      </ul>
    ) : null;
  }
  if (isRecord(value)) {
    const parts = Object.entries(value).flatMap(([name, entry]) => {
      const field = nestedFields[name];
      const part = field ? shownValue(name, entry, field, { currency, ...value }) : null;
      return part === null ? [] : [[field!.label, part] as const];
    });
    return parts.length ? (
      <dl className="acc-work-details">
        {parts.map(([name, part]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{part}</dd>
          </div>
        ))}
      </dl>
    ) : null;
  }
  return null;
}

/**
 * A work item's details under the engine's labels and types: dates, periods, amounts and counts
 * formatted, identifiers named where a read names them, returns as chips. Codes, identifiers and
 * the item's own references stay under a collapsed „Detalii tehnice”.
 */
export function ItemDetails({ item }: { item: WorkItem }) {
  const details = item.details ?? {};
  const labels = item.labels ?? {};
  const shown: { key: string; label: string; value: ReactNode }[] = [];
  const technical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const label = labels[key];
    const part = label ? shownValue(key, value, label, details) : null;
    if (part !== null) shown.push({ key, label: label!.label, value: part });
    if (part === null || label?.type === 'id') technical[key] = value;
  }
  return (
    <>
      {shown.length ? (
        <dl className="acc-work-details">
          {shown.map((entry) => (
            <div key={entry.key}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="acc-disclosure acc-technical">
        <summary>Detalii tehnice</summary>
        <dl className="acc-work-details">
          {Object.entries({
            ...technical,
            id: item.id,
            subject: item.subject,
            fingerprint: item.fingerprint,
            asOfSeq: item.asOfSeq,
            next: item.next,
          }).map(([key, value]) => (
            <div key={key}>
              <dt>{labels[key]?.label ?? <code>{key}</code>}</dt>
              <dd>
                <code className="acc-technical-value">{technicalText(value)}</code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

/** A technical value verbatim: text as it is, structures as JSON. */
function technicalText(value: unknown) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Technical values stay verbatim; their known field names still use Romanian labels. */
function TechnicalValue({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <TechnicalValue value={item} />
          </li>
        ))}
      </ul>
    );
  if (isRecord(value))
    return (
      <dl className="acc-work-details">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{labels[key] ?? <code>{key}</code>}</dt>
            <dd>
              <TechnicalValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <code>{value === null || value === undefined ? '—' : String(value)}</code>;
}
