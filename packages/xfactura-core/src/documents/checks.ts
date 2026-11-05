import type { JsonValue } from '../kernel';
import { isValidCnp, isValidCui, isValidIban } from '../ro/identifiers';
import { addDays, isLocalDate, type LocalDate } from '../time';
import type { InvoiceDocument } from '../ubl/invoice-document';
import { taxPointOf } from '../ro/treatments/invoices';
import { Amount } from '../values';
import {
  taxDocumentCitations,
  taxDocumentProblems,
  type TaxDecisionDocument,
  type TaxStatementDocument,
} from '../ro/taxaccount/documents';
import {
  documentKinds,
  isInvoiceKind,
  isIssuedKind,
  isTaxKind,
  normalizedNumber,
  normalizedTaxId,
  type Citation,
  type Citations,
  type ContractDocument,
  type ExtractedBody,
  type ReceiptDocument,
} from './schemas';

/*
 * Pure checks of a document an agent read (`documents.record`), kept with it. They decide nothing
 * about the books: the engine records the document with its failures, and a treatment reading it
 * turns them into issues (a failed arithmetic check blocks, the others need acknowledging). Only a
 * document the company is not exactly one party of is refused outright (`companyParty`).
 */

export type CheckStatus = 'passed' | 'failed' | 'unverified' | 'skipped';
export type CheckCode =
  | 'COMPANY_PARTY'
  | 'TOTALS'
  | 'VAT_CATEGORIES'
  | 'VAT_RATE'
  | 'TAX_IDS'
  | 'IBAN'
  | 'DATES'
  | 'CITATIONS';
export interface DocumentCheck {
  code: CheckCode;
  status: CheckStatus;
  /** A failure blocks every treatment reading the document: its amounts do not add up, so it
   * must be superseded. Other failures and unverified checks need acknowledging. */
  blocking: boolean;
  message: string;
  details?: JsonValue;
}
/** The checks whose failure blocks a treatment. */
export const blockingChecks: readonly CheckCode[] = ['TOTALS', 'VAT_CATEGORIES'];

export type CitationStatus = 'verified' | 'failed' | 'unverified';
/** Why a citation is not verified: the field does not exist, the page or line is not in the
 * file, the cited text is not on that line, the value is not in the cited text, or the page has
 * no text layer to check against. */
export type CitationReason = 'field' | 'page' | 'line' | 'text' | 'value' | 'no_text_layer';
export interface CitationResult extends Citation {
  field: string;
  status: CitationStatus;
  reason: CitationReason | null;
}

/** The VAT rates in force on a date, from the rule register, or the gap that stops it saying. */
export type RatesAt = (
  date: LocalDate,
) => { standard: string; reduced: string[] } | { gap: string };

export interface CheckContext {
  kind: string;
  body: ExtractedBody;
  /** The company's CUI, without the RO prefix. */
  companyTaxId: string;
  today: LocalDate;
  rates: RatesAt;
  /** The file's text layer, `pages[p - 1][l - 1]` being line `l` of page `p`; null when the file
   * has none (an image), so that no citation can be verified. */
  pages: string[][] | null;
  citations: Citations;
}

const passed = (code: CheckCode, message: string, details?: JsonValue): DocumentCheck => ({
  code,
  status: 'passed',
  blocking: blockingChecks.includes(code),
  message,
  ...(details === undefined ? {} : { details }),
});
const failed = (code: CheckCode, message: string, details?: JsonValue): DocumentCheck => ({
  ...passed(code, message, details),
  status: 'failed',
});
const unverified = (code: CheckCode, message: string, details?: JsonValue): DocumentCheck => ({
  ...passed(code, message, details),
  status: 'unverified',
});
const skipped = (code: CheckCode, message: string): DocumentCheck => ({
  ...passed(code, message),
  status: 'skipped',
});

type Decimal = InstanceType<typeof Amount>;
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Amount(0));
const same = (a: Decimal | string, b: Decimal | string) => new Amount(a).eq(b);

/** Who the company is on a document, or why it cannot be the company's. */
export function companyParty(
  kind: string,
  body: ExtractedBody,
  companyTaxId: string,
): { ok: true } | { ok: false; message: string } {
  const own = (taxId: string | null, country = 'RO') =>
    taxId !== null && country === 'RO' && normalizedTaxId(taxId) === companyTaxId;
  if (isInvoiceKind(kind)) {
    const invoice = body as InvoiceDocument;
    const seller = own(invoice.supplier.taxId, invoice.supplier.country);
    const buyer = own(invoice.customer.taxId, invoice.customer.country);
    if (seller === buyer)
      return {
        ok: false,
        message: 'Compania trebuie să fie fie furnizorul, fie clientul documentului.',
      };
    if (seller !== isIssuedKind(kind))
      return {
        ok: false,
        message: seller
          ? 'Compania este furnizorul: documentul este emis, nu primit.'
          : 'Compania este clientul: documentul este primit, nu emis.',
      };
    return { ok: true };
  }
  if (kind === documentKinds.receipt) {
    const receipt = body as ReceiptDocument;
    if (own(receipt.seller.taxId, receipt.seller.country))
      return { ok: false, message: 'Bonul este emis de companie, nu primit.' };
    if (receipt.buyerTaxId !== null && !own(receipt.buyerTaxId))
      return { ok: false, message: 'Bonul poartă codul fiscal al altui cumpărător.' };
    return { ok: true };
  }
  if (isTaxKind(kind)) {
    const document = body as TaxDecisionDocument | TaxStatementDocument;
    return own(document.taxpayer.taxId)
      ? { ok: true }
      : { ok: false, message: 'Documentul ANAF privește alt contribuabil decât compania.' };
  }
  const contract = body as ContractDocument;
  const ours = contract.parties.filter((party) => own(party.taxId, party.country));
  return ours.length === 1
    ? { ok: true }
    : {
        ok: false,
        message:
          ours.length === 0
            ? 'Compania nu este parte a contractului.'
            : 'Compania apare de mai multe ori printre părțile contractului.',
      };
}

/** Every check of a document, and each citation with its outcome. */
export function checkDocument(context: CheckContext): {
  checks: DocumentCheck[];
  citations: CitationResult[];
} {
  const { kind, body } = context;
  const party = companyParty(kind, body, context.companyTaxId);
  const checks: DocumentCheck[] = [
    party.ok
      ? passed('COMPANY_PARTY', 'Compania este una dintre părți.')
      : failed('COMPANY_PARTY', party.message),
  ];
  if (isInvoiceKind(kind)) {
    const invoice = body as InvoiceDocument;
    checks.push(invoiceTotals(invoice), invoiceCategories(invoice));
    checks.push(rateCheck(context.rates, taxPointOf(invoice), invoiceRates(invoice)));
    checks.push(taxIdCheck([invoice.supplier, invoice.customer]));
    checks.push(
      invoice.payeeIbans?.length
        ? ibanCheck(invoice.payeeIbans)
        : skipped('IBAN', 'Documentul nu indică un cont.'),
    );
    checks.push(invoiceDates(invoice, context.today));
  } else if (kind === documentKinds.receipt) {
    const receipt = body as ReceiptDocument;
    checks.push(receiptTotals(receipt), receiptCategories(receipt));
    checks.push(
      rateCheck(
        context.rates,
        receipt.issueDate,
        receipt.taxes.map((tax) => tax.rate),
        true,
      ),
    );
    checks.push(
      taxIdCheck([
        receipt.seller,
        ...(receipt.buyerTaxId ? [{ taxId: receipt.buyerTaxId, country: 'RO' }] : []),
      ]),
    );
    checks.push(singleDate(receipt.issueDate, context.today));
  } else if (isTaxKind(kind)) {
    const problems = taxDocumentProblems(kind, body);
    checks.push(
      problems.length
        ? failed('TOTALS', problems.join(' '), problems)
        : passed('TOTALS', 'Sumele documentului se potrivesc.'),
    );
    const document = body as TaxDecisionDocument | TaxStatementDocument;
    checks.push(
      taxIdCheck([
        { taxId: document.taxpayer.taxId, country: 'RO' },
        ...('issuer' in document && document.issuer.taxId
          ? [{ taxId: document.issuer.taxId, country: 'RO' }]
          : []),
      ]),
    );
    checks.push(singleDate('asOf' in document ? document.asOf : document.issueDate, context.today));
  } else {
    const contract = body as ContractDocument;
    checks.push(
      taxIdCheck(
        contract.parties.flatMap((item) =>
          item.taxId ? [{ taxId: item.taxId, country: item.country }] : [],
        ),
      ),
    );
    checks.push(contractDates(contract, context.today));
  }
  const citations = Object.entries(context.citations)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, citation]) => ({
      field,
      ...citation,
      ...verifyCitation(context.pages, citation, valueAt(body, field)),
    }));
  checks.push(citationCheck(citations, requiredCitations(kind, body)));
  return { checks, citations };
}

// Arithmetic

function invoiceTotals(invoice: InvoiceDocument): DocumentCheck {
  const t = invoice.totals;
  const rules: [string, Decimal, string][] = [
    ['lines = lineNet', sum(invoice.lines.map((line) => line.net)), t.lineNet],
    [
      'lineNet - allowances + charges = net',
      new Amount(t.lineNet).minus(t.allowances).plus(t.charges),
      t.net,
    ],
    ['net + tax = gross', new Amount(t.net).plus(t.tax), t.gross],
    [
      'gross - prepaid + rounding = payable',
      new Amount(t.gross).minus(t.prepaid).plus(t.rounding),
      t.payable,
    ],
    ['taxes.base = net', sum(invoice.taxes.map((tax) => tax.base)), t.net],
    ['taxes.tax = tax', sum(invoice.taxes.map((tax) => tax.tax)), t.tax],
  ];
  return arithmetic('TOTALS', rules, 'Totalurile documentului');
}

function receiptTotals(receipt: ReceiptDocument): DocumentCheck {
  const t = receipt.totals;
  return arithmetic(
    'TOTALS',
    [
      ['lines = gross', sum(receipt.lines.map((line) => line.gross)), t.gross],
      ['taxes.gross = gross', sum(receipt.taxes.map((tax) => tax.gross)), t.gross],
      ['taxes.tax = tax', sum(receipt.taxes.map((tax) => tax.tax)), t.tax],
    ],
    'Totalurile bonului',
  );
}

function arithmetic(code: CheckCode, rules: [string, Decimal, string][], what: string) {
  const differences = rules
    .filter(([, computed, stated]) => !computed.eq(stated))
    .map(([rule, computed, stated]) => ({ rule, computed: computed.toFixed(2), stated }));
  return differences.length
    ? failed(
        code,
        `${what} nu se reconciliază: ${differences.map((item) => `${item.rule} (${item.computed} față de ${item.stated})`).join('; ')}.`,
        differences,
      )
    : passed(code, `${what} se reconciliază.`);
}

/** VAT rounding allowed per category: half a ban for each line computed on its own, at least one
 * ban (`tolerance` in bani). */
const tolerance = (lines: number) => Math.max(1, Math.ceil(lines / 2));
const withinTolerance = (stated: string, expected: Decimal, lines: number) =>
  new Amount(stated).minus(expected).abs().mul(100).lte(tolerance(lines));

const categoryKey = (category: string, rate: string | null) =>
  rate === null ? category : `${category}-${rate}`;

function invoiceCategories(invoice: InvoiceDocument): DocumentCheck {
  const problems: { category: string; problem: string; stated?: string; expected?: string }[] = [];
  const keys = invoice.taxes.map((tax) => categoryKey(tax.category, tax.rate));
  if (new Set(keys).size !== keys.length)
    problems.push({ category: '*', problem: 'category repeated in the VAT breakdown' });
  const adjusted =
    !new Amount(invoice.totals.allowances).isZero() ||
    !new Amount(invoice.totals.charges).isZero() ||
    !!invoice.documentAdjustments?.length;
  for (const tax of invoice.taxes) {
    const key = categoryKey(tax.category, tax.rate);
    const lines = invoice.lines.filter(
      (line) => categoryKey(line.vatCategory, line.vatRate) === key,
    );
    const rate = tax.rate === null ? new Amount(0) : new Amount(tax.rate);
    const expected = new Amount(tax.base)
      .mul(rate)
      .div(100)
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP);
    if (!withinTolerance(tax.tax, expected, lines.length))
      problems.push({
        category: key,
        problem: 'VAT is not the base at the rate',
        stated: tax.tax,
        expected: expected.toFixed(2),
      });
    if (!adjusted && !same(sum(lines.map((line) => line.net)), tax.base))
      problems.push({
        category: key,
        problem: 'the lines do not add up to the base',
        stated: tax.base,
        expected: sum(lines.map((line) => line.net)).toFixed(2),
      });
  }
  for (const line of invoice.lines)
    if (!keys.includes(categoryKey(line.vatCategory, line.vatRate)))
      problems.push({
        category: categoryKey(line.vatCategory, line.vatRate),
        problem: `line ${line.id} is in no category of the VAT breakdown`,
      });
  return categoryOutcome(problems);
}

function receiptCategories(receipt: ReceiptDocument): DocumentCheck {
  const problems: { category: string; problem: string; stated?: string; expected?: string }[] = [];
  const rates = receipt.taxes.map((tax) => tax.rate);
  if (new Set(rates).size !== rates.length)
    problems.push({ category: '*', problem: 'rate repeated in the VAT totals' });
  for (const tax of receipt.taxes) {
    const lines = receipt.lines.filter((line) => line.vatRate === tax.rate);
    // The VAT a gross amount contains: gross × rate / (100 + rate).
    const expected = new Amount(tax.gross)
      .mul(tax.rate)
      .div(new Amount(100).plus(tax.rate))
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP);
    if (!withinTolerance(tax.tax, expected, lines.length))
      problems.push({
        category: tax.rate,
        problem: 'VAT is not the gross amount at the rate',
        stated: tax.tax,
        expected: expected.toFixed(2),
      });
    if (!same(sum(lines.map((line) => line.gross)), tax.gross))
      problems.push({
        category: tax.rate,
        problem: 'the lines do not add up to the rate total',
        stated: tax.gross,
        expected: sum(lines.map((line) => line.gross)).toFixed(2),
      });
  }
  for (const line of receipt.lines)
    if (!rates.includes(line.vatRate))
      problems.push({ category: line.vatRate, problem: 'a line at a rate with no VAT total' });
  return categoryOutcome(problems);
}

function categoryOutcome(problems: { category: string; problem: string }[]): DocumentCheck {
  return problems.length
    ? failed(
        'VAT_CATEGORIES',
        `TVA pe cote nu se reconciliază: ${problems.map((item) => `${item.category}: ${item.problem}`).join('; ')}.`,
        problems,
      )
    : passed('VAT_CATEGORIES', 'TVA pe cote se reconciliază, în toleranța de rotunjire.');
}

// Rules, identifiers and dates

function invoiceRates(invoice: InvoiceDocument) {
  return invoice.taxes.filter((tax) => tax.category === 'S').map((tax) => tax.rate ?? '');
}

function rateCheck(rates: RatesAt, date: string, stated: string[], zeroAllowed = false) {
  if (!stated.length) return skipped('VAT_RATE', 'Documentul nu are cote standard de verificat.');
  if (!isLocalDate(date)) return unverified('VAT_RATE', 'Data documentului nu este validă.');
  const inForce = rates(date);
  if ('gap' in inForce)
    return unverified(
      'VAT_RATE',
      `Cotele în vigoare la ${date} nu pot fi verificate: ${inForce.gap}`,
      { date },
    );
  const allowed = [inForce.standard, ...inForce.reduced, ...(zeroAllowed ? ['0'] : [])];
  const wrong = [...new Set(stated.filter((rate) => !allowed.includes(rate)))];
  return wrong.length
    ? failed(
        'VAT_RATE',
        `Cotele ${wrong.map((rate) => `${rate}%`).join(', ')} nu sunt în vigoare la ${date} (${allowed.map((rate) => `${rate}%`).join(', ')}).`,
        { date, wrong, allowed },
      )
    : passed('VAT_RATE', `Cotele sunt în vigoare la ${date}.`, { date });
}

function taxIdCheck(parties: { taxId: string; country: string }[]) {
  const romanian = parties.filter((party) => party.country === 'RO');
  if (!romanian.length)
    return skipped('TAX_IDS', 'Nu există coduri fiscale românești de verificat.');
  // An individual's CNP is valid too; it is reported only as invalid, never echoed.
  const invalid = romanian.filter(
    (party) => !isValidCui(party.taxId) && !isValidCnp(normalizedTaxId(party.taxId)),
  );
  return invalid.length
    ? failed(
        'TAX_IDS',
        `Cifra de control nu corespunde pentru ${invalid.map((party) => normalizedTaxId(party.taxId).replace(/^(\d{6})\d{7}$/, '$1*******')).join(', ')}.`,
        invalid.length,
      )
    : passed('TAX_IDS', 'Codurile fiscale românești au cifra de control corectă.');
}

function ibanCheck(ibans: string[]) {
  const invalid = ibans.filter((iban) => !isValidIban(iban));
  return invalid.length
    ? failed('IBAN', `IBAN invalid: ${invalid.join(', ')}.`, invalid)
    : passed('IBAN', 'Conturile au IBAN valid.');
}

/** How far back a document may plausibly date: the ten years books are kept. */
const oldest = (today: LocalDate) => `${Number(today.slice(0, 4)) - 10}${today.slice(4)}`;

function dateProblems(today: LocalDate, date: string, what: string) {
  if (date > today) return [`${what} (${date}) este în viitor`];
  if (date < oldest(today)) return [`${what} (${date}) este mai veche de zece ani`];
  return [];
}

function invoiceDates(invoice: InvoiceDocument, today: LocalDate) {
  const problems = dateProblems(today, invoice.issueDate, 'data emiterii');
  const issue = invoice.issueDate as LocalDate;
  if (
    invoice.taxPointDate &&
    (invoice.taxPointDate < addDays(issue, -366) || invoice.taxPointDate > addDays(issue, 366))
  )
    problems.push(`data exigibilității (${invoice.taxPointDate}) este la peste un an de emitere`);
  if (
    invoice.deliveryDate &&
    (invoice.deliveryDate < addDays(issue, -366) || invoice.deliveryDate > addDays(issue, 366))
  )
    problems.push(`data livrării (${invoice.deliveryDate}) este la peste un an de emitere`);
  if (invoice.dueDate && invoice.dueDate < invoice.issueDate)
    problems.push(`scadența (${invoice.dueDate}) este înaintea emiterii`);
  return datesOutcome(problems);
}

function singleDate(date: string, today: LocalDate) {
  return datesOutcome(dateProblems(today, date, 'data'));
}

function contractDates(contract: ContractDocument, today: LocalDate) {
  const problems = dateProblems(today, contract.date, 'data semnării');
  if (contract.effectiveTo && contract.effectiveTo < contract.effectiveFrom)
    problems.push(`sfârșitul (${contract.effectiveTo}) este înaintea începutului`);
  return datesOutcome(problems);
}

function datesOutcome(problems: string[]) {
  return problems.length
    ? failed('DATES', `Date neplauzibile: ${problems.join('; ')}.`, problems)
    : passed('DATES', 'Datele sunt plauzibile.');
}

// Citations

/** The fields every extraction of a kind must cite: what identifies it and what it costs. */
export function requiredCitations(kind: string, body?: unknown): string[] {
  if (isTaxKind(kind)) return body === undefined ? [] : taxDocumentCitations(kind, body);
  if (kind === documentKinds.receipt)
    return ['issueDate', 'number', 'seller.taxId', 'totals.gross', 'totals.tax'];
  if (kind === documentKinds.contract) return ['date', 'effectiveFrom'];
  return [
    'issueDate',
    'number',
    isIssuedKind(kind) ? 'customer.taxId' : 'supplier.taxId',
    'totals.gross',
    'totals.tax',
  ];
}

function citationCheck(citations: CitationResult[], required: string[]) {
  const cited = new Set(citations.map((item) => item.field));
  const missing = required.filter((field) => !cited.has(field));
  const failures = citations
    .filter((item) => item.status === 'failed')
    .map((item) => ({ field: item.field, reason: item.reason }));
  const notChecked = citations
    .filter((item) => item.status === 'unverified')
    .map((item) => item.field);
  const verified = citations.filter((item) => item.status === 'verified').length;
  const details = { verified, failed: failures, unverified: notChecked, missing };
  if (failures.length)
    return failed(
      'CITATIONS',
      `Citările nu corespund fișierului pentru ${failures.map((item) => item.field).join(', ')}.`,
      details,
    );
  if (notChecked.length || missing.length)
    return unverified(
      'CITATIONS',
      [
        notChecked.length
          ? `Fără text în fișier pentru ${notChecked.join(', ')}: citările nu pot fi verificate`
          : '',
        missing.length ? `Câmpuri necitate: ${missing.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('. ') + '.',
      details,
    );
  return passed('CITATIONS', `Cele ${verified} citări corespund fișierului.`, details);
}

export type ValueKind = 'money' | 'rate' | 'date' | 'taxId' | 'iban' | 'code' | 'text';

/** What kind of value a field holds, from its path. */
export function valueKind(field: string): ValueKind {
  const last = field.split('.').at(-1)!;
  if (
    /^(issueDate|taxPointDate|deliveryDate|dueDate|date|effectiveFrom|effectiveTo|communicatedOn|asOf)$/.test(
      last,
    ) ||
    /^lines\.\d+\.(from|to)$/.test(field)
  )
    return 'date';
  if (/^(taxId|buyerTaxId)$/.test(last)) return 'taxId';
  if (/^payeeIbans\.\d+$/.test(field) || last === 'iban') return 'iban';
  if (/^(rate|vatRate)$/.test(last)) return 'rate';
  if (/^(number|register|originalInvoiceNumber)$/.test(field)) return 'code';
  if (
    /^totals\.\w+$/.test(field) ||
    /^(taxes|lines)\.\d+\.(base|tax|gross|net|amount)$/.test(field) ||
    /^rows\.\d+\.(opening|debit|credit|balance)$/.test(field) ||
    /^(vatAccountingTotal|value|recurring\.amount|amount|opening|closing)$/.test(field)
  )
    return 'money';
  return 'text';
}

/** The value of a field of the body as text, with its kind; null when there is none. */
export function valueAt(body: unknown, field: string): { kind: ValueKind; value: string } | null {
  let node: unknown = body;
  for (const part of field.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === 'number') node = String(node);
  if (typeof node !== 'string' || !node.trim()) return null;
  return { kind: valueKind(field), value: node };
}

/** Text compared as citations are: whitespace runs (spaces, tabs) collapsed. */
export const collapsed = (text: string) =>
  text
    .normalize('NFC')
    .replace(/[ \t ]+/g, ' ')
    .trim();

/**
 * Whether a citation holds: its line exists in the text layer, carries the cited text (with
 * whitespace runs collapsed), and the cited text carries the value, read as its kind reads (an
 * amount in either decimal convention, a date in the usual Romanian forms, a tax id with or
 * without RO, a text without diacritics or case). Without a text layer on that page it is
 * unverified, never passed.
 */
export function verifyCitation(
  pages: string[][] | null,
  citation: Citation,
  expected: { kind: ValueKind; value: string } | null,
): { status: CitationStatus; reason: CitationReason | null } {
  if (!expected) return { status: 'failed', reason: 'field' };
  if (pages === null) return { status: 'unverified', reason: 'no_text_layer' };
  if (citation.page > pages.length) return { status: 'failed', reason: 'page' };
  const page = pages[citation.page - 1]!;
  if (!page.length) return { status: 'unverified', reason: 'no_text_layer' };
  const line = page[citation.line - 1];
  if (line === undefined) return { status: 'failed', reason: 'line' };
  if (!collapsed(line).includes(collapsed(citation.text)))
    return { status: 'failed', reason: 'text' };
  return shows(citation.text, expected)
    ? { status: 'verified', reason: null }
    : { status: 'failed', reason: 'value' };
}

/** Whether `text` shows `expected`. */
export function shows(text: string, expected: { kind: ValueKind; value: string }): boolean {
  switch (expected.kind) {
    case 'money':
    case 'rate':
      return amountsIn(text).has(new Amount(expected.value).abs().toString());
    case 'date':
      return datesIn(text).has(expected.value);
    case 'taxId': {
      const value = normalizedTaxId(expected.value)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      const haystack = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (let at = haystack.indexOf(value); at >= 0; at = haystack.indexOf(value, at + 1))
        if (!/\d/.test(haystack[at - 1] ?? '') && !/\d/.test(haystack[at + value.length] ?? ''))
          return true;
      return false;
    }
    case 'iban':
      return text
        .replace(/\s+/g, '')
        .toUpperCase()
        .includes(expected.value.replace(/\s+/g, '').toUpperCase());
    case 'code':
      // Printed as «Seria FCT nr. 0042», kept as FCT0042: the words and punctuation go.
      return codeOf(text).includes(codeOf(expected.value));
    default:
      return folded(text).includes(folded(expected.value));
  }
}

/** A document number as citations compare it: letters and digits only, without the words
 * «seria» and «nr.» that print it. */
const codeOf = (text: string) =>
  normalizedNumber(folded(text).replace(/\b(seria|serie|series|nr|numar|no)\b\.?/g, ' ')).replace(
    /[^A-Z0-9]/g,
    '',
  );

/** Text without diacritics, case or repeated whitespace. */
const folded = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const numberRun = /\d(?:[\d.,'’   ]*\d)?/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numberForms = (['.', ','] as const).map((decimal) => {
  const group = decimal === ',' ? '.' : ',';
  return new RegExp(
    `^(\\d{1,3}(?:[${escape(group)}'’ ]\\d{3})+|\\d+)(?:${escape(decimal)}(\\d{1,4}))?$`,
  );
});

/**
 * Every number `text` may show, as canonical decimals: each run of digits and separators read
 * with a decimal comma (1.234,56) and with a decimal point (1,234.56), thousands grouped by the
 * other mark, an apostrophe or a space. A space may also separate two numbers (a quantity and a
 * price), so every span of a run between spaces is read too.
 */
export function amountsIn(text: string): Set<string> {
  const values = new Set<string>();
  for (const match of text.matchAll(numberRun)) {
    const parts = match[0].split(/[   ]+/);
    for (let first = 0; first < parts.length; first++)
      for (let last = first; last < parts.length; last++) {
        const candidate = parts.slice(first, last + 1).join(' ');
        for (const form of numberForms) {
          const read = form.exec(candidate);
          if (read)
            values.add(
              new Amount(read[1]!.replace(/\D/g, '') + (read[2] ? `.${read[2]}` : '')).toString(),
            );
        }
      }
  }
  return values;
}

const months: Record<string, number> = {
  ian: 1,
  ianuarie: 1,
  feb: 2,
  februarie: 2,
  mar: 3,
  martie: 3,
  apr: 4,
  aprilie: 4,
  mai: 5,
  iun: 6,
  iunie: 6,
  iul: 7,
  iulie: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  septembrie: 9,
  oct: 10,
  octombrie: 10,
  noi: 11,
  nov: 11,
  noiembrie: 11,
  dec: 12,
  decembrie: 12,
};

/** Every calendar date `text` shows: 05.03.2026, 5/3/26, 2026-03-05, 5 martie 2026. */
export function datesIn(text: string): Set<string> {
  const dates = new Set<string>();
  const add = (year: string, month: string | number, day: string) => {
    const full = year.length === 2 ? `20${year}` : year;
    const date = `${full}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (isLocalDate(date)) dates.add(date);
  };
  for (const [, day, month, year] of text.matchAll(
    /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/g,
  ))
    add(year!, month!, day!);
  for (const [, year, month, day] of text.matchAll(
    /(?<!\d)(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/g,
  ))
    add(year!, month!, day!);
  for (const [, day, month, year] of folded(text).matchAll(
    /(?<!\d)(\d{1,2})[\s.-]*([a-z]{3,10})\.?[\s.-]*(\d{4})(?!\d)/g,
  ))
    if (months[month!]) add(year!, months[month!]!, day!);
  return dates;
}
