import type {
  D406Filed,
  D406FiledInvoice,
  D406FiledJournal,
  D406FiledPayment,
  D406FiledTax,
  D406FiledTransaction,
  D406FiledTransactionLine,
} from 'xfactura-core/ro/saft/read';
import type { Mapping } from '../../src/mapping/schema';

// Invented identities and amounts only.
export const company = '90000017';
export const own = `00${company}`;
export const customer = '0090000025';
export const supplier = '0090000033';
export const euSupplier = '01DE999999999';

export const noTax: D406FiledTax = { type: '000', code: '000000', amount: '0.00' };
export const vat = (code: string, base: string, amount: string): D406FiledTax => ({
  type: '300',
  code,
  base,
  amount,
});
export const marker = (code: string): D406FiledTax => ({ type: '300', code, amount: '0.00' });

export const line = (
  account: string,
  side: 'debit' | 'credit',
  amount: string,
  extra: Partial<D406FiledTransactionLine> = {},
): D406FiledTransactionLine => ({
  account,
  side,
  amount: { amount },
  customer: own,
  supplier: own,
  tax: [noTax],
  ...extra,
});

export const transaction = (
  id: string,
  date: string,
  lines: D406FiledTransactionLine[],
): D406FiledTransaction => ({
  id,
  period: String(Number(date.slice(5, 7))),
  periodYear: date.slice(0, 4),
  date,
  posted: date,
  description: `Notă sintetică ${id}`,
  lines,
});

export function filed(
  transactions: D406FiledTransaction[],
  documents: {
    sales?: D406FiledInvoice[];
    purchases?: D406FiledInvoice[];
    payments?: D406FiledPayment[];
  } = {},
): D406Filed {
  const journal: D406FiledJournal = { id: '1', description: 'Jurnal', transactions };
  return {
    namespace: 'mfp:anaf:dgti:d406:declaratie:v1',
    header: {
      software: {},
      company: {
        registrationNumber: company,
        name: 'Reluare Sintetică SRL',
        taxRegistrations: [],
        ibans: [],
      },
      defaultCurrency: 'RON',
      selection: { start: '2026-01-01', end: '2026-01-31' },
    },
    masterFiles: {
      accounts: [],
      customers: [],
      suppliers: [],
      taxTable: [],
      units: [],
      products: [],
    },
    generalLedgerEntries: { journals: [journal] },
    sourceDocuments: {
      ...(documents.sales ? { salesInvoices: { invoices: documents.sales } } : {}),
      ...(documents.purchases ? { purchaseInvoices: { invoices: documents.purchases } } : {}),
      ...(documents.payments ? { payments: { payments: documents.payments } } : {}),
    },
    unread: [],
  };
}

const synthetic = (sourceId: string, code: string) => ({
  sourceId,
  standardId: code,
  controlKind: null,
  decidedBy: 'rule:account-synthetic' as const,
  confirmedByPerson: false,
  target: {
    status: 'mapped' as const,
    account: { kind: 'synthetic' as const, code, name: `Cont ${code}` },
    party: null,
    requiresOpenItem: false,
  },
});

/** A mapping of the invented chart: partners on lines, a placeholder for the VAT payable. */
export function replayMapping(confirmed = true): Mapping {
  const control = (
    sourceId: string,
    code: string,
    controlKind: Mapping['accounts'][number]['controlKind'],
    party: Extract<Mapping['accounts'][number]['target'], { status: 'mapped' }>['party'],
  ) => ({
    sourceId,
    standardId: code,
    controlKind,
    decidedBy: 'rule:control-line-party' as const,
    confirmedByPerson: false,
    target: {
      status: 'mapped' as const,
      account: { kind: 'synthetic' as const, code, name: `Cont ${code}` },
      party,
      requiresOpenItem: controlKind !== 'tax',
    },
  });
  const placeholder = (sourceAccountId: string) => `placeholder:${sourceAccountId}`;
  return {
    schemaVersion: 1,
    company,
    source: 'd406',
    accounts: [
      synthetic('1012', '1012'),
      synthetic('5121', '5121'),
      synthetic('628', '628'),
      synthetic('704', '704'),
      control('401', '401', 'payable', { kind: 'line' }),
      control('4111', '4111', 'receivable', { kind: 'line' }),
      control('4423', '4423', 'tax.payable', { kind: 'placeholder', key: placeholder('4423') }),
      control('4426', '4426', 'tax', { kind: 'placeholder', key: placeholder('4426') }),
      control('4427', '4427', 'tax', { kind: 'placeholder', key: placeholder('4427') }),
      control('4428', '4428', 'tax', { kind: 'placeholder', key: placeholder('4428') }),
      // The customs agent's account, bound to the invented supplier.
      control('462', '462', 'payable', {
        kind: 'source',
        source: { origin: 'd406', role: 'supplier', id: supplier },
      }),
    ],
    partners: [
      ['customer', customer, 'Client Sintetic SRL', 'ro_legal_entity', 'RO', '90000025'],
      ['supplier', supplier, 'Furnizor Sintetic SRL', 'ro_legal_entity', 'RO', '90000033'],
      ['supplier', euSupplier, 'Synthetic EU Supplier', 'eu_taxable', 'DE', '999999999'],
    ].map(([role, id, name, kind, country, taxId]) => ({
      source: { origin: 'd406' as const, role: role as 'customer' | 'supplier', id: id! },
      decidedBy: 'rule:partner-fiscal-create' as const,
      confirmedByPerson: false,
      target: {
        status: 'mapped' as const,
        party: {
          action: 'create' as const,
          key: `fiscal:${country}:${taxId}`,
          kind: kind as 'ro_legal_entity' | 'eu_taxable',
          country: country!,
          taxId: taxId!,
          name: name!,
        },
      },
    })),
    placeholders: ['4423', '4426', '4427', '4428'].map((sourceAccountId) => ({
      decidedBy: 'rule:control-placeholder' as const,
      confirmedByPerson: confirmed,
      placeholder: true as const,
      sourceAccountId,
      party: {
        action: 'create' as const,
        key: placeholder(sourceAccountId),
        kind: 'ro_legal_entity' as const,
        country: 'RO',
        taxId: null,
        name: 'Partener neidentificat',
      },
    })),
  };
}
