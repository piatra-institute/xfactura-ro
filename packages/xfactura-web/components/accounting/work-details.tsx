'use client';

import { companyPath, formatMoney } from './api';
import { operationLabel, treatmentLabels } from './work-model';
import { useList, useLoad, useWorkspace } from './workspace';

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
      {data.number ? `${data.number} · ${data.date}` : data.date}
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
