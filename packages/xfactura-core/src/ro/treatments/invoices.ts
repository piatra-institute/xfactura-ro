import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  vatPeriodOf,
  type DocumentRecord,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  convertMinor,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
} from '../../money';
import { selectRate } from '../fx';
import type { RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';

/** Document kinds produced by importing an e-Factura invoice or credit note. */
export const invoiceKinds = {
  sale: 'invoice.issued',
  purchase: 'invoice.received',
  saleCredit: 'creditNote.issued',
  purchaseCredit: 'creditNote.received',
} as const;

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const date = (value: string) => value as LocalDate;

type Invoice = { record: DocumentRecord; body: InvoiceDocument; direction: 'sale' | 'purchase' };

function invoiceOf(loaded: Loaded, id: string, credit: boolean): Invoice | Issue {
  const record = loaded.documents.get(id);
  if (!record) return block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId');
  const kinds = credit
    ? [invoiceKinds.saleCredit, invoiceKinds.purchaseCredit]
    : [invoiceKinds.sale, invoiceKinds.purchase];
  if (!(kinds as readonly string[]).includes(record.kind))
    return block(
      'DOCUMENT_KIND',
      'Documentul nu este de tipul așteptat de acest tratament.',
      'documentId',
    );
  const direction =
    record.kind === invoiceKinds.sale || record.kind === invoiceKinds.saleCredit
      ? 'sale'
      : 'purchase';
  return { record, body: invoiceDocumentSchema.parse(record.body), direction };
}

/**
 * The VAT the engine can determine for a document: one tax category on every line, in RON,
 * with the company's registration on the tax-point date. Returns the issues that prevent it.
 */
function vatFor(invoice: Invoice, loaded: Loaded, rules: RuleContext, taxPoint: LocalDate) {
  const issues: Issue[] = [];
  const body = invoice.body;
  const status = profileAt(loaded, 'vat.status', taxPoint);
  const categories = new Set([
    ...body.taxes.map((tax) => `${tax.category}/${tax.rate}`),
    ...body.lines.map((line) => `${line.vatCategory}/${line.vatRate}`),
  ]);
  if (body.taxes.length !== 1 || categories.size !== 1)
    issues.push(
      block('TAX_MIX', 'Documentele cu mai multe cote sau categorii TVA cer un tratament separat.'),
    );
  if (!status)
    issues.push(
      block('DETERMINATION_MISSING', 'Înregistrați regimul TVA al companiei pentru această dată.'),
    );
  const tax = body.taxes[0]!;
  if (tax.category === 'S') {
    const rate = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, {
      category: 'S',
    });
    if (tax.rate !== rate)
      issues.push(
        block('VAT_RATE', `Cota din document (${tax.rate}%) diferă de cota în vigoare (${rate}%).`),
      );
  } else if (tax.category !== 'O' || ron(tax.tax) !== 0n)
    issues.push(block('TAX_CATEGORY', `Categoria TVA ${tax.category} cere un tratament separat.`));
  if (invoice.direction === 'sale') {
    if (status === 'normal_vat' && tax.category !== 'S')
      issues.push(
        block('TAX_CATEGORY', 'Un plătitor de TVA facturează această operațiune cu TVA.'),
      );
    if (status === 'non_vat' && tax.category !== 'O')
      issues.push(block('TAX_CATEGORY', 'Un neplătitor de TVA nu colectează TVA.'));
  }
  return { issues, status, category: tax.category, rate: tax.rate };
}

const vatEntry = (
  invoice: Invoice,
  entry: Partial<TaxEntrySpec> &
    Pick<
      TaxEntrySpec,
      'baseBani' | 'taxBani' | 'deductibleBani' | 'ledgerBani' | 'taxPoint' | 'taxPeriod'
    >,
  code: string,
): TaxEntrySpec => ({
  key: 'vat',
  tax: 'VAT',
  code,
  direction: invoice.direction === 'sale' ? 'output' : 'input',
  exigibility: entry.taxPoint,
  documentId: invoice.record.id,
  ...(invoice.record.partyId ? { partyId: invoice.record.partyId } : {}),
  attributes: {
    documentType: invoice.body.documentType,
    number: invoice.body.number,
    counterpartyTaxId:
      invoice.direction === 'sale' ? invoice.body.customer.taxId : invoice.body.supplier.taxId,
    counterpartyCountry:
      invoice.direction === 'sale' ? invoice.body.customer.country : invoice.body.supplier.country,
  },
  ...entry,
});

/**
 * The amounts to book, in RON. A foreign-currency document is converted at the accounting rate
 * on its issue date; its VAT is the RON total the document states (BT-111), compared with the
 * BNR rate at the tax point.
 */
function amountsFor(invoice: Invoice, loaded: Loaded, rules: RuleContext, taxPoint: LocalDate) {
  const body = invoice.body;
  const issues: Issue[] = [];
  if (body.currency === LEDGER_CURRENCY) {
    const net = ron(body.totals.net);
    const tax = ron(body.totals.tax);
    return { issues, net, tax, gross: net + tax, base: net, fx: undefined };
  }
  if (!isSupportedCurrency(body.currency)) {
    issues.push(block('CURRENCY', `Moneda ${body.currency} nu este acceptată.`));
    return { issues };
  }
  if (body.vatCurrency !== LEDGER_CURRENCY || body.vatAccountingTotal === undefined)
    issues.push(
      block('VAT_CURRENCY', 'Factura în valută trebuie să indice TVA în lei (BT-6, BT-111).'),
    );
  const accounting = selectRate(loaded, rules, body.currency, date(body.issueDate), 'accounting');
  const vatRate = selectRate(loaded, rules, body.currency, taxPoint, 'vat');
  if ('code' in accounting) issues.push(accounting);
  else if ('code' in vatRate) issues.push(vatRate);
  if (issues.length || 'code' in accounting || 'code' in vatRate) return { issues };
  const minor = (value: string) => parseMoney(value, body.currency);
  const fx = {
    code: body.currency,
    net: minor(body.totals.net),
    tax: minor(body.totals.tax),
    gross: minor(body.totals.gross),
    accounting,
    vat: vatRate,
  };
  const quote = (rate: FxRate) => ({ rate: rate.rate, multiplier: rate.multiplier });
  const net = convertMinor(fx.net, fx.code, quote(accounting));
  const tax = ron(body.vatAccountingTotal!);
  const expected = convertMinor(fx.tax, fx.code, quote(vatRate));
  if (tax !== expected)
    issues.push(
      warn(
        'VAT_FX',
        `TVA în lei din document (${formatMoney(tax, LEDGER_CURRENCY)}) diferă de TVA la cursul BNR (${formatMoney(expected, LEDGER_CURRENCY)}).`,
      ),
    );
  return {
    issues,
    net,
    tax,
    gross: net + tax,
    base: convertMinor(fx.net, fx.code, quote(vatRate)),
    fx,
  };
}

export const recognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Revenue account (70x) for a sale; expense account (6xx) for a purchase. */
    account: z.string().regex(accountCodePattern),
    /** Input VAT deduction for a purchase; ignored for a sale. */
    deduction: z.enum(['full', 'none']).default('full'),
    /** When the service was provided, if it differs from the tax point. */
    serviceDate: z
      .string()
      .refine((value): boolean => isLocalDate(value))
      .optional(),
  })
  .strict();
export type RecognitionInput = z.infer<typeof recognitionInput>;

/**
 * Recognizes a domestic RON service invoice: revenue and output VAT for a sale, expense and
 * deductible (or non-deductible) VAT for a purchase, with the receivable or payable as an open
 * item of the counterparty. VAT comes from the rule register at the tax-point date.
 */
export const invoiceRecognition: Treatment<RecognitionInput> = {
  id: 'invoices.recognize',
  version: 1,
  description:
    'Factură de servicii în lei: venit sau cheltuială, TVA și creanța sau datoria față de partener.',
  input: recognitionInput,
  agent: true,
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId], profile: true }),
  followUp(input, loaded) {
    const parsed = invoiceDocumentSchema.safeParse(loaded.documents.get(input.documentId)?.body);
    if (!parsed.success || parsed.data.currency === LEDGER_CURRENCY) return null;
    const until = [parsed.data.issueDate, parsed.data.taxPointDate ?? parsed.data.issueDate]
      .sort()
      .at(-1)!;
    return { fx: [{ currency: parsed.data.currency, until: date(until) }] };
  },
  evaluate(input, loaded, rules) {
    const invoice = invoiceOf(loaded, input.documentId, false);
    if ('code' in invoice) return { effect: null, issues: [invoice] };
    const { body, direction } = invoice;
    const taxPoint = date(body.taxPointDate ?? body.issueDate);
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const vat = vatFor(invoice, loaded, rules, taxPoint);
    const amounts = amountsFor(invoice, loaded, rules, taxPoint);
    const issues = [...vat.issues, ...amounts.issues];
    if (direction === 'sale' ? !input.account.startsWith('70') : !input.account.startsWith('6'))
      issues.push(
        block(
          'ACCOUNT',
          direction === 'sale'
            ? 'Folosiți un cont de venituri (70x).'
            : 'Folosiți un cont de cheltuieli (6xx).',
          'account',
        ),
      );
    if (ron(body.totals.prepaid) !== 0n)
      issues.push(block('PREPAID', 'Facturile cu avans dedus cer tratamentul de avansuri.'));
    if (body.totals.rounding !== '0.00')
      issues.push(block('ROUNDING', 'Rotunjirea sumei de plată cere un tratament separat.'));
    if (
      direction === 'purchase' &&
      input.deduction === 'full' &&
      vat.status === 'non_vat' &&
      vat.category === 'S'
    )
      issues.push(block('DEDUCTION', 'Un neplătitor de TVA nu deduce TVA.', 'deduction'));
    if (input.serviceDate && input.serviceDate.slice(0, 7) !== taxPoint.slice(0, 7))
      issues.push(
        warn(
          'SERVICE_PERIOD',
          'Serviciul aparține altei luni decât faptul generator; verificați dacă este necesară o regularizare.',
        ),
      );
    if (!invoice.record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const { net, tax, gross, base, fx } = amounts as Required<Omit<typeof amounts, 'fx'>> &
      Pick<typeof amounts, 'fx'>;
    const partyId = invoice.record.partyId!;
    const code = vat.category === 'S' ? `S-${vat.rate}` : 'O';
    // Every line of a foreign-currency document records its currency amount and rate.
    const line = (spec: LineSpec, minor?: bigint, rate?: FxRate): LineSpec =>
      fx && minor !== undefined
        ? {
            ...spec,
            currency: {
              code: fx.code,
              minor: spec.bani < 0n ? -minor : minor,
              rateId: (rate ?? fx.accounting).id,
              rate: (rate ?? fx.accounting).rate,
            },
          }
        : spec;
    const vatCurrency = fx
      ? {
          currency: {
            code: fx.code,
            baseMinor: fx.net,
            taxMinor: fx.tax,
            rateId: fx.vat.id,
            rate: fx.vat.rate,
          },
        }
      : {};
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const item = {
      ref: 'counterparty',
      kind: direction === 'sale' ? ('receivable' as const) : ('payable' as const),
      controlAccount: direction === 'sale' ? '4111' : '401',
      partyId,
      currency: fx?.code ?? LEDGER_CURRENCY,
      normalSide: direction === 'sale' ? ('D' as const) : ('C' as const),
      mayReverse: false,
      documentId: invoice.record.id,
    };
    if (direction === 'sale') {
      lines.push(
        line({ account: '4111', side: 'D', bani: gross, openItem: item.ref, partyId }, fx?.gross),
      );
      lines.push(line({ account: input.account, side: 'C', bani: net }, fx?.net));
      if (tax !== 0n) {
        lines.push(line({ account: '4427', side: 'C', bani: tax }, fx?.tax, fx?.vat));
        taxEntries.push(
          vatEntry(
            invoice,
            {
              baseBani: base,
              taxBani: tax,
              deductibleBani: 0n,
              ledgerBani: tax,
              line: 2,
              taxPoint,
              taxPeriod,
              ...vatCurrency,
            },
            code,
          ),
        );
      }
    } else if (input.deduction === 'full' || tax === 0n) {
      lines.push(line({ account: input.account, side: 'D', bani: net }, fx?.net));
      if (tax !== 0n) {
        lines.push(line({ account: '4426', side: 'D', bani: tax }, fx?.tax, fx?.vat));
        taxEntries.push(
          vatEntry(
            invoice,
            {
              baseBani: base,
              taxBani: tax,
              deductibleBani: tax,
              ledgerBani: tax,
              line: 1,
              taxPoint,
              taxPeriod,
              ...vatCurrency,
            },
            code,
          ),
        );
      }
      lines.push(
        line({ account: '401', side: 'C', bani: gross, openItem: item.ref, partyId }, fx?.gross),
      );
    } else {
      // Non-deductible VAT is part of the expense; the tax entry records it without a VAT line.
      lines.push(line({ account: input.account, side: 'D', bani: gross }, fx?.gross));
      lines.push(
        line({ account: '401', side: 'C', bani: gross, openItem: item.ref, partyId }, fx?.gross),
      );
      taxEntries.push(
        vatEntry(
          invoice,
          {
            baseBani: base,
            taxBani: tax,
            deductibleBani: 0n,
            ledgerBani: 0n,
            taxPoint,
            taxPeriod,
            ...vatCurrency,
          },
          code,
        ),
      );
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: date(body.issueDate),
      journalClass: 'general',
      journalCode: direction === 'sale' ? 'VANZARI' : 'CUMPARARI',
      description: `${direction === 'sale' ? 'Factură emisă' : 'Factură primită'} ${body.number}`,
      lines,
      openItems: [item],
      taxEntries,
      schedules: [],
      explanation: {
        summary: fx
          ? `${body.number} din ${body.issueDate}: ${body.totals.gross} ${fx.code} la cursul ${fx.accounting.rate} (${fx.accounting.date}); TVA ${formatMoney(tax, LEDGER_CURRENCY)} lei.`
          : `${body.number} din ${body.issueDate}: bază ${body.totals.net}, TVA ${body.totals.tax}, total ${body.totals.gross} lei.`,
        details: {
          taxPoint,
          category: vat.category,
          rate: vat.rate,
          deduction: direction === 'purchase' ? input.deduction : null,
        },
      },
    };
    return { effect, issues };
  },
};

export const creditInput = z
  .object({
    documentId: z.uuid(),
    originalDocumentId: z.uuid(),
    /** The revenue or expense account the original invoice used. */
    account: z.string().regex(accountCodePattern),
    deduction: z.enum(['full', 'none']).default('full'),
  })
  .strict();
export type CreditInput = z.infer<typeof creditInput>;

/**
 * Recognizes a credit note (381, or a negative 380) against its original invoice: the original
 * accounts and VAT rate are reversed for the credited amount in the credit note's own period,
 * and the original receivable or payable is reduced. Crediting more than remains open is refused.
 */
export const creditRecognition: Treatment<CreditInput> = {
  id: 'invoices.credit',
  version: 1,
  description:
    'Notă de credit sau factură storno legată de factura inițială, cu cota TVA a acesteia.',
  input: creditInput,
  agent: true,
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId, input.originalDocumentId],
    openItems: [{ documentId: input.originalDocumentId }],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const credit = invoiceOf(loaded, input.documentId, true);
    const original = invoiceOf(loaded, input.originalDocumentId, false);
    if ('code' in credit || 'code' in original)
      return {
        effect: null,
        issues: ['code' in credit ? credit : [], 'code' in original ? original : []].flat(),
      };
    const issues: Issue[] = [];
    if (credit.body.currency !== LEDGER_CURRENCY || original.body.currency !== LEDGER_CURRENCY)
      issues.push(block('CURRENCY', 'Notele de credit în valută cer un tratament separat.'));
    if (
      credit.direction !== original.direction ||
      credit.record.partyId !== original.record.partyId
    )
      issues.push(
        block(
          'ORIGINAL',
          'Factura inițială are alt partener sau altă direcție.',
          'originalDocumentId',
        ),
      );
    const referenced =
      credit.body.originalInvoiceNumber ?? credit.body.invoiceReferences?.[0]?.number ?? null;
    if (referenced !== original.body.number)
      issues.push(
        block(
          'REFERENCE',
          'Documentul nu face referire la factura inițială indicată.',
          'originalDocumentId',
        ),
      );
    const taxPoint = date(credit.body.taxPointDate ?? credit.body.issueDate);
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const originalTaxPoint = date(original.body.taxPointDate ?? original.body.issueDate);
    const vat = vatFor(original, loaded, rules, originalTaxPoint);
    issues.push(...vat.issues);
    const creditTax = credit.body.taxes[0];
    if (
      credit.body.taxes.length !== 1 ||
      creditTax?.category !== vat.category ||
      creditTax?.rate !== vat.rate
    )
      issues.push(
        block('VAT_RATE', 'Nota de credit păstrează categoria și cota TVA a facturii inițiale.'),
      );
    const item = [...loaded.openItems.values()].find(
      (open) => open.documentId === original.record.id,
    );
    if (!item)
      issues.push(
        block(
          'ORIGINAL_OPEN_ITEM',
          'Factura inițială nu este contabilizată.',
          'originalDocumentId',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const net = ron(credit.body.totals.net);
    const tax = ron(credit.body.totals.tax);
    const gross = ron(credit.body.totals.gross);
    const partyId = credit.record.partyId!;
    const code = vat.category === 'S' ? `S-${vat.rate}` : 'O';
    // Red storno: the original sides with negative amounts, so turnover stays correct.
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const entry = (line: number | undefined, ledger: bigint, deductible: bigint) =>
      vatEntry(
        credit,
        {
          baseBani: -net,
          taxBani: -tax,
          deductibleBani: -deductible,
          ledgerBani: -ledger,
          taxPoint,
          taxPeriod,
          ...(line === undefined ? {} : { line }),
          originTaxEntry: `${original.record.id}:vat`,
        },
        code,
      );
    if (credit.direction === 'sale') {
      lines.push({ account: '4111', side: 'D', bani: -gross, openItem: item!.id, partyId });
      lines.push({ account: input.account, side: 'C', bani: -net });
      if (tax !== 0n) {
        lines.push({ account: '4427', side: 'C', bani: -tax });
        taxEntries.push(entry(2, tax, 0n));
      }
    } else if (input.deduction === 'full' || tax === 0n) {
      lines.push({ account: input.account, side: 'D', bani: -net });
      if (tax !== 0n) {
        lines.push({ account: '4426', side: 'D', bani: -tax });
        taxEntries.push(entry(1, tax, tax));
      }
      lines.push({ account: '401', side: 'C', bani: -gross, openItem: item!.id, partyId });
    } else {
      lines.push({ account: input.account, side: 'D', bani: -gross });
      lines.push({ account: '401', side: 'C', bani: -gross, openItem: item!.id, partyId });
      taxEntries.push(entry(undefined, 0n, 0n));
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: date(credit.body.issueDate),
      journalClass: 'general',
      journalCode: credit.direction === 'sale' ? 'VANZARI' : 'CUMPARARI',
      description: `Notă de credit ${credit.body.number} pentru ${original.body.number}`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `${credit.body.number} reduce ${original.body.number} cu ${credit.body.totals.gross} lei, la cota inițială.`,
        details: { originalDocumentId: original.record.id, taxPoint },
      },
    };
    return { effect, issues };
  },
};
