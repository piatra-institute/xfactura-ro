import { DomainError } from '../../errors';
import { divRound, formatScaled, parseScaled } from '../../money';
import { element, leaf, serializeXml, type XmlNode } from '../../xml/write';
import { counties, euVatPrefixes } from '../geo';
import { isValidCnp, isValidCui } from '../identifiers';
import {
  d406AccountId,
  d406AccountType,
  d406AmbiguousAccounts,
  d406InStandardChart,
  d406StandardAccount,
  syntheticOf,
} from './accounts';
import { invoiceTypes, paymentMechanisms, units, vatRegimes } from './data/codes';
import { taxTypes, vatTaxCodes } from './data/tax';

/**
 * The standard audit file for tax (D406, "fișierul standard de control fiscal", SAF-T) that a
 * company keeping double-entry books on the general chart of accounts (TaxAccountingBasis A)
 * files for each VAT period: monthly (HeaderComment L) or quarterly (T), after ANAF's schema
 * Ro_SAFT_Schema_v249_2025.xsd (2.4.9) and the definitions RO_SAFT_SchemaDefCod_05.02.2026.xlsx,
 * in the namespace `mfp:anaf:dgti:d406:declaratie:v1` that ANAF's D406 validator (J2.2.18 of
 * 16.02.2026) requires.
 *
 * Written: Header; MasterFiles with GeneralLedgerAccounts, Customers, Suppliers, TaxTable,
 * UOMTable, Products and the empty AnalysisTypeTable, MovementTypeTable, Owners and Assets the
 * validator expects in a periodic file; GeneralLedgerEntries; SourceDocuments with SalesInvoices,
 * PurchaseInvoices and Payments (each written when the period has some) and the empty
 * MovementOfGoods. Left out, as the structure allows for L and T: Taxonomies (never reported),
 * PhysicalStock, Owners' entries, MovementTypeTable entries and stock movements (the on-demand
 * file C), Assets and AssetTransactions (the annual file A, written by `assets.ts`), analysis
 * codes, segmented (modal) files, withholding tax on payments and the files of non-residents
 * (NL, NT).
 *
 * Where ANAF's documents differ, this module follows the validator: AccountID is an integer
 * (analytical accounts are written as digits, 4111.01 as 411101); BaseRate is a fraction of 1;
 * UOMStandard repeats UOMBase with the factor 1, the structure's 0 not being in the validator's
 * unit list; a periodic file has at least one account, customer, supplier, VAT code, unit and
 * product; SalesInvoices, PurchaseInvoices and Payments have at least one document when written
 * (the XSD requires the sections, possibly empty). GeneralLedgerEntries/NumberOfEntries counts
 * transaction lines, as ANAF's guide says (the XSD's annotation counts transactions). Payment
 * lines are D for collections and C for payments, as the guide and ANAF's answers say.
 *
 * Partners: lines on a customer's or supplier's account name it and 0 for the other side; the
 * other lines name the company (00 and its CUI) on both. A line's TaxInformation is the caller's
 * (VAT on the base's line, TaxType 000 and TaxCode 000000 otherwise); ANAF's consistency tests
 * expect no tax amount on 4426, 4427 and 4428.
 *
 * Amounts are lei with two decimals, as decimal strings; balances are signed, debit positive.
 */

export type D406Type = 'L' | 'T';

export type D406Address = {
  /** StreetName */
  street?: string;
  /** Number */
  number?: string;
  /** AdditionalAddressDetail */
  details?: string;
  /** City */
  city: string;
  /** PostalCode */
  postalCode?: string;
  /** Region: ISO 3166-2:RO county (RO-GL, RO-B), for Romanian addresses only. */
  county?: string;
  /** Country: ISO 3166-1 alpha-2. */
  country: string;
};

/** An account of the books with its balance at the period start. */
export type D406Account = {
  /** The engine's account code: synthetic (5121) or analytical (4111.01). */
  code: string;
  /** AccountID when the code has no numeric form (see d406AccountId). */
  id?: string;
  /** AccountDescription */
  description: string;
  /** StandardAccountID, for synthetics with several standard accounts (d406AmbiguousAccounts). */
  standard?: string;
  /** Opening balance, debit positive. */
  opening: string;
};

/**
 * A customer or supplier. `id` is CustomerID/SupplierID and RegistrationNumber, formed by
 * d406PartyId; the GL lines, invoices and payments name the partner by it. A partner with
 * balances on several accounts (4111 and 419) is listed once per account, each entry with that
 * account's balance; ANAF's validator (J2.2.8) accepts the repeated id.
 */
export type D406Party = {
  id: string;
  name: string;
  address: D406Address;
  /** AccountID: the engine account holding the partner's balance (4111.01, 401.02). */
  account: string;
  /** The partner's balance on that account at the period start, debit positive. */
  opening: string;
};

/** A partner's identification, as the structure codes it (S.C.1, MF.C.3). */
export type D406PartyIdentity =
  /** 00: a Romanian entity by its CUI, without RO. */
  | { kind: 'ro'; cui: string }
  /** 01: an entity of another EU state by its VAT code (country prefix EL for Greece). */
  | { kind: 'eu'; country: string; vat: string }
  /** 02: an entity of a non-EU state by its tax code. */
  | { kind: 'foreign'; country: string; code: string }
  /** 03: an individual by CNP, or a non-resident individual by NIF. */
  | { kind: 'person'; cnp: string };

/** Foreign-currency side of an amount: CurrencyCode, CurrencyAmount and ExchangeRate. */
export type D406Currency = { code: string; amount: string; rate: string };

/** TaxInformationStructure. */
export type D406Tax = {
  /** TaxType: 300 for VAT, 000 for lines without tax relevance, or another TAX-IMP code. */
  type: string;
  /** TaxCode: a VAT code for type 300, 000000 otherwise. */
  code: string;
  /** TaxBase */
  base?: string;
  /** TaxAmount, in lei. */
  amount: string;
  /** TaxAmount in the line's currency, for a foreign-currency line. */
  currencyAmount?: string;
};

export type D406Line = {
  /** RecordID */
  id: string;
  /** The engine account. */
  account: string;
  side: 'debit' | 'credit';
  /** DebitAmount/CreditAmount, in lei. */
  amount: string;
  currency?: D406Currency;
  /** The partner of a receivable (customer) or payable (supplier) line, by its id. */
  customer?: string;
  supplier?: string;
  /** SourceDocumentID */
  document?: string;
  /** Description */
  description: string;
  /** TaxInformation; absent, TaxType 000 and TaxCode 000000 with no amount. */
  tax?: D406Tax[];
};

export type D406Transaction = {
  /** TransactionID */
  id: string;
  /** TransactionDate: the document's date. */
  date: string;
  /** GLPostingDate, within the period; Period and PeriodYear are its month and year. Defaults to
   * the document's date. */
  posted?: string;
  /** SystemEntryDate; defaults to the posting date. */
  entered?: string;
  /** Description */
  description: string;
  /** SourceID: the person or application that entered the transaction. */
  source?: string;
  lines: D406Line[];
};

export type D406Journal = {
  /** JournalID */
  id: string;
  /** Description */
  description: string;
  /** Type: the company's grouping of journals, up to nine characters. */
  type: string;
  transactions: D406Transaction[];
};

/** A good or service of the invoices (Products). */
export type D406Product = {
  /** ProductCode */
  code: string;
  /** Description */
  description: string;
  /** GoodsServicesID 01 or 02. */
  kind: 'goods' | 'services';
  /** UOMBase: a code of the Unitati_masura list (data/codes `units`). */
  unit: string;
  /** ProductCommodityCode: the NC8 code where the law requires one, 0 otherwise. */
  commodityCode?: string;
};

export type D406InvoiceLine = {
  /** AccountID: the revenue (sales) or expense/asset (purchases) account. */
  account: string;
  /** ProductCode */
  product?: string;
  /** Description */
  description: string;
  /** Quantity */
  quantity: string;
  /** InvoiceUOM; defaults to the product's unit. */
  unit?: string;
  /** UnitPrice, in lei. */
  unitPrice: string;
  /** InvoiceLineAmount, net of VAT, in lei; negative for a storno recorded in red. */
  amount: string;
  /** The line's amount in the invoice currency. */
  currency?: D406Currency;
  /** TaxPointDate; defaults to the invoice date. */
  taxPointDate?: string;
  /** DebitCreditIndicator; defaults to credit for sales and debit for purchases. A storno
   * recorded in black takes the other side with a positive amount. */
  side?: 'debit' | 'credit';
  /** TaxInformation: the line's VAT (TaxType 300 and its TaxCode). */
  tax: D406Tax[];
};

export type D406Invoice = {
  /** InvoiceNo */
  number: string;
  /** CustomerID (sales) or SupplierID (purchases). */
  party: string;
  /** AccountID: the partner's account the invoice was recorded on; defaults to the partner's
   * (its first, when it is listed on several). */
  account?: string;
  /** InvoiceDate */
  date: string;
  /** InvoiceType: 380 invoice, 381 credit note, 384 corrected, 389 self-billed, 751 for
   * accounting purposes, 575 insurer's invoice. */
  type: string;
  /** SelfBillingIndicator 389 when issued under a self-billing agreement, 0 otherwise. */
  selfBilling?: boolean;
  /** TransactionID of the GL posting. */
  transaction?: string;
  /** PaymentTerms */
  paymentTerms?: string;
  lines: D406InvoiceLine[];
};

export type D406PaymentLine = {
  /** AccountID: the partner's, a bank fee's, … account. */
  account: string;
  customer?: string;
  supplier?: string;
  /** SourceDocumentID: the invoice paid. */
  document?: string;
  description?: string;
  /** PaymentLineAmount, in lei. */
  amount: string;
  currency?: D406Currency;
  /** DebitCreditIndicator; defaults from the payment's direction. */
  side?: 'debit' | 'credit';
  tax?: D406Tax[];
};

export type D406Payment = {
  /** PaymentRefNo */
  reference: string;
  /** TransactionDate */
  date: string;
  /** PaymentMechanism of Nom_Mecanisme_plati; PaymentMethod follows from it. */
  mechanism: string;
  /** Description */
  description: string;
  /** collection (încasare) lines are D, payment (plată) lines C. */
  direction: 'collection' | 'payment';
  /** TransactionID of the GL posting. */
  transaction?: string;
  lines: D406PaymentLine[];
};

export type D406 = {
  /** HeaderComment: L monthly, T quarterly. */
  type: D406Type;
  /** The period's last month; a quarter ends in March, June, September or December. */
  period: { year: number; month: number };
  /** AuditFileDateCreated */
  created: string;
  /** SoftwareCompanyName, SoftwareID, SoftwareVersion */
  software: { company: string; name: string; version: string };
  company: {
    /** CUI, digits only. */
    cui: string;
    name: string;
    address: D406Address;
    /** Contact: the person ANAF may contact and a telephone number. */
    contact: { firstName: string; lastName: string; phone: string; email?: string };
    /** BankAccount: IBANs, at least one. */
    ibans: string[];
    /** TaxRegistration TaxType, Nomenclator_Regim_fiscal (data/codes `vatRegimes`); a company
     * registered for VAT writes RegistrationNumber with the RO prefix. */
    vatRegime: string;
  };
  accounts: D406Account[];
  customers: D406Party[];
  suppliers: D406Party[];
  products: D406Product[];
  journals: D406Journal[];
  salesInvoices: D406Invoice[];
  purchaseInvoices: D406Invoice[];
  payments: D406Payment[];
};

export const d406Namespace = 'mfp:anaf:dgti:d406:declaratie:v1';

/** The structure's partner code for an identity (S.C.1). */
export function d406PartyId(identity: D406PartyIdentity): string {
  switch (identity.kind) {
    case 'ro':
      return `00${identity.cui}`;
    case 'eu':
      return `01${identity.country}${identity.vat}`;
    case 'foreign':
      return `02${identity.country}${identity.code}`;
    case 'person':
      return `03${identity.cnp}`;
  }
}

const euCountries = new Set(Object.values(euVatPrefixes).filter((code) => code !== 'RO'));

/** Why a CustomerID/SupplierID does not follow the structure's codes, or undefined. */
export function partyIdError(id: string, customer: boolean): string | undefined {
  if (id.length > 35) return 'are cel mult 35 de caractere';
  const kind = id.slice(0, 2);
  const rest = id.slice(2);
  const country = rest.slice(0, 2);
  switch (kind) {
    case '00':
      return /^\d{2,10}$/.test(rest) && isValidCui(rest)
        ? undefined
        : 'după 00 urmează un CUI valid, fără RO';
    case '01':
      return euCountries.has(country) && /^[A-Z0-9+*]{2,12}$/.test(rest.slice(2))
        ? undefined
        : 'după 01 urmează codul de TVA al unui alt stat membru, cu prefixul țării';
    case '02':
    case '05':
    case '06':
      return /^[A-Z]{2}$/.test(country) && country !== 'RO' && rest.length > 2
        ? undefined
        : `după ${kind} urmează codul țării și codul partenerului`;
    case '03':
    case '09':
      return /^[1-9]\d{12}$/.test(rest) && (kind === '09' || isValidCnp(rest) || /^[78]/.test(rest))
        ? undefined
        : `după ${kind} urmează 13 cifre (CNP sau NIF)`;
    case '04':
      return /^[A-Za-z0-9]+$/.test(rest)
        ? undefined
        : 'după 04 urmează un cod fără caractere speciale';
    case '08':
      return customer && rest === '0000000000000'
        ? undefined
        : '08 se folosește doar pentru clienții neidentificați, ca 080000000000000';
    default:
      return 'începe cu tipul codului (00, 01, 02, 03, 04, 05, 06, 08 sau 09)';
  }
}

const quarterEnds = [3, 6, 9, 12];
const pad = (value: number) => String(value).padStart(2, '0');
const isDate = (text: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);

/** SelectionStartDate and SelectionEndDate of a period. */
export function d406Period(model: Pick<D406, 'type' | 'period'>): { start: string; end: string } {
  const { year, month } = model.period;
  const first = model.type === 'T' ? month - 2 : month;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad(first)}-01`, end: `${year}-${pad(month)}-${pad(last)}` };
}

const amountPattern = /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const ratePattern = /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/;
const lei = (text: string) => parseScaled(text, 2);
const text = (cents: bigint) => formatScaled(cents, 2);

/** Lei of a currency amount at a rate, rounded as the validator does: to four decimals, then two. */
export function d406ConvertedAmount(currency: D406Currency): bigint {
  const product = parseScaled(currency.amount, 2) * parseScaled(currency.rate, 4);
  return divRound(divRound(product, 100n, 'halfAwayFromZero'), 100n, 'halfAwayFromZero');
}

type Problem = { code: string; path: string; message: string };

const lineAmounts = (model: D406) => [
  ...model.journals.flatMap((journal, j) =>
    journal.transactions.flatMap((transaction, t) =>
      transaction.lines.map((line, l) => ({
        path: `journals.${j}.transactions.${t}.lines.${l}`,
        amount: line.amount,
        currency: line.currency,
        tax: line.tax ?? [],
      })),
    ),
  ),
  ...(['salesInvoices', 'purchaseInvoices'] as const).flatMap((kind) =>
    model[kind].flatMap((invoice, i) =>
      invoice.lines.map((line, l) => ({
        path: `${kind}.${i}.lines.${l}`,
        amount: line.amount,
        currency: line.currency,
        tax: line.tax,
      })),
    ),
  ),
  ...model.payments.flatMap((payment, p) =>
    payment.lines.map((line, l) => ({
      path: `payments.${p}.lines.${l}`,
      amount: line.amount,
      currency: line.currency,
      tax: line.tax ?? [],
    })),
  ),
];

/** The inputs calculateD406 cannot use: amounts, rates, accounts and partners it cannot resolve. */
function inputProblems(model: D406): Problem[] {
  const problems: Problem[] = [];
  const amount = (path: string, value: unknown) => {
    if (typeof value !== 'string' || !amountPattern.test(value))
      problems.push({
        code: 'D406_AMOUNT',
        path,
        message: 'Suma se scrie în lei cu cel mult două zecimale și 16 cifre întregi.',
      });
  };
  const currency = (path: string, value: D406Currency | undefined) => {
    if (!value) return;
    amount(`${path}.amount`, value.amount);
    if (!/^[A-Z]{3}$/.test(value.code) || value.code === 'RON')
      problems.push({
        code: 'D406_CURRENCY',
        path: `${path}.code`,
        message: 'Valuta se scrie prin codul ISO 4217, alta decât RON.',
      });
    if (
      typeof value.rate !== 'string' ||
      !ratePattern.test(value.rate) ||
      /^0(\.0*)?$/.test(value.rate)
    )
      problems.push({
        code: 'D406_RATE',
        path: `${path}.rate`,
        message: 'Cursul de schimb este pozitiv, cu cel mult patru zecimale.',
      });
  };
  model.accounts.forEach((account, index) => amount(`accounts.${index}.opening`, account.opening));
  for (const kind of ['customers', 'suppliers'] as const)
    model[kind].forEach((party, index) => amount(`${kind}.${index}.opening`, party.opening));
  for (const line of lineAmounts(model)) {
    amount(`${line.path}.amount`, line.amount);
    currency(`${line.path}.currency`, line.currency);
    line.tax.forEach((tax, index) => {
      const path = `${line.path}.tax.${index}`;
      amount(`${path}.amount`, tax.amount);
      if (tax.base !== undefined) amount(`${path}.base`, tax.base);
      if (tax.currencyAmount !== undefined) amount(`${path}.currencyAmount`, tax.currencyAmount);
    });
  }
  for (const kind of ['salesInvoices', 'purchaseInvoices'] as const)
    model[kind].forEach((invoice, i) =>
      invoice.lines.forEach((line, l) =>
        amount(`${kind}.${i}.lines.${l}.unitPrice`, line.unitPrice),
      ),
    );

  const accounts = new Set(model.accounts.map((account) => account.code));
  const account = (path: string, code: string) => {
    if (!accounts.has(code))
      problems.push({
        code: 'D406_ACCOUNT_UNKNOWN',
        path,
        message: `Contul ${code} nu figurează în lista conturilor (GeneralLedgerAccounts).`,
      });
  };
  const customers = new Set(model.customers.map((party) => party.id));
  const suppliers = new Set(model.suppliers.map((party) => party.id));
  const party = (path: string, id: string | undefined, set: Set<string>, label: string) => {
    if (id !== undefined && !set.has(id))
      problems.push({
        code: 'D406_PARTY_UNKNOWN',
        path,
        message: `${label} ${id} nu figurează în lista ${label === 'Clientul' ? 'clienților' : 'furnizorilor'}.`,
      });
  };
  for (const kind of ['customers', 'suppliers'] as const)
    model[kind].forEach((entry, index) => account(`${kind}.${index}.account`, entry.account));
  model.journals.forEach((journal, j) =>
    journal.transactions.forEach((transaction, t) =>
      transaction.lines.forEach((line, l) => {
        const path = `journals.${j}.transactions.${t}.lines.${l}`;
        account(`${path}.account`, line.account);
        party(`${path}.customer`, line.customer, customers, 'Clientul');
        party(`${path}.supplier`, line.supplier, suppliers, 'Furnizorul');
        if (line.side !== 'debit' && line.side !== 'credit')
          problems.push({
            code: 'D406_SIDE',
            path: `${path}.side`,
            message: 'Linia este pe debit sau pe credit.',
          });
      }),
    ),
  );
  for (const [kind, set, label] of [
    ['salesInvoices', customers, 'Clientul'],
    ['purchaseInvoices', suppliers, 'Furnizorul'],
  ] as const)
    model[kind].forEach((invoice, i) => {
      party(`${kind}.${i}.party`, invoice.party, set, label);
      if (invoice.account !== undefined) account(`${kind}.${i}.account`, invoice.account);
      invoice.lines.forEach((line, l) => account(`${kind}.${i}.lines.${l}.account`, line.account));
    });
  model.payments.forEach((payment, p) =>
    payment.lines.forEach((line, l) => {
      const path = `payments.${p}.lines.${l}`;
      account(`${path}.account`, line.account);
      party(`${path}.customer`, line.customer, customers, 'Clientul');
      party(`${path}.supplier`, line.supplier, suppliers, 'Furnizorul');
    }),
  );
  return problems;
}

export type D406Balance = { opening: bigint; debit: bigint; credit: bigint; closing: bigint };

export type D406AccountTotals = D406Balance & {
  code: string;
  /** AccountID */
  id: string | undefined;
  /** StandardAccountID */
  standard: string | undefined;
  type: 'Activ' | 'Pasiv' | 'Bifunctional' | undefined;
};

export type D406InvoiceTotals = {
  /** TaxInformationTotals per TaxType and TaxCode. */
  taxes: { type: string; code: string; base: bigint; amount: bigint }[];
  /** NetTotal, GrossTotal */
  net: bigint;
  gross: bigint;
};

export type D406Calculation = {
  namespace: string;
  period: { start: string; end: string };
  /** The company as partner of its own lines (00 and its CUI). */
  companyId: string;
  accounts: D406AccountTotals[];
  customers: (D406Balance & { id: string })[];
  suppliers: (D406Balance & { id: string })[];
  /** GeneralLedgerEntries: NumberOfEntries (lines), transactions, TotalDebit, TotalCredit. */
  ledger: { lines: number; transactions: number; debit: bigint; credit: bigint };
  sales: { count: number; debit: bigint; credit: bigint; invoices: D406InvoiceTotals[] };
  purchases: { count: number; debit: bigint; credit: bigint; invoices: D406InvoiceTotals[] };
  payments: { count: number; debit: bigint; credit: bigint; gross: bigint[] };
  /** TaxTable: VAT codes used, ascending. */
  vatCodes: string[];
  /** UOMTable: units used, in order of first use. */
  units: string[];
};

const signed = (side: 'debit' | 'credit', cents: bigint) => (side === 'debit' ? cents : -cents);

function invoiceTotals(invoice: D406Invoice, normal: 'debit' | 'credit'): D406InvoiceTotals {
  const taxes = new Map<string, D406InvoiceTotals['taxes'][number]>();
  let net = 0n;
  let vat = 0n;
  for (const line of invoice.lines) {
    // Lines on the invoice's usual side add, lines recorded on the other side subtract.
    const sign = (line.side ?? normal) === normal ? 1n : -1n;
    net += sign * lei(line.amount);
    for (const tax of line.tax) {
      const key = `${tax.type}|${tax.code}`;
      const total = taxes.get(key) ?? { type: tax.type, code: tax.code, base: 0n, amount: 0n };
      total.base += sign * lei(tax.base ?? line.amount);
      total.amount += sign * lei(tax.amount);
      taxes.set(key, total);
      if (tax.type === '300') vat += sign * lei(tax.amount);
    }
  }
  return { taxes: [...taxes.values()], net, gross: net + vat };
}

/**
 * Closing balances, partner balances, the ledger's and source documents' totals and counts, and
 * the tax codes and units the tables list. Throws when an amount, rate, account or partner is not
 * one the file can carry; checkD406 lists those without throwing.
 */
export function calculateD406(model: D406): D406Calculation {
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);

  const balances = new Map(
    model.accounts.map((account) => [
      account.code,
      { opening: lei(account.opening), debit: 0n, credit: 0n, closing: 0n },
    ]),
  );
  const partyBalance = (party: D406Party) => ({
    id: party.id,
    account: party.account,
    opening: lei(party.opening),
    debit: 0n,
    credit: 0n,
    closing: 0n,
  });
  // A partner's balance is kept per account: a line adds to the entry of its partner and account.
  const key = (id: string, account: string) => `${id}|${account}`;
  const customers = new Map(
    model.customers.map((party) => [key(party.id, party.account), partyBalance(party)]),
  );
  const suppliers = new Map(
    model.suppliers.map((party) => [key(party.id, party.account), partyBalance(party)]),
  );
  const ledger = { lines: 0, transactions: 0, debit: 0n, credit: 0n };
  const vatCodes = new Set<string>();
  const used = (taxes: readonly D406Tax[] | undefined) => {
    for (const tax of taxes ?? []) if (tax.type === '300') vatCodes.add(tax.code);
  };
  for (const journal of model.journals)
    for (const transaction of journal.transactions) {
      ledger.transactions += 1;
      for (const line of transaction.lines) {
        const cents = lei(line.amount);
        ledger.lines += 1;
        const balance = balances.get(line.account)!;
        if (line.side === 'debit') {
          ledger.debit += cents;
          balance.debit += cents;
        } else {
          ledger.credit += cents;
          balance.credit += cents;
        }
        const party =
          (line.customer && customers.get(key(line.customer, line.account))) ||
          (line.supplier && suppliers.get(key(line.supplier, line.account)));
        if (party) {
          if (line.side === 'debit') party.debit += cents;
          else party.credit += cents;
        }
        used(line.tax);
      }
    }
  for (const entry of [...balances.values(), ...customers.values(), ...suppliers.values()])
    entry.closing = entry.opening + entry.debit - entry.credit;

  const documents = (invoices: D406Invoice[], normal: 'debit' | 'credit') => {
    let debit = 0n;
    let credit = 0n;
    for (const invoice of invoices)
      for (const line of invoice.lines) {
        if ((line.side ?? normal) === 'debit') debit += lei(line.amount);
        else credit += lei(line.amount);
        used(line.tax);
      }
    return {
      count: invoices.length,
      debit,
      credit,
      invoices: invoices.map((invoice) => invoiceTotals(invoice, normal)),
    };
  };
  const sales = documents(model.salesInvoices, 'credit');
  const purchases = documents(model.purchaseInvoices, 'debit');
  const payments = { count: model.payments.length, debit: 0n, credit: 0n, gross: [] as bigint[] };
  for (const payment of model.payments) {
    let gross = 0n;
    for (const line of payment.lines) {
      const cents = lei(line.amount);
      if (paymentSide(payment, line) === 'debit') payments.debit += cents;
      else payments.credit += cents;
      gross += cents;
      used(line.tax);
    }
    payments.gross.push(gross);
  }

  const unitsUsed = new Set<string>();
  const products = new Map(model.products.map((product) => [product.code, product]));
  for (const product of model.products) unitsUsed.add(product.unit);
  for (const invoice of [...model.salesInvoices, ...model.purchaseInvoices])
    for (const line of invoice.lines) {
      const unit = line.unit ?? (line.product ? products.get(line.product)?.unit : undefined);
      if (unit) unitsUsed.add(unit);
    }

  return {
    namespace: d406Namespace,
    period: d406Period(model),
    companyId: `00${model.company.cui}`,
    accounts: model.accounts.map((account) => ({
      code: account.code,
      id: account.id ?? d406AccountId(account.code),
      standard: d406StandardAccount(account.code, account.standard),
      type: d406AccountType(account.code),
      ...balances.get(account.code)!,
    })),
    customers: [...customers.values()].map(({ account: _account, ...balance }) => balance),
    suppliers: [...suppliers.values()].map(({ account: _account, ...balance }) => balance),
    ledger,
    sales,
    purchases,
    payments,
    vatCodes: [...vatCodes].sort(),
    units: [...unitsUsed],
  };
}

const paymentSide = (payment: D406Payment, line: D406PaymentLine) =>
  line.side ?? (payment.direction === 'collection' ? 'debit' : 'credit');

const indicator = (side: 'debit' | 'credit') => (side === 'debit' ? 'D' : 'C');

/** AmountStructure: lei, then the currency side (RON and the same amount for a lei amount). */
function amountStructure(
  name: string,
  cents: bigint,
  currency?: { code: string; amount: string; rate: string },
) {
  return element(
    name,
    null,
    leaf('Amount', text(cents)),
    leaf('CurrencyCode', currency?.code ?? 'RON'),
    leaf('CurrencyAmount', currency ? text(lei(currency.amount)) : text(cents)),
    currency && leaf('ExchangeRate', currency.rate),
  );
}

/** AddressStructure, as Address, BillingAddress or PostalAddress. */
export function address(value: D406Address, name = 'Address') {
  return element(
    name,
    null,
    leaf('StreetName', value.street),
    leaf('Number', value.number),
    leaf('AdditionalAddressDetail', value.details),
    leaf('City', value.city),
    leaf('PostalCode', value.postalCode),
    leaf('Region', value.county),
    leaf('Country', value.country),
  );
}

function taxInformation(name: string, tax: D406Tax, currency?: D406Currency) {
  const percentage = tax.type === '300' ? vatTaxCodes[tax.code]?.percentage : undefined;
  return element(
    name,
    null,
    leaf('TaxType', tax.type),
    leaf('TaxCode', tax.code),
    leaf('TaxPercentage', percentage ?? undefined),
    leaf('TaxBase', tax.base === undefined ? undefined : text(lei(tax.base))),
    amountStructure(
      'TaxAmount',
      lei(tax.amount),
      currency && tax.currencyAmount !== undefined
        ? { ...currency, amount: tax.currencyAmount }
        : undefined,
    ),
  );
}

const noTax: D406Tax = { type: '000', code: '000000', amount: '0' };

/** Opening/closing balance elements: the side of the balance's sign, or the account's usual side
 * for a zero balance, always as a positive amount. */
export function balance(prefix: 'Opening' | 'Closing', cents: bigint, creditWhenZero: boolean) {
  const credit = cents < 0n || (cents === 0n && creditWhenZero);
  return leaf(`${prefix}${credit ? 'Credit' : 'Debit'}Balance`, text(credit ? -cents : cents));
}

/** Names every element in the namespace, under ANAF's prefix nsSAFT. */
export function prefixed(node: XmlNode): XmlNode {
  return { ...node, name: `nsSAFT:${node.name}`, children: node.children.map(prefixed) };
}

/** What every file's Header holds: the file's creation, the software and the company. */
export type D406HeaderInput = Pick<D406, 'created' | 'software' | 'company'>;

/** The Header of a file of type `comment` (L, T, A) for its selection, in the schema's order. */
export function headerElement(
  model: D406HeaderInput,
  selection: { start: string; end: string },
  comment: string,
) {
  const { company } = model;
  const vatRegistered = company.vatRegime === '100010' || company.vatRegime === '100040';
  return element(
    'Header',
    null,
    leaf('AuditFileVersion', '2.0'),
    leaf('AuditFileCountry', 'RO'),
    leaf('AuditFileRegion', company.address.county),
    leaf('AuditFileDateCreated', model.created),
    leaf('SoftwareCompanyName', model.software.company),
    leaf('SoftwareID', model.software.name),
    leaf('SoftwareVersion', model.software.version),
    element(
      'Company',
      null,
      leaf('RegistrationNumber', vatRegistered ? `RO${company.cui}` : company.cui),
      leaf('Name', company.name),
      address(company.address),
      element(
        'Contact',
        null,
        element(
          'ContactPerson',
          null,
          leaf('FirstName', company.contact.firstName),
          leaf('LastName', company.contact.lastName),
        ),
        leaf('Telephone', company.contact.phone),
        leaf('Email', company.contact.email),
      ),
      element(
        'TaxRegistration',
        null,
        leaf('TaxRegistrationNumber', company.cui),
        leaf('TaxType', company.vatRegime),
        leaf('TaxAuthority', 'ANAF'),
      ),
      company.ibans.map((iban) => element('BankAccount', null, leaf('IBANNumber', iban))),
    ),
    leaf('DefaultCurrencyCode', 'RON'),
    element(
      'SelectionCriteria',
      null,
      leaf('SelectionStartDate', selection.start),
      leaf('SelectionEndDate', selection.end),
    ),
    leaf('HeaderComment', comment),
    leaf('SegmentIndex', '1'),
    leaf('TotalSegmentsInsequence', '1'),
    leaf('TaxAccountingBasis', 'A'),
  );
}

type ErrorOf = (code: string, path: string, message: string) => void;

/** A text field's presence and length. */
export function checkText(
  error: ErrorOf,
  path: string,
  value: string | undefined,
  label: string,
  max: number,
  required = false,
) {
  if (value === undefined || !value.trim()) {
    if (required) error('D406_TEXT', path, `Completați ${label}.`);
  } else if (value.length > max)
    error('D406_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
}

/** A date written as AAAA-LL-ZZ. */
export function checkDate(error: ErrorOf, path: string, value: string | undefined, label: string) {
  if (value !== undefined && !isDate(value))
    error('D406_DATE', path, `${label} se scrie ca dată AAAA-LL-ZZ.`);
}

/** An AddressStructure's fields, country and county. */
export function checkAddress(error: ErrorOf, path: string, value: D406Address) {
  checkText(error, `${path}.street`, value.street, 'strada', 70);
  checkText(error, `${path}.number`, value.number, 'numărul', 18);
  checkText(error, `${path}.details`, value.details, 'detaliile adresei', 70);
  checkText(error, `${path}.city`, value.city, 'localitatea', 35, true);
  checkText(error, `${path}.postalCode`, value.postalCode, 'codul poștal', 18);
  if (!/^[A-Z]{2}$/.test(value.country))
    error('D406_ADDRESS', `${path}.country`, 'Țara se scrie prin codul ISO din două litere.');
  if (value.county !== undefined) {
    if (value.country !== 'RO')
      error(
        'D406_ADDRESS',
        `${path}.county`,
        'Județul (Region) se completează doar pentru adrese din România.',
      );
    else if (!counties[value.county])
      error(
        'D406_ADDRESS',
        `${path}.county`,
        `Județul ${value.county} nu există în nomenclatorul ISO3166-1A2 - RO Dept Codes.`,
      );
  }
}

/** The Header's checks: the creation date, the software and the company. */
export function checkHeader(error: ErrorOf, model: D406HeaderInput) {
  checkDate(error, 'created', model.created, 'Data creării fișierului');
  checkText(
    error,
    'software.company',
    model.software.company,
    'producătorul programului',
    70,
    true,
  );
  checkText(error, 'software.name', model.software.name, 'numele programului', 256, true);
  checkText(error, 'software.version', model.software.version, 'versiunea programului', 18, true);
  const { company } = model;
  if (!/^\d{2,10}$/.test(company.cui) || !isValidCui(company.cui))
    error(
      'D406_CUI',
      'company.cui',
      'Codul de identificare fiscală al companiei nu este valid; se scrie fără RO.',
    );
  checkText(error, 'company.name', company.name, 'denumirea companiei', 70, true);
  checkAddress(error, 'company.address', company.address);
  checkText(
    error,
    'company.contact.firstName',
    company.contact.firstName,
    'prenumele persoanei de contact',
    35,
    true,
  );
  checkText(
    error,
    'company.contact.lastName',
    company.contact.lastName,
    'numele persoanei de contact',
    70,
    true,
  );
  checkText(error, 'company.contact.phone', company.contact.phone, 'telefonul', 18, true);
  checkText(error, 'company.contact.email', company.contact.email, 'e-mailul', 70);
  if (!company.ibans.length)
    error('D406_BANK', 'company.ibans', 'Se declară cel puțin un cont bancar (IBAN) al companiei.');
  company.ibans.forEach((iban, index) => {
    if (
      !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) ||
      (iban.startsWith('RO') && iban.length !== 24)
    )
      error('D406_BANK', `company.ibans.${index}`, `IBAN-ul ${iban} nu are formatul ISO 13616.`);
  });
  if (!vatRegimes[company.vatRegime])
    error(
      'D406_REGIME',
      'company.vatRegime',
      'Regimul de TVA se alege din Nomenclator_Regim_fiscal.',
    );
}

/**
 * Writes the file as one `AuditFile` in the d406 namespace, with the prefix nsSAFT of ANAF's
 * examples, in the schema's order. Closing balances, partner balances, totals, counts, the tax
 * table and the units table are computed. Throws on the errors checkD406 reports.
 */
export function writeD406(model: D406): string {
  const blocking = checkD406(model).find((check) => check.severity === 'error');
  if (blocking) throw new DomainError(blocking.code, blocking.message);
  const calculation = calculateD406(model);
  const accountIds = new Map(calculation.accounts.map((account) => [account.code, account.id!]));
  const accountId = (code: string) => accountIds.get(code)!;
  const own = calculation.companyId;
  // A receivable or payable line names its partner and 0 for the other; the rest name the
  // company on both.
  const partners = (line: { customer?: string; supplier?: string }) =>
    line.customer !== undefined
      ? { customer: line.customer, supplier: '0' }
      : line.supplier !== undefined
        ? { customer: '0', supplier: line.supplier }
        : { customer: own, supplier: own };
  const products = new Map(model.products.map((product) => [product.code, product]));

  const party = (entry: D406Party, totals: D406Balance, kind: 'Customer' | 'Supplier') =>
    element(
      kind,
      null,
      element(
        'CompanyStructure',
        null,
        leaf('RegistrationNumber', entry.id),
        leaf('Name', entry.name),
        address(entry.address),
      ),
      leaf(`${kind}ID`, entry.id),
      leaf('AccountID', accountId(entry.account)),
      balance('Opening', totals.opening, kind === 'Supplier'),
      balance('Closing', totals.closing, kind === 'Supplier'),
    );

  const invoices = (
    section: 'SalesInvoices' | 'PurchaseInvoices',
    entries: D406Invoice[],
    totals: D406Calculation['sales'],
  ) => {
    if (!entries.length) return undefined;
    const sales = section === 'SalesInvoices';
    // A partner listed on several accounts is found by its first entry.
    const parties = new Map(
      (sales ? model.customers : model.suppliers)
        .map((entry) => [entry.id, entry] as const)
        .reverse(),
    );
    return element(
      section,
      null,
      leaf('NumberOfEntries', String(totals.count)),
      leaf('TotalDebit', text(totals.debit)),
      leaf('TotalCredit', text(totals.credit)),
      entries.map((invoice, index) => {
        const partner = parties.get(invoice.party)!;
        const invoiceTotals = totals.invoices[index]!;
        return element(
          'Invoice',
          null,
          leaf('InvoiceNo', invoice.number),
          element(
            sales ? 'CustomerInfo' : 'SupplierInfo',
            null,
            leaf(sales ? 'CustomerID' : 'SupplierID', invoice.party),
            address(partner.address, 'BillingAddress'),
          ),
          leaf('AccountID', accountId(invoice.account ?? partner.account)),
          leaf('InvoiceDate', invoice.date),
          leaf('InvoiceType', invoice.type),
          leaf('PaymentTerms', invoice.paymentTerms),
          leaf('SelfBillingIndicator', invoice.selfBilling ? '389' : '0'),
          leaf('TransactionID', invoice.transaction),
          invoice.lines.map((line, number) => {
            const product = line.product ? products.get(line.product) : undefined;
            return element(
              'InvoiceLine',
              null,
              leaf('LineNumber', String(number + 1)),
              leaf('AccountID', accountId(line.account)),
              product && leaf('GoodsServicesID', product.kind === 'goods' ? '01' : '02'),
              leaf('ProductCode', line.product),
              leaf('ProductDescription', product?.description),
              leaf('Quantity', line.quantity),
              leaf('InvoiceUOM', line.unit ?? product?.unit),
              leaf('UnitPrice', text(lei(line.unitPrice))),
              leaf('TaxPointDate', line.taxPointDate ?? invoice.date),
              leaf('Description', line.description),
              amountStructure('InvoiceLineAmount', lei(line.amount), line.currency),
              leaf('DebitCreditIndicator', indicator(line.side ?? (sales ? 'credit' : 'debit'))),
              line.tax.map((tax) => taxInformation('TaxInformation', tax, line.currency)),
            );
          }),
          element(
            'InvoiceDocumentTotals',
            null,
            invoiceTotals.taxes.map((tax) =>
              taxInformation('TaxInformationTotals', {
                type: tax.type,
                code: tax.code,
                base: text(tax.base),
                amount: text(tax.amount),
              }),
            ),
            leaf('NetTotal', text(invoiceTotals.net)),
            leaf('GrossTotal', text(invoiceTotals.gross)),
          ),
        );
      }),
    );
  };

  const header = headerElement(model, calculation.period, model.type);

  const masterFiles = element(
    'MasterFiles',
    null,
    element(
      'GeneralLedgerAccounts',
      null,
      model.accounts.map((account, index) => {
        const totals = calculation.accounts[index]!;
        const creditWhenZero = totals.type === 'Pasiv';
        return element(
          'Account',
          null,
          leaf('AccountID', totals.id),
          leaf('AccountDescription', account.description),
          leaf('StandardAccountID', totals.standard),
          leaf('AccountType', totals.type),
          balance('Opening', totals.opening, creditWhenZero),
          balance('Closing', totals.closing, creditWhenZero),
        );
      }),
    ),
    element(
      'Customers',
      null,
      model.customers.map((entry, index) =>
        party(entry, calculation.customers[index]!, 'Customer'),
      ),
    ),
    element(
      'Suppliers',
      null,
      model.suppliers.map((entry, index) =>
        party(entry, calculation.suppliers[index]!, 'Supplier'),
      ),
    ),
    element(
      'TaxTable',
      null,
      element(
        'TaxTableEntry',
        null,
        leaf('TaxType', '300'),
        leaf('Description', taxTypes['300']),
        calculation.vatCodes.map((code) =>
          element(
            'TaxCodeDetails',
            null,
            leaf('TaxCode', code),
            leaf('Description', vatTaxCodes[code]!.description.slice(0, 256)),
            leaf('TaxPercentage', vatTaxCodes[code]!.percentage!),
            // Full right of deduction; the validator reads BaseRate as a fraction of 1.
            leaf('BaseRate', '1'),
            leaf('Country', 'RO'),
          ),
        ),
      ),
    ),
    element(
      'UOMTable',
      null,
      calculation.units.map((unit) =>
        element(
          'UOMTableEntry',
          null,
          leaf('UnitOfMeasure', unit),
          leaf('Description', units[unit]),
        ),
      ),
    ),
    element('AnalysisTypeTable', null),
    element('MovementTypeTable', null),
    element(
      'Products',
      null,
      model.products.map((product) =>
        element(
          'Product',
          null,
          leaf('ProductCode', product.code),
          leaf('GoodsServicesID', product.kind === 'goods' ? '01' : '02'),
          leaf('Description', product.description),
          leaf('ProductCommodityCode', product.commodityCode ?? '0'),
          leaf('UOMBase', product.unit),
          // The structure's 0 for "no conversion" is not in the validator's unit list; a unit
          // equal to its base converts by 1.
          leaf('UOMStandard', product.unit),
          leaf('UOMToUOMBaseConversionFactor', '1'),
        ),
      ),
    ),
    element('Owners', null),
    element('Assets', null),
  );

  const generalLedger = element(
    'GeneralLedgerEntries',
    null,
    leaf('NumberOfEntries', String(calculation.ledger.lines)),
    leaf('TotalDebit', text(calculation.ledger.debit)),
    leaf('TotalCredit', text(calculation.ledger.credit)),
    model.journals.map((journal) =>
      element(
        'Journal',
        null,
        leaf('JournalID', journal.id),
        leaf('Description', journal.description),
        leaf('Type', journal.type),
        journal.transactions.map((transaction) => {
          const posted = transaction.posted ?? transaction.date;
          const named = transaction.lines.map(partners);
          const distinct = (ids: string[]) => [
            ...new Set(ids.filter((id) => id !== '0' && id !== own)),
          ];
          const customers = distinct(named.map((entry) => entry.customer));
          const suppliers = distinct(named.map((entry) => entry.supplier));
          // The transaction names its partner when it has exactly one, the company otherwise.
          const header =
            customers.length === 1 && suppliers.length === 0
              ? { customer: customers[0]!, supplier: '0' }
              : suppliers.length === 1 && customers.length === 0
                ? { customer: '0', supplier: suppliers[0]! }
                : { customer: own, supplier: own };
          return element(
            'Transaction',
            null,
            leaf('TransactionID', transaction.id),
            leaf('Period', String(Number(posted.slice(5, 7)))),
            leaf('PeriodYear', posted.slice(0, 4)),
            leaf('TransactionDate', transaction.date),
            leaf('SourceID', transaction.source),
            leaf('Description', transaction.description),
            leaf('SystemEntryDate', transaction.entered ?? posted),
            leaf('GLPostingDate', posted),
            leaf('CustomerID', header.customer),
            leaf('SupplierID', header.supplier),
            transaction.lines.map((line, index) =>
              element(
                'TransactionLine',
                null,
                leaf('RecordID', line.id),
                leaf('AccountID', accountId(line.account)),
                leaf('SourceDocumentID', line.document),
                leaf('CustomerID', named[index]!.customer),
                leaf('SupplierID', named[index]!.supplier),
                leaf('Description', line.description),
                amountStructure(
                  line.side === 'debit' ? 'DebitAmount' : 'CreditAmount',
                  lei(line.amount),
                  line.currency,
                ),
                (line.tax?.length ? line.tax : [noTax]).map((tax) =>
                  taxInformation('TaxInformation', tax, line.currency),
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );

  const payments =
    model.payments.length > 0 &&
    element(
      'Payments',
      null,
      leaf('NumberOfEntries', String(calculation.payments.count)),
      leaf('TotalDebit', text(calculation.payments.debit)),
      leaf('TotalCredit', text(calculation.payments.credit)),
      model.payments.map((payment, index) =>
        element(
          'Payment',
          null,
          leaf('PaymentRefNo', payment.reference),
          leaf('Period', String(Number(payment.date.slice(5, 7)))),
          leaf('PeriodYear', payment.date.slice(0, 4)),
          leaf('TransactionID', payment.transaction),
          leaf('TransactionDate', payment.date),
          leaf('PaymentMethod', paymentMechanisms[payment.mechanism]!.method),
          leaf('Description', payment.description),
          payment.lines.map((line, number) => {
            const named = partners(line);
            return element(
              'PaymentLine',
              null,
              leaf('LineNumber', String(number + 1)),
              leaf('SourceDocumentID', line.document),
              leaf('AccountID', accountId(line.account)),
              leaf('CustomerID', named.customer),
              leaf('SupplierID', named.supplier),
              leaf('Description', line.description),
              leaf('DebitCreditIndicator', indicator(paymentSide(payment, line))),
              amountStructure('PaymentLineAmount', lei(line.amount), line.currency),
              (line.tax?.length ? line.tax : [noTax]).map((tax) =>
                taxInformation('TaxInformation', tax, line.currency),
              ),
            );
          }),
          element('PaymentSettlement', null, leaf('PaymentMechanism', payment.mechanism)),
          element(
            'PaymentDocumentTotals',
            null,
            leaf('GrossTotal', text(calculation.payments.gross[index]!)),
          ),
        ),
      ),
    );

  const root = prefixed(
    element(
      'AuditFile',
      null,
      header,
      masterFiles,
      generalLedger,
      element(
        'SourceDocuments',
        null,
        invoices('SalesInvoices', model.salesInvoices, calculation.sales),
        invoices('PurchaseInvoices', model.purchaseInvoices, calculation.purchases),
        payments,
        element('MovementOfGoods', null),
      ),
    ),
  );
  return serializeXml({ ...root, attributes: [['xmlns:nsSAFT', d406Namespace]] });
}

export type D406Check = {
  code: string;
  /** error: the validator rejects the file, or ANAF's consistency tests or the structure's rules
   * fail; warning: a rule the file can pass but ANAF's checks would question. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

/**
 * The structure's rules, the validator's (formats, lists, the account plan, currency amounts,
 * the period of the file type) and ANAF's published consistency tests (balanced openings and
 * entries, VAT amounts against their bases), with Romanian messages. ANAF's validator remains the
 * oracle for the formats; the consistency tests run after filing.
 */
export function checkD406(model: D406): D406Check[] {
  const checks: D406Check[] = [];
  const add = (severity: D406Check['severity'], code: string, path: string, message: string) =>
    checks.push({ code, severity, path, message });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const warning = (code: string, path: string, message: string) =>
    add('warning', code, path, message);
  const textField = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => checkText(error, path, value, label, max, required);
  const date = (path: string, value: string | undefined, label: string) =>
    checkDate(error, path, value, label);
  const addressCheck = (path: string, value: D406Address) => checkAddress(error, path, value);

  // Period and header.
  const { year, month } = model.period;
  const validPeriod =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= 2020 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12;
  if (!validPeriod) error('D406_PERIOD', 'period', 'Perioada este o lună între 2020 și 2100.');
  if (model.type !== 'L' && model.type !== 'T')
    error('D406_TYPE', 'type', 'Fișierul periodic este lunar (L) sau trimestrial (T).');
  else if (validPeriod && model.type === 'T' && !quarterEnds.includes(month))
    error(
      'D406_TYPE',
      'period',
      'Fișierul trimestrial se depune pentru trimestre calendaristice: luna perioadei este 3, 6, 9 sau 12.',
    );
  checkHeader(error, model);

  for (const problem of inputProblems(model)) error(problem.code, problem.path, problem.message);

  // Accounts.
  const ids = new Map<string, string>();
  if (!model.accounts.length)
    error(
      'D406_ACCOUNTS',
      'accounts',
      'Fișierul periodic cuprinde cel puțin un cont (GeneralLedgerAccounts).',
    );
  const codes = new Set<string>();
  model.accounts.forEach((account, index) => {
    const path = `accounts.${index}`;
    if (codes.has(account.code))
      error('D406_ACCOUNT_DUPLICATE', path, `Contul ${account.code} apare de mai multe ori.`);
    codes.add(account.code);
    textField(`${path}.description`, account.description, 'denumirea contului', 256, true);
    const synthetic = syntheticOf(account.code);
    if (/^9/.test(account.code))
      error('D406_CLASS', path, `Conturile din clasa 9 (${account.code}) nu se raportează.`);
    if (!d406AccountType(account.code))
      error(
        'D406_ACCOUNT',
        path,
        `Contul ${account.code} nu face parte din planul de conturi OMFP 1802/2014.`,
      );
    const id = account.id ?? d406AccountId(account.code);
    if (id === undefined)
      error(
        'D406_ACCOUNT_ID',
        `${path}.id`,
        `Contul ${account.code} nu are o formă numerică neechivocă; completați AccountID (cifre, începând cu ${synthetic}).`,
      );
    else if (!/^[1-9]\d{2,69}$/.test(id) || !id.startsWith(synthetic))
      error(
        'D406_ACCOUNT_ID',
        `${path}.id`,
        `AccountID ${id} este un număr care începe cu contul sintetic ${synthetic}.`,
      );
    else if (!d406InStandardChart(id))
      error(
        'D406_ACCOUNT_PLAN',
        `${path}.id`,
        `AccountID ${id} nu corespunde planului de conturi standard: primele cifre nu formează un cont al planului.`,
      );
    else if (ids.has(id))
      error(
        'D406_ACCOUNT_ID',
        `${path}.id`,
        `Conturile ${ids.get(id)} și ${account.code} au același AccountID ${id}.`,
      );
    else ids.set(id, account.code);
    const choices = d406AmbiguousAccounts[synthetic];
    if (!d406StandardAccount(account.code, account.standard))
      error(
        'D406_STANDARD_ACCOUNT',
        `${path}.standard`,
        choices
          ? `Contul ${synthetic} corespunde mai multor conturi standard (${choices.join(', ')}); alegeți unul.`
          : `Contul ${account.code} nu are corespondent în planul de conturi standard ANAF (PlanConturiBalSocCom).`,
      );
  });

  // Partners.
  for (const [kind, label, customer] of [
    ['customers', 'client', true],
    ['suppliers', 'furnizor', false],
  ] as const) {
    if (!model[kind].length)
      error('D406_PARTIES', kind, `Fișierul periodic cuprinde cel puțin un ${label}.`);
    const seen = new Set<string>();
    model[kind].forEach((entry, index) => {
      const path = `${kind}.${index}`;
      const reason = partyIdError(entry.id, customer);
      if (reason)
        error('D406_PARTY_ID', `${path}.id`, `Codul ${label}ului ${entry.id}: ${reason}.`);
      if (seen.has(`${entry.id}|${entry.account}`))
        error(
          'D406_PARTY_DUPLICATE',
          `${path}.id`,
          `Codul ${entry.id} apare de mai multe ori printre ${kind === 'customers' ? 'clienți' : 'furnizori'} pe contul ${entry.account}.`,
        );
      seen.add(`${entry.id}|${entry.account}`);
      textField(`${path}.name`, entry.name, `denumirea ${label}ului`, 256, true);
      addressCheck(`${path}.address`, entry.address);
    });
  }

  // Ledger entries.
  const { start, end } = validPeriod ? d406Period(model) : { start: '', end: '' };
  if (!model.journals.length || model.journals.every((journal) => !journal.transactions.length))
    error(
      'D406_JOURNALS',
      'journals',
      'Fișierul periodic cuprinde cel puțin o tranzacție în registrul jurnal.',
    );
  const records = new Set<string>();
  const transactions = new Set<string>();
  model.journals.forEach((journal, j) => {
    textField(`journals.${j}.id`, journal.id, 'identificatorul jurnalului', 18, true);
    textField(`journals.${j}.description`, journal.description, 'descrierea jurnalului', 256, true);
    textField(`journals.${j}.type`, journal.type, 'tipul jurnalului', 9, true);
    if (!journal.transactions.length)
      error(
        'D406_JOURNALS',
        `journals.${j}.transactions`,
        `Jurnalul ${journal.id} nu are tranzacții.`,
      );
    journal.transactions.forEach((transaction, t) => {
      const path = `journals.${j}.transactions.${t}`;
      textField(`${path}.id`, transaction.id, 'numărul notei contabile', 70, true);
      if (transactions.has(transaction.id))
        error(
          'D406_TRANSACTION_DUPLICATE',
          `${path}.id`,
          `Nota contabilă ${transaction.id} apare de mai multe ori.`,
        );
      transactions.add(transaction.id);
      textField(
        `${path}.description`,
        transaction.description,
        'descrierea notei contabile',
        256,
        true,
      );
      textField(`${path}.source`, transaction.source, 'sursa notei contabile', 35);
      date(`${path}.date`, transaction.date, 'Data documentului');
      date(`${path}.posted`, transaction.posted, 'Data înregistrării');
      date(`${path}.entered`, transaction.entered, 'Data introducerii');
      const posted = transaction.posted ?? transaction.date;
      if (validPeriod && isDate(posted) && (posted < start || posted > end))
        error(
          'D406_POSTED',
          `${path}.posted`,
          `Nota ${transaction.id} este înregistrată în afara perioadei (${posted}).`,
        );
      if (!transaction.lines.length)
        error('D406_LINES', `${path}.lines`, `Nota ${transaction.id} nu are linii.`);
      let difference = 0n;
      transaction.lines.forEach((line, l) => {
        const at = `${path}.lines.${l}`;
        textField(`${at}.id`, line.id, 'identificatorul liniei', 18, true);
        if (records.has(line.id))
          error('D406_RECORD_DUPLICATE', `${at}.id`, `Linia ${line.id} apare de mai multe ori.`);
        records.add(line.id);
        textField(`${at}.description`, line.description, 'descrierea liniei', 256, true);
        textField(`${at}.document`, line.document, 'documentul sursă', 35);
        if (/^[89]/.test(line.account))
          error(
            'D406_CLASS',
            `${at}.account`,
            'Înregistrările în conturile din clasele 8 și 9 nu se raportează.',
          );
        if (line.customer !== undefined && line.supplier !== undefined)
          error('D406_PARTY', at, 'O linie privește un client sau un furnizor, nu pe amândoi.');
        if (amountPattern.test(line.amount)) difference += signed(line.side, lei(line.amount));
      });
      if (difference !== 0n)
        error(
          'D406_UNBALANCED',
          path,
          `Nota ${transaction.id} nu este echilibrată: debitul diferă de credit cu ${text(difference < 0n ? -difference : difference)} lei.`,
        );
    });
  });

  // Invoices and payments.
  const products = new Map(model.products.map((product) => [product.code, product]));
  if (!model.products.length)
    error(
      'D406_PRODUCTS',
      'products',
      'Fișierul periodic cuprinde cel puțin un produs sau serviciu (Products).',
    );
  model.products.forEach((product, index) => {
    const path = `products.${index}`;
    textField(`${path}.code`, product.code, 'codul produsului', 70, true);
    textField(`${path}.description`, product.description, 'descrierea produsului', 256, true);
    if (!units[product.unit])
      error(
        'D406_UNIT',
        `${path}.unit`,
        `Unitatea ${product.unit} nu este printre unitățile extrase din Unitati_masura.`,
      );
    if (product.commodityCode !== undefined && !/^(0|\d{8})$/.test(product.commodityCode))
      error(
        'D406_COMMODITY',
        `${path}.commodityCode`,
        'Codul NC are opt cifre (0 când nu se aplică).',
      );
  });
  for (const kind of ['salesInvoices', 'purchaseInvoices'] as const)
    model[kind].forEach((invoice, i) => {
      const path = `${kind}.${i}`;
      textField(`${path}.number`, invoice.number, 'numărul facturii', 70, true);
      date(`${path}.date`, invoice.date, 'Data facturii');
      if (!invoiceTypes[invoice.type])
        error(
          'D406_INVOICE_TYPE',
          `${path}.type`,
          `Tipul de factură ${invoice.type} nu este permis (380, 381, 384, 389, 751, 575).`,
        );
      textField(`${path}.paymentTerms`, invoice.paymentTerms, 'termenul de plată', 70);
      if (!invoice.lines.length)
        error('D406_LINES', `${path}.lines`, `Factura ${invoice.number} nu are linii.`);
      invoice.lines.forEach((line, l) => {
        const at = `${path}.lines.${l}`;
        textField(`${at}.description`, line.description, 'descrierea liniei', 256, true);
        if (!/^-?\d{1,16}(\.\d{1,6})?$/.test(line.quantity))
          error('D406_QUANTITY', `${at}.quantity`, 'Cantitatea are cel mult șase zecimale.');
        if (line.product !== undefined && !products.has(line.product))
          error(
            'D406_PRODUCT_UNKNOWN',
            `${at}.product`,
            `Produsul ${line.product} nu figurează în lista produselor.`,
          );
        if (line.unit !== undefined && !units[line.unit])
          error(
            'D406_UNIT',
            `${at}.unit`,
            `Unitatea ${line.unit} nu este printre unitățile extrase din Unitati_masura.`,
          );
        date(`${at}.taxPointDate`, line.taxPointDate, 'Data exigibilității');
        if (!line.tax.length)
          error('D406_TAX', `${at}.tax`, 'Linia de factură are informații fiscale (TVA).');
      });
    });
  model.payments.forEach((payment, p) => {
    const path = `payments.${p}`;
    textField(`${path}.reference`, payment.reference, 'referința plății', 35, true);
    textField(`${path}.description`, payment.description, 'descrierea plății', 256, true);
    date(`${path}.date`, payment.date, 'Data plății');
    if (!paymentMechanisms[payment.mechanism])
      error(
        'D406_MECHANISM',
        `${path}.mechanism`,
        `Mecanismul de plată ${payment.mechanism} nu există în Nom_Mecanisme_plati.`,
      );
    if (!payment.lines.length)
      error('D406_LINES', `${path}.lines`, `Plata ${payment.reference} nu are linii.`);
    payment.lines.forEach((line, l) => {
      if (line.customer !== undefined && line.supplier !== undefined)
        error(
          'D406_PARTY',
          `${path}.lines.${l}`,
          'O linie de plată privește un client sau un furnizor, nu pe amândoi.',
        );
    });
  });

  // Tax information and currency amounts on every line.
  for (const line of lineAmounts(model)) {
    if (
      line.currency &&
      amountPattern.test(line.amount) &&
      amountPattern.test(line.currency.amount) &&
      ratePattern.test(line.currency.rate)
    ) {
      if (d406ConvertedAmount(line.currency) !== lei(line.amount))
        error(
          'D406_CONVERSION',
          `${line.path}.amount`,
          `Suma în lei (${line.amount}) diferă de ${line.currency.amount} ${line.currency.code} × ${line.currency.rate}.`,
        );
      line.tax.forEach((tax, index) => {
        if (tax.currencyAmount === undefined && lei(tax.amount) !== 0n)
          error(
            'D406_CONVERSION',
            `${line.path}.tax.${index}.currencyAmount`,
            'Taxa unei linii în valută se dă și în valută.',
          );
        else if (
          tax.currencyAmount !== undefined &&
          amountPattern.test(tax.currencyAmount) &&
          d406ConvertedAmount({ ...line.currency!, amount: tax.currencyAmount }) !== lei(tax.amount)
        )
          error(
            'D406_CONVERSION',
            `${line.path}.tax.${index}.amount`,
            `TVA în lei (${tax.amount}) diferă de ${tax.currencyAmount} × ${line.currency!.rate}.`,
          );
      });
    }
    line.tax.forEach((tax, index) => {
      const at = `${line.path}.tax.${index}`;
      if (!taxTypes[tax.type])
        error(
          'D406_TAX_TYPE',
          `${at}.type`,
          `Tipul de taxă ${tax.type} nu există în nomenclatorul TAX-IMP.`,
        );
      else if (tax.type === '300') {
        const entry = vatTaxCodes[tax.code];
        if (!entry)
          error(
            'D406_TAX_CODE',
            `${at}.code`,
            `Codul de taxă TVA ${tax.code} nu există printre codurile active.`,
          );
        else if (entry.percentage === null)
          error(
            'D406_TAX_CODE',
            `${at}.code`,
            `Codul de taxă ${tax.code} nu are o cotă unică; nu este acoperit.`,
          );
        else if (amountPattern.test(tax.amount) && amountPattern.test(tax.base ?? line.amount)) {
          // ANAF's consistency tests 20–22: the rate applied to the base gives the VAT.
          const base = lei(tax.base ?? line.amount);
          const expected = divRound(
            base * BigInt(Math.round(Number(entry.percentage) * 100)),
            10000n,
            'halfAwayFromZero',
          );
          const vat = lei(tax.amount);
          if (vat !== 0n && (vat - expected > 1n || expected - vat > 1n))
            warning(
              'D406_VAT',
              `${at}.amount`,
              `TVA (${tax.amount}) nu este ${entry.percentage}% din bază (${text(base)}).`,
            );
        }
      } else if (tax.code !== '000000')
        error(
          'D406_TAX_CODE',
          `${at}.code`,
          'Pentru alte taxe decât TVA codul de taxă este 000000.',
        );
      if (tax.type === '000' && amountPattern.test(tax.amount) && lei(tax.amount) !== 0n)
        error(
          'D406_TAX_AMOUNT',
          `${at}.amount`,
          'Liniile fără relevanță fiscală (000) au suma taxei 0.',
        );
    });
  }
  model.journals.forEach((journal, j) =>
    journal.transactions.forEach((transaction, t) =>
      transaction.lines.forEach((line, l) => {
        // Tests 4–6: VAT accounts carry no tax amount; the VAT sits on the base's line.
        if (/^442[678]/.test(line.account))
          (line.tax ?? []).forEach((tax, index) => {
            if (amountPattern.test(tax.amount) && lei(tax.amount) !== 0n)
              warning(
                'D406_VAT_ACCOUNT',
                `journals.${j}.transactions.${t}.lines.${l}.tax.${index}`,
                'Pe liniile conturilor 4426, 4427 și 4428 suma taxei este 0; TVA se raportează pe linia bazei.',
              );
          });
      }),
    ),
  );

  if (checks.some((check) => check.severity === 'error')) return checks;
  const calculation = calculateD406(model);

  // Tests 12–13: opening and closing balances of classes 1–7 balance.
  for (const moment of ['opening', 'closing'] as const) {
    const total = calculation.accounts
      .filter((account) => /^[1-7]/.test(account.code))
      .reduce((sum, account) => sum + account[moment], 0n);
    if (total !== 0n)
      error(
        'D406_BALANCES',
        'accounts',
        `Soldurile ${moment === 'opening' ? 'inițiale' : 'finale'} ale conturilor din clasele 1–7 nu sunt echilibrate (diferență ${text(total)} lei).`,
      );
  }
  // A partner account's balance is the sum of its partners'.
  const byAccount = new Map<string, bigint>();
  for (const [kind, totals] of [
    ['customers', calculation.customers],
    ['suppliers', calculation.suppliers],
  ] as const)
    model[kind].forEach((entry, index) =>
      byAccount.set(entry.account, (byAccount.get(entry.account) ?? 0n) + totals[index]!.opening),
    );
  for (const [code, sum] of byAccount) {
    const account = calculation.accounts.find((entry) => entry.code === code)!;
    if (account.opening !== sum)
      warning(
        'D406_PARTY_BALANCE',
        'accounts',
        `Soldul inițial al contului ${code} (${text(account.opening)}) diferă de suma soldurilor partenerilor (${text(sum)}).`,
      );
  }
  model.journals.forEach((journal, j) =>
    journal.transactions.forEach((transaction, t) =>
      transaction.lines.forEach((line, l) => {
        if (
          byAccount.has(line.account) &&
          line.customer === undefined &&
          line.supplier === undefined
        )
          warning(
            'D406_PARTY_LINE',
            `journals.${j}.transactions.${t}.lines.${l}`,
            `Linia pe contul de terți ${line.account} nu numește clientul sau furnizorul.`,
          );
      }),
    ),
  );
  if (!calculation.vatCodes.length)
    error(
      'D406_TAX_TABLE',
      'journals',
      'Fișierul periodic cuprinde cel puțin un cod de taxă TVA (TaxTable).',
    );
  return checks;
}
