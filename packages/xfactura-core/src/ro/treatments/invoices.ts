import { z } from 'zod';
import {
  accountCodePattern,
  partyStatusKey,
  profileAt,
  vatPeriodOf,
  type DocumentRecord,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type PartyStatus,
  type ReadPlan,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  allocate,
  convertMinor,
  divRound,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { selectRate } from '../fx';
import { carryingRelease, INDEXED_LEASE_METHOD } from '../financing';
import {
  cashVatClauses,
  creditSplit,
  deferredInvoice,
  isZeroAmounts,
  type CashVatAmounts,
  type CashVatParty,
} from '../cash-vat';
import { normalizePlate, questionIssue } from '../../questions/kinds';
import {
  exemptCodes,
  exemptionBases,
  exemptionBasisIds,
  isExemptCategory,
  prorataShare,
  provisionalProrata,
  reasonAgrees,
  type ExemptionBasisId,
} from '../exempt';
import { euVatPrefixes } from '../geo';
import { RuleGapError, type RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';
import {
  answerCovers,
  suggestsVehicle,
  VEHICLE_CLAUSES,
  vehicleAnswer,
  vehicleDeduction,
  vehicleSubject,
} from '../vehicles';

/** Document kinds produced by importing an e-Factura invoice or credit note. */
export const invoiceKinds = {
  sale: 'invoice.issued',
  purchase: 'invoice.received',
  saleCredit: 'creditNote.issued',
  purchaseCredit: 'creditNote.received',
} as const;

/** Purchases recognized on an expense or on a fixed asset (intangible 20x, tangible 21x). */
const fixedAsset = /^2[01]/;
const purchaseAccount = /^(6|2[01])/;
const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const date = (value: string) => value as LocalDate;

/** How a document's tax point was found: the supply's date (BT-72), the invoice issued before
 * the supply, the tax point it states (BT-7), or the issue date standing for a supply date the
 * document does not give. */
export type TaxPointBasis = 'supply' | 'invoice' | 'tax_point' | 'issue_date';

/**
 * When VAT on an invoice becomes chargeable, which is also the date its rate is read on (Codul
 * fiscal art. 282 alin. (1)–(2), art. 291 alin. (4)–(5)): the supply's date, the fapt generator
 * of art. 281, unless the invoice came first, or an advance the stated tax point (BT-7) records.
 * The document gives the supply's date in BT-72; without it, the stated tax point or, last, the
 * issue date stands for it. The invoicing period (BG-14) is not used: for a continuous supply the
 * fapt generator is the payment date in the contract or the invoice (art. 281 alin. (8)), for
 * another service its completion (alin. (12)), and the document does not say which it is.
 */
export function chargeabilityOf(
  body: Pick<InvoiceDocument, 'issueDate' | 'taxPointDate' | 'deliveryDate'>,
): { date: LocalDate; basis: TaxPointBasis; supplied: LocalDate | null } {
  const issued = date(body.issueDate);
  const stated = body.taxPointDate ? date(body.taxPointDate) : null;
  const supplied = body.deliveryDate ? date(body.deliveryDate) : null;
  if (!supplied)
    return { date: stated ?? issued, basis: stated ? 'tax_point' : 'issue_date', supplied };
  const earliest = [supplied, issued, ...(stated ? [stated] : [])].sort()[0]!;
  return {
    date: earliest,
    basis: earliest === supplied ? 'supply' : earliest === issued ? 'invoice' : 'tax_point',
    supplied,
  };
}

/** A document's tax point (`chargeabilityOf`). It is also the date a purchase's supplier status
 * is checked on. */
export const taxPointOf = (
  body: Pick<InvoiceDocument, 'issueDate' | 'taxPointDate' | 'deliveryDate'>,
) => chargeabilityOf(body).date;

const RATE_CLAUSES = [
  'ANAF/Cod-fiscal-consolidat:art.281(1)',
  'ANAF/Cod-fiscal-consolidat:art.282(1)',
  'ANAF/Cod-fiscal-consolidat:art.282(2)',
  'ANAF/Cod-fiscal-consolidat:art.291(4)-(6)',
];

/**
 * What the reviewer is told about the date an invoice's standard rate was read on: a stated tax
 * point later than the supply (art. 282 alin. (1)); the regularization of art. 291 alin. (6) when
 * the invoice or an advance came before a supply at another rate; and, without a supply date, a
 * change of the standard rate since the first day of the month before the issue date (or the
 * invoiced period's start), within which the supply may have taken place (art. 319 alin. (16)
 * has the invoice issued by the 15th of the next month).
 */
function chargeabilityIssues(
  body: InvoiceDocument,
  chargeable: ReturnType<typeof chargeabilityOf>,
  rules: RuleContext,
): Issue[] {
  if (!body.taxes.some((tax) => tax.category === 'S')) return [];
  const rateOn = (day: LocalDate) => {
    try {
      return rules.param<string>('ro.vat.rate', 'vat_chargeability_date', day, { category: 'S' });
    } catch (error) {
      if (error instanceof RuleGapError) return null;
      throw error;
    }
  };
  const issues: Issue[] = [];
  const { date: at, supplied } = chargeable;
  const now = rateOn(at);
  if (supplied && body.taxPointDate && body.taxPointDate > at)
    issues.push({
      ...warn(
        'TAX_POINT_DATES',
        `Factura înscrie data exigibilității ${body.taxPointDate} (BT-7), după ${supplied === at ? `data livrării sau a prestării, ${supplied} (BT-72)` : `emiterea ei, ${at}`}. TVA devine exigibilă la data faptului generator sau la emiterea facturii, dacă aceasta a fost emisă înainte (art. 282 alin. (1) și (2) din Codul fiscal): se înregistrează la ${at}, cu cota de atunci. Confirmați.`,
      ),
      details: { taxPoint: at, stated: body.taxPointDate, clauses: RATE_CLAUSES },
    });
  if (supplied && supplied > at) {
    const then = rateOn(supplied);
    if (now && then && then !== now)
      issues.push({
        ...warn(
          'RATE_REGULARIZATION',
          `TVA a devenit exigibilă la ${at}, înainte de livrare sau prestare (${supplied}), cu cota de ${now}%; la data livrării cota standard este ${then}%. Art. 291 alin. (6) din Codul fiscal cere regularizarea la cota de la data livrării: emiteți sau înregistrați factura de regularizare.`,
        ),
        details: { taxPoint: at, supplied, rates: [now, then], clauses: RATE_CLAUSES },
      });
  }
  if (chargeable.basis === 'issue_date') {
    const month = Number(at.slice(5, 7));
    const previous = date(
      month === 1
        ? `${Number(at.slice(0, 4)) - 1}-12-01`
        : `${at.slice(0, 5)}${String(month - 1).padStart(2, '0')}-01`,
    );
    const start = body.invoicePeriod?.start;
    const from = start && start < previous ? date(start) : previous;
    const before = rateOn(from);
    if (now && before && before !== now) {
      const period = body.invoicePeriod;
      issues.push({
        ...warn(
          'SUPPLY_DATE_ASSUMED',
          `Factura nu înscrie data livrării sau a prestării (BT-72), nici data exigibilității (BT-7): cota TVA este citită la data emiterii, ${at}, luată drept dată a livrării. Cota standard era ${before}% la ${from} și este ${now}% la ${at}. Dacă livrarea sau prestarea a avut loc înainte de schimbarea cotei, se aplică cota de la data ei, iar TVA este exigibilă la acea dată (art. 281, art. 282 alin. (1) și art. 291 alin. (4) din Codul fiscal), pe care factura trebuie să o înscrie.${period ? ` Factura privește perioada ${period.start ?? '…'}–${period.end ?? '…'} (BG-14): un serviciu încheiat la sfârșitul ei are faptul generator la acea dată (art. 281 alin. (12)); unul prestat continuu, la data de plată din contract sau, în lipsa ei, la emiterea facturii (art. 281 alin. (8)).` : ''} Confirmați data livrării.`,
        ),
        details: {
          taxPoint: at,
          from,
          rates: [before, now],
          clauses: [...RATE_CLAUSES, 'ANAF/Cod-fiscal-consolidat:art.281(8)'],
        },
      });
    }
  }
  return issues;
}

/** No deduction from a supplier entered in the register of inactive taxpayers. */
const INACTIVE_CLAUSE = 'ANAF/Cod-fiscal-consolidat:art.11(7)';
const inactiveExceptions = {
  forced_execution: 'bunuri cumpărate în procedura de executare silită',
  bankruptcy: 'achiziție de la un furnizor aflat în procedura falimentului (Legea nr. 85/2014)',
} as const;

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

/** An allocated amount: negative only for an advance deducted by the final invoice. */
const amountPattern = /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

/** A road vehicle's registration as written (`B-123-XFA`); it is read without spaces or dashes,
 * as the `vehicle.use` question names it. */
export const registration = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .refine((value) => /^[\p{L}\p{N}]{2,15}$/u.test(normalizePlate(value)), {
    message: 'Numărul de înmatriculare are doar litere și cifre, despărțite de spații sau cratime.',
  });

export const recognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Every line on one account: revenue (70x) for a sale; expense (6xx) or fixed asset (20x,
     * 21x) for a purchase. */
    account: z.string().regex(accountCodePattern).optional(),
    /** Input VAT deduction for a purchase booked on one account; ignored for a sale. `limited`
     * deducts the register's share for vehicles not used only for the business (art. 298);
     * `prorata`, of a company with mixed operations, the provisional pro-rata of a purchase for
     * both kinds of operations (art. 300 alin. (5), (11)); `full` and `none` are then the
     * purchases destined only to operations with, or without, the right of deduction (alin. (3),
     * (4)). */
    deduction: z.enum(['full', 'none', 'limited', 'prorata']).default('full'),
    /** The road vehicle a purchase booked on one account concerns (its registration): what it
     * deducts follows the person's answer about the vehicle's use (`vehicle.use`, art. 298). */
    vehicle: registration.optional(),
    /**
     * Instead of `account`: each VAT category's taxable amount (BT-116) split over accounts, in
     * the document's currency. A category is `S-<rate>`, `O`, or an exempt one (`E`, `K`, `G`),
     * and its parts add up to its
     * amount; allowances and charges are inside it. An advance invoice puts its part on 419
     * (4091, 4092 for a purchase); the final invoice's negative line deducting it goes there too,
     * naming the advance it settles.
     */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            vat: z.string().regex(/^(S-\d{1,2}(\.\d{1,2})?|O|E|K|G)$/),
            amount: z.string().regex(amountPattern),
            /** Input VAT deduction of this part, for a purchase. */
            deduction: z.enum(['full', 'none', 'limited', 'prorata']).default('full'),
            /** The road vehicle this part of a purchase concerns (its registration). */
            vehicle: registration.optional(),
            /** The advance (its open item) a negative part on 419, 4091 or 4092 settles. */
            advance: z.uuid().optional(),
            /** The finance lease (its open item on 167) whose principal a part on 167 repays. */
            lease: z.uuid().optional(),
            /** That principal in the lease's currency, when the invoice is in another (a lease
             * in euro invoiced in lei). */
            principal: z
              .string()
              .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/)
              .optional(),
            /** The expense account the VAT a lease part does not deduct is booked to. */
            vatExpense: z
              .string()
              .regex(/^6\d{2,5}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    /** When the service was provided, if it differs from the tax point. */
    serviceDate: z
      .string()
      .refine((value): boolean => isLocalDate(value))
      .optional(),
    /** A purchase from a supplier inactive on its tax point deducts no VAT (Codul fiscal art. 11
     * alin. (7)) unless it is one of the article's exceptions: goods bought in a forced
     * execution, or a purchase from a supplier in bankruptcy (Legea nr. 85/2014). */
    inactiveException: z.enum(['forced_execution', 'bankruptcy']).optional(),
    /** A sale to a customer affiliated with the company (Codul fiscal art. 7 pct. 26) when the
     * invoice is issued: VAT on collection does not apply to it (art. 282 alin. (6) lit. d)). */
    affiliated: z.boolean().optional(),
    /** The legal basis of a sale's exempt category (E, K, G): it decides the right of deduction
     * and the D300 row (art. 292 rd. 15; art. 294–296 and 297 alin. (4) lit. d) rd. 14; an
     * intra-community supply rd. 1). The invoice's exemption reason (BT-120, BT-121) must agree. */
    exemption: z.enum(exemptionBasisIds).optional(),
    /** A rent or a supply of immovable property taxed by option (art. 292 alin. (3); norme pct. 57
     * alin. (3), pct. 58 alin. (3)): the notification filed with the tax authority, for a sale
     * invoiced with VAT. */
    optionEvidenceId: z.uuid().optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  })
  .refine((input) => input.vehicle === undefined || input.allocations === undefined, {
    message:
      'Cu repartizarea pe conturi, vehiculul se indică pe fiecare parte (allocations.vehicle).',
    path: ['vehicle'],
  });
export type RecognitionInput = z.infer<typeof recognitionInput>;

const categoryKey = (category: string, rate: string | null) =>
  category === 'S' ? `S-${rate}` : category;

/**
 * The VAT categories of a document as its breakdown (BG-23) gives them, each at a rate the rule
 * register has in force on the tax-point date, with the company's registration on that date.
 */
function vatCategories(invoice: Invoice, loaded: Loaded, rules: RuleContext, taxPoint: LocalDate) {
  const issues: Issue[] = [];
  const body = invoice.body;
  const status = profileAt(loaded, 'vat.status', taxPoint);
  if (!status)
    // An owner fact nobody recorded: a question for a reviewer, whose answer records the fact.
    issues.push(
      questionIssue(
        'DETERMINATION_MISSING',
        'Înregistrați regimul TVA al companiei pentru această dată.',
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'vat.status' },
          params: { axis: 'vat.status', from: taxPoint },
        },
      ),
    );
  const categories = body.taxes.map((tax) => ({
    key: categoryKey(tax.category, tax.rate),
    category: tax.category,
    rate: tax.rate,
    base: tax.base,
    tax: tax.tax,
    /** The exemption reason the supplier gave (BT-121, else BT-120). */
    reason: tax.exemptionReason,
  }));
  const keys = new Set(categories.map((item) => item.key));
  if (
    keys.size !== categories.length ||
    body.lines.some((line) => !keys.has(categoryKey(line.vatCategory, line.vatRate)))
  )
    issues.push(
      block('TAX_BREAKDOWN', 'Liniile documentului nu corespund defalcării TVA pe categorii.'),
    );
  let standard: string | undefined;
  let reduced: string | null | undefined;
  for (const tax of categories) {
    if (tax.category === 'S') {
      standard ??= rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, {
        category: 'S',
      });
      if (tax.rate !== standard) {
        if (reduced === undefined) {
          reduced = null;
          try {
            reduced = rules.param<string>(
              'ro.vat.rate.reduced',
              'vat_chargeability_date',
              taxPoint,
            );
          } catch (error) {
            if (!(error instanceof RuleGapError)) throw error;
          }
        }
        // The reduced rate applies only to the supplies of art. 291 alin. (2): the reviewer
        // confirms.
        issues.push(
          tax.rate === reduced
            ? warn(
                'REDUCED_RATE',
                `Cota redusă de ${reduced}% se aplică doar livrărilor și prestărilor de la art. 291 alin. (2) din Codul fiscal: confirmați că operațiunea se încadrează.`,
              )
            : block(
                'VAT_RATE',
                `Cota din document (${tax.rate}%) diferă de cotele în vigoare (${standard}%${reduced ? `, ${reduced}%` : ''}).`,
              ),
        );
      }
    } else if (isExemptCategory(tax.category)) {
      // Exempt (E), intra-community (K) and export (G) categories carry no VAT (BR-E-08,
      // BR-IC-08, BR-G-08). A purchase in K is an intra-community acquisition of goods, which
      // the buyer self-assesses (art. 307 alin. (1); D300 rd. 5 and 20): not covered yet.
      if (ron(tax.tax) !== 0n)
        issues.push(
          block('TAX_CATEGORY', `Categoria TVA ${tax.category} nu are TVA: factura înscrie TVA.`),
        );
      if (invoice.direction === 'purchase' && tax.category === 'K')
        issues.push(
          block(
            'INTRA_EU_GOODS',
            'Factura cu categoria K este o achiziție intracomunitară de bunuri: TVA se autolichidează de cumpărător (art. 307 alin. (1) din Codul fiscal; D300 rd. 5 și 20, D390 tip A), ceea ce nu este încă acoperit.',
          ),
        );
    } else if (tax.category !== 'O' || ron(tax.tax) !== 0n)
      issues.push(
        block('TAX_CATEGORY', `Categoria TVA ${tax.category} cere un tratament separat.`),
      );
    if (invoice.direction === 'sale') {
      if (status === 'normal_vat' && tax.category !== 'S' && !isExemptCategory(tax.category))
        issues.push(
          block(
            'TAX_CATEGORY',
            'Un plătitor de TVA facturează această operațiune cu TVA, sau ca scutită (E, K, G) cu temeiul scutirii.',
          ),
        );
      if (status === 'non_vat' && tax.category !== 'O')
        issues.push(block('TAX_CATEGORY', 'Un neplătitor de TVA nu colectează TVA.'));
    }
  }
  return { issues, status, categories };
}

/** `total` split by `weights`, or zeros when the weights are all zero. */
const share = (total: bigint, weights: readonly bigint[]) =>
  weights.some((weight) => weight !== 0n) ? allocate(total, weights) : weights.map(() => 0n);

/**
 * Recognizes a domestic invoice: revenue and output VAT for a sale, expense or fixed asset and
 * deductible (or non-deductible) VAT for a purchase, with the receivable or payable as an open
 * item of the counterparty. VAT comes from the rule register at the tax-point date. An invoice
 * goes on one account, or its VAT categories are split over accounts (`allocations`), each part
 * with its own deduction: one tax entry per category, one line per part. A purchase reads ANAF's
 * status of a Romanian supplier on the tax point, when one was checked: from a supplier then
 * inactive, no part deducts VAT. Under VAT on collection (cashVatOf) the VAT, or the deduction,
 * waits on 4428 with no exigibility until the collection or payment releases it.
 */
export const invoiceRecognition: Treatment<RecognitionInput> = {
  id: 'invoices.recognize',
  version: 1,
  description:
    'Factură internă: venit, cheltuială sau imobilizare pe unul sau mai multe conturi, TVA pe cote și creanța sau datoria față de partener.',
  input: recognitionInput,
  agent: true,
  summary:
    'Domestic invoice: revenue, expense or asset lines, VAT by rate and the receivable or payable to the partner.',
  toolset: 'inbox',
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => {
    const advances = (input.allocations ?? []).flatMap((part) =>
      part.advance ? [part.advance] : [],
    );
    const leases = (input.allocations ?? []).flatMap((part) => (part.lease ? [part.lease] : []));
    return {
      documents: [input.documentId],
      profile: true,
      ...(input.optionEvidenceId ? { evidence: [input.optionEvidenceId] } : {}),
      ...(advances.length || leases.length
        ? {
            openItems: [
              ...(advances.length ? [{ ids: advances }] : []),
              ...(leases.length ? [{ ids: leases, schedules: true }] : []),
            ],
          }
        : {}),
    };
  },
  followUp(input, loaded) {
    const record = loaded.documents.get(input.documentId);
    const parsed = invoiceDocumentSchema.safeParse(record?.body);
    if (!record || !parsed.success) return null;
    const body = parsed.data;
    const plan: ReadPlan = {};
    // The rates up to the issue date (accounting) and up to the tax point (VAT), which a supply
    // date (BT-72) can put weeks earlier.
    if (body.currency !== LEDGER_CURRENCY)
      plan.fx = [...new Set([body.issueDate, taxPointOf(body)])].map((until) => ({
        currency: body.currency,
        until: date(until),
      }));
    // A lease in a currency the invoice is not in: its principal at the issue date's rate.
    const leaseCurrencies = [
      ...new Set(
        (input.allocations ?? []).flatMap((part) => {
          const lease = part.lease ? loaded.openItems.get(part.lease) : undefined;
          return lease && lease.currency !== LEDGER_CURRENCY && lease.currency !== body.currency
            ? [lease.currency]
            : [];
        }),
      ),
    ].sort();
    if (leaseCurrencies.length) {
      plan.fx = [
        ...(plan.fx ?? []),
        ...leaseCurrencies.map((currency) => ({ currency, until: date(body.issueDate) })),
      ];
      plan.profile = true;
    }
    if (record.kind === invoiceKinds.purchase && record.partyId && body.supplier.country === 'RO')
      plan.partyStatus = [{ partyId: record.partyId, date: taxPointOf(body) }];
    return plan.fx || plan.partyStatus ? plan : null;
  },
  evaluate(input, loaded, rules) {
    const invoice = invoiceOf(loaded, input.documentId, false);
    if ('code' in invoice) return { effect: null, issues: [invoice] };
    const { body, direction } = invoice;
    // The supply's date when the document states it (BT-72), else BT-7 or the issue date: it
    // gives the rate, the exigibility and so the VAT period (art. 282 alin. (1), 291 alin. (4)).
    const chargeable = chargeabilityOf(body);
    const taxPoint = chargeable.date;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const vat = vatCategories(invoice, loaded, rules, taxPoint);
    const amounts = amountsFor(invoice, loaded, rules, taxPoint);
    const issues = [
      ...vat.issues,
      ...chargeabilityIssues(body, chargeable, rules),
      ...amounts.issues,
    ];
    const parts: {
      account: string;
      vat: string;
      amount: string;
      deduction: 'full' | 'none' | 'limited' | 'prorata';
      vehicle?: string;
      advance?: string;
      lease?: string;
      principal?: string;
      vatExpense?: string;
    }[] = input.allocations ?? [
      ...vat.categories.map((item) => ({
        account: input.account!,
        vat: item.key,
        amount: item.base,
        deduction: input.deduction,
        ...(input.vehicle === undefined ? {} : { vehicle: input.vehicle }),
      })),
    ];
    // Advances: received from customers on 419, paid to suppliers on 4091 (stocks) or 4092
    // (services), each an open item of the partner.
    const advanceAccount = direction === 'sale' ? /^419$/ : /^409[12]$/;
    const advanceKind = direction === 'sale' ? 'advance.received' : 'advance.paid';
    const isAdvance = parts.map((part) => advanceAccount.test(part.account));
    const negative = parts.map((part) => part.amount.startsWith('-'));
    // A finance lease's instalment: its principal repays the lease on 167, its interest is on 666,
    // and the lessor is held on 404 (OMFP 1802/2014, the functions of accounts 167, 404 and 666).
    const isLease = parts.map((part) => part.account.split('.')[0] === '167');
    const leases = parts.map((part) => (part.lease ? loaded.openItems.get(part.lease) : undefined));
    const leaseRates: (FxRate | undefined)[] = parts.map(() => undefined);
    parts.forEach((part, index) => {
      const path = input.allocations ? `allocations.${index}` : 'account';
      if (!isLease[index]) {
        if (part.lease || part.principal || part.vatExpense)
          issues.push(
            block(
              'LEASE',
              'Leasingul, principalul și contul TVA nedeductibile se indică doar pe o rată de capital (167).',
              path,
            ),
          );
        return;
      }
      const lease = leases[index];
      if (
        direction !== 'purchase' ||
        !lease ||
        lease.kind !== 'loan.payable' ||
        lease.controlAccount !== part.account ||
        lease.partyId !== invoice.record.partyId
      ) {
        issues.push(
          block(
            'LEASE',
            'Indicați leasingul financiar al acestui finanțator (lease), din același cont 167, a cărui rată de capital o facturează.',
            path,
          ),
        );
        return;
      }
      if (parts.some((other, j) => j < index && other.lease === part.lease))
        issues.push(block('LEASE', 'Rata de capital a unui leasing este o singură parte.', path));
      if (lease.currency === body.currency) {
        if (part.principal)
          issues.push(
            block(
              'LEASE_PRINCIPAL',
              'Rata de capital este chiar suma părții.',
              `${path}.principal`,
            ),
          );
        leaseRates[index] = amounts.fx?.accounting;
      } else if (lease.currency === LEDGER_CURRENCY)
        issues.push(block('LEASE_CURRENCY', 'Un leasing în lei se facturează în lei.', path));
      else if (!part.principal)
        issues.push(
          block(
            'LEASE_PRINCIPAL',
            `Indicați rata de capital în ${lease.currency} (principal).`,
            `${path}.principal`,
          ),
        );
      else {
        const selected = selectRate(
          loaded,
          rules,
          lease.currency,
          date(body.issueDate),
          'accounting',
        );
        if ('code' in selected) issues.push(selected);
        else leaseRates[index] = selected;
      }
      if ((part.deduction === 'full') === (part.vatExpense !== undefined))
        issues.push(
          block(
            'LEASE_VAT',
            part.deduction === 'full'
              ? 'Contul pentru TVA nedeductibilă se indică doar când rata nu deduce integral TVA.'
              : 'Indicați contul de cheltuieli în care trece TVA nededusă a ratei de capital (vatExpense, de exemplu 635).',
            `${path}.vatExpense`,
          ),
        );
    });
    parts.forEach((part, index) => {
      const path = input.allocations ? `allocations.${index}` : 'account';
      if (
        !isAdvance[index] &&
        !isLease[index] &&
        (direction === 'sale'
          ? !part.account.startsWith('70')
          : !purchaseAccount.test(part.account))
      )
        issues.push(
          block(
            'ACCOUNT',
            direction === 'sale'
              ? 'Folosiți un cont de venituri (70x) sau de avansuri (419).'
              : 'Folosiți un cont de cheltuieli (6xx), de imobilizări (20x, 21x) sau de avansuri (4091, 4092).',
            input.allocations ? `allocations.${index}.account` : 'account',
          ),
        );
      if (negative[index] && !isAdvance[index])
        issues.push(
          block('ALLOCATION', 'Doar un avans se scade cu o sumă negativă (419, 4091, 4092).', path),
        );
      if (isAdvance[index] && negative[index]) {
        const held = part.advance ? loaded.openItems.get(part.advance) : undefined;
        if (
          !held ||
          held.kind !== advanceKind ||
          held.partyId !== invoice.record.partyId ||
          held.controlAccount !== part.account
        )
          issues.push(
            block(
              'ADVANCE',
              'Indicați avansul acestui partener, din același cont, pe care îl regularizează linia (advance).',
              path,
            ),
          );
      } else if (part.advance)
        issues.push(
          block('ADVANCE', 'Avansul se indică doar pe linia negativă care îl regularizează.', path),
        );
      if (isAdvance[index] && direction === 'purchase' && part.deduction !== 'full')
        issues.push(block('ADVANCE', 'Avansurile se înregistrează cu TVA dedusă integral.', path));
    });
    if (amounts.fx && negative.some(Boolean))
      issues.push(
        block('ADVANCE_CURRENCY', 'Regularizarea avansurilor în valută nu este încă suportată.'),
      );
    for (const item of vat.categories)
      if (
        parts.some((part, p) => part.vat === item.key && negative[p]) &&
        parts.some((part) => part.vat === item.key && part.deduction !== 'full')
      )
        issues.push(
          block(
            'ADVANCE',
            `Categoria ${item.key} scade un avans: părțile ei se înregistrează cu TVA dedusă.`,
            'allocations',
          ),
        );
    const assets = parts.filter((part) => fixedAsset.test(part.account)).length;
    if (direction === 'purchase' && assets && assets !== parts.length)
      issues.push(
        block(
          'ACCOUNT_MIX',
          'Imobilizările și cheltuielile de pe aceeași factură cer furnizori diferiți (404 și 401): înregistrați-le separat.',
          'allocations',
        ),
      );
    const docMinor = (value: string) => parseMoney(value, body.currency);
    if (input.allocations) {
      for (const part of input.allocations)
        if (!vat.categories.some((item) => item.key === part.vat))
          issues.push(
            block('ALLOCATION', `Factura nu are categoria TVA ${part.vat}.`, 'allocations'),
          );
      for (const item of vat.categories) {
        const allocated = input.allocations
          .filter((part) => part.vat === item.key)
          .reduce((sum, part) => sum + docMinor(part.amount), 0n);
        if (allocated !== docMinor(item.base))
          issues.push(
            block(
              'ALLOCATION',
              `Baza categoriei ${item.key} este ${item.base} ${body.currency}; repartizarea însumează ${formatMoney(allocated, body.currency)}.`,
              'allocations',
            ),
          );
      }
    }
    if (ron(body.totals.prepaid) !== 0n)
      issues.push(block('PREPAID', 'Facturile cu avans dedus cer tratamentul de avansuri.'));
    if (body.totals.rounding !== '0.00')
      issues.push(block('ROUNDING', 'Rotunjirea sumei de plată cere un tratament separat.'));
    const deducts =
      direction === 'purchase' &&
      parts.some(
        (part) =>
          part.deduction !== 'none' &&
          vat.categories.find((item) => item.key === part.vat)?.category === 'S',
      );
    if (deducts && vat.status === 'non_vat')
      issues.push(
        block(
          'DEDUCTION',
          'Un neplătitor de TVA nu deduce TVA.',
          input.allocations ? 'allocations' : 'deduction',
        ),
      );
    // A supplier entered as inactive in the register on the tax point: the purchase's VAT is not
    // deducted (nor, for profit tax, its expense), except in the article's two cases.
    const supplier =
      direction === 'purchase' && invoice.record.partyId
        ? loaded.partyStatus.get(partyStatusKey(invoice.record.partyId, taxPoint))
        : undefined;
    if (input.inactiveException && !supplier?.inactive)
      issues.push(
        block(
          'INACTIVE_EXCEPTION',
          'Excepția se indică doar pentru o achiziție de la un furnizor inactiv la data facturii, cu starea verificată la ANAF (parties.checkStatus).',
          'inactiveException',
        ),
      );
    else if (supplier?.inactive && (input.inactiveException || deducts)) {
      const cited = {
        clause: INACTIVE_CLAUSE,
        date: supplier.date,
        evidenceId: supplier.evidenceId,
      };
      issues.push(
        input.inactiveException
          ? {
              ...warn(
                'SUPPLIER_INACTIVE_EXCEPTION',
                `Furnizorul ${supplier.name} (CUI ${supplier.cui}) era inactiv la ${taxPoint}: TVA se deduce doar ca excepție de la art. 11 alin. (7) din Codul fiscal (${inactiveExceptions[input.inactiveException]}). Confirmați că achiziția se încadrează și păstrați documentul care o dovedește.`,
              ),
              details: { ...cited, exception: input.inactiveException },
            }
          : {
              ...block(
                'SUPPLIER_INACTIVE',
                `Furnizorul ${supplier.name} (CUI ${supplier.cui}) era înscris ca inactiv în Registrul contribuabililor inactivi/reactivați la ${taxPoint}${supplier.inactiveSince ? ` (inactiv din ${supplier.inactiveSince})` : ''}. Potrivit art. 11 alin. (7) din Codul fiscal, cheltuiala și TVA aferente achizițiilor de la un contribuabil inactiv nu se deduc: înregistrați factura fără deducere (deduction: none). Excepții: bunurile cumpărate în procedura de executare silită și achizițiile de la un furnizor aflat în procedura falimentului (Legea nr. 85/2014), indicate prin inactiveException.`,
                input.allocations ? 'allocations' : 'deduction',
              ),
              details: cited,
            },
      );
    }
    // Art. 298 limits a deduction: nothing to ask when the purchase deducts nothing anyway (a
    // non-payer, an inactive supplier outside the exceptions).
    const vehicles =
      vat.status === 'non_vat' || (supplier?.inactive && !input.inactiveException)
        ? { issues: [], decided: [] }
        : vehicleIssues(input, invoice, parts, vat.categories, isAdvance, loaded, taxPoint);
    issues.push(...vehicles.issues);
    const cash = cashVatOf(input, invoice, loaded, vat.status, supplier, isAdvance);
    issues.push(...cash.issues);
    const exemption = exemptionIssues(input, invoice, vat.categories, loaded);
    issues.push(...exemption.issues);
    const prorata = prorataOf(input, invoice, parts, vat.categories, loaded, taxPoint, cash.party);
    issues.push(...prorata.issues);
    if (input.serviceDate && input.serviceDate.slice(0, 7) !== taxPoint.slice(0, 7))
      issues.push(
        warn(
          'SERVICE_PERIOD',
          'Serviciul aparține altei luni decât faptul generator; verificați dacă este necesară o regularizare.',
        ),
      );
    if (!invoice.record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const { tax, gross, fx } = amounts as Required<Omit<typeof amounts, 'fx'>> &
      Pick<typeof amounts, 'fx'>;
    const partyId = invoice.record.partyId!;
    // Each part's net and each category's base and VAT in lei: a foreign-currency document's
    // totals (amountsFor) split in proportion to its own amounts, so they add up exactly.
    const categories = vat.categories.map((item) => ({
      ...item,
      minorBase: docMinor(item.base),
      minorTax: docMinor(item.tax),
    }));
    const partMinor = parts.map((part) => docMinor(part.amount));
    const partNet = fx ? share(amounts.net!, partMinor) : partMinor;
    const categoryTax = fx
      ? share(
          tax,
          categories.map((item) => item.minorTax),
        )
      : categories.map((item) => item.minorTax);
    const categoryBase = fx
      ? share(
          amounts.base!,
          categories.map((item) => item.minorBase),
        )
      : categories.map((item) => item.minorBase);
    // Within a category, its VAT split over the parts in proportion to their net amounts: the
    // deductible share goes to 4426, the rest into the expense.
    const partTax = parts.map(() => 0n);
    const partTaxMinor = parts.map(() => 0n);
    categories.forEach((item, c) => {
      const members = parts.flatMap((part, p) => (part.vat === item.key ? [p] : []));
      const weights = members.map((p) => partMinor[p]!);
      // A category deducting an advance has only deductible parts: its VAT is booked whole.
      if (weights.some((weight) => weight < 0n)) {
        partTax[members[0]!] = categoryTax[c]!;
        partTaxMinor[members[0]!] = item.minorTax;
        return;
      }
      share(categoryTax[c]!, weights).forEach((value, i) => (partTax[members[i]!] = value));
      share(item.minorTax, weights).forEach((value, i) => (partTaxMinor[members[i]!] = value));
    });
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
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const item = {
      ref: 'counterparty',
      kind: direction === 'sale' ? ('receivable' as const) : ('payable' as const),
      // Suppliers of fixed assets, and lessors invoicing a finance lease, are held on 404, other
      // suppliers on 401.
      controlAccount:
        direction === 'sale' ? '4111' : assets || isLease.some(Boolean) ? '404' : '401',
      partyId,
      currency: fx?.code ?? LEDGER_CURRENCY,
      normalSide: direction === 'sale' ? ('D' as const) : ('C' as const),
      mayReverse: false,
      documentId: invoice.record.id,
    };
    // What each part deducts of its VAT: all, none, or the register's share for vehicles not
    // used only for the business (Codul fiscal art. 298), half up to the ban; the rest stays in
    // the expense.
    const limited =
      direction === 'purchase' && parts.some((part) => part.deduction === 'limited')
        ? parseScaled(
            rules.param<string>('ro.vat.deduction.limited', 'vat_chargeability_date', taxPoint),
            4,
          )
        : 0n;
    const portion = (amount: bigint, part: (typeof parts)[number]) =>
      direction !== 'purchase' || part.deduction === 'none'
        ? 0n
        : part.deduction === 'full'
          ? amount
          : part.deduction === 'prorata'
            ? prorataShare(amount, prorata.percent!)
            : divRound(amount * limited, 1_000_000n, 'halfAwayFromZero');
    const deducted = parts.map((part, p) => portion(partTax[p]!, part));
    const deductedMinor = parts.map((part, p) => portion(partTaxMinor[p]!, part));
    if (direction === 'sale')
      lines.push(
        line({ account: '4111', side: 'D', bani: gross, openItem: item.ref, partyId }, fx?.gross),
      );
    // A lease part repays principal in the lease's currency, releasing its carrying amount in
    // proportion (all of it when the lease is paid off); the difference from the invoice's lei is
    // an exchange difference, on 668 or 768 for a lease settled in lei at a currency's rate (the
    // functions of account 167). The VAT it does not deduct goes to an expense account.
    const leaseLines = (p: number): LineSpec[] => {
      const part = parts[p]!;
      const lease = leases[p]!;
      const rate = leaseRates[p];
      const foreign = lease.currency !== LEDGER_CURRENCY;
      const minor =
        lease.currency === body.currency
          ? partMinor[p]!
          : parseMoney(part.principal!, lease.currency);
      const release = foreign
        ? carryingRelease(lease.balanceBani, lease.balanceMinor, minor)
        : partNet[p]!;
      const result: LineSpec[] = [
        {
          account: part.account,
          side: 'D',
          bani: release,
          openItem: lease.id,
          partyId,
          ...(foreign && rate
            ? { currency: { code: lease.currency, minor, rateId: rate.id, rate: rate.rate } }
            : {}),
        },
      ];
      const kept = partTax[p]! - deducted[p]!;
      if (kept !== 0n)
        result.push(
          line(
            { account: part.vatExpense!, side: 'D', bani: kept },
            partTaxMinor[p]! - deductedMinor[p]!,
          ),
        );
      const difference = partNet[p]! - release;
      if (difference !== 0n) {
        const indexed = lease.schedule?.method === INDEXED_LEASE_METHOD;
        const loss = difference > 0n;
        result.push({
          account: loss ? (indexed ? '668' : '6651') : indexed ? '768' : '7651',
          side: loss ? 'D' : 'C',
          bani: loss ? difference : -difference,
          memo: 'Diferență de curs la rata de leasing',
        });
      }
      return result;
    };
    const advanceItems: OpenItemSpec[] = [];
    parts.forEach((part, p) => {
      const kept = direction === 'purchase';
      // An advance invoiced opens the partner's advance; a negative part settles one.
      let advance: Pick<LineSpec, 'openItem' | 'partyId'> = {};
      if (isAdvance[p] && !negative[p]) {
        advanceItems.push({
          ref: `advance-${p}`,
          kind: advanceKind,
          controlAccount: part.account,
          partyId,
          currency: LEDGER_CURRENCY,
          normalSide: direction === 'sale' ? 'C' : 'D',
          mayReverse: false,
          documentId: invoice.record.id,
        });
        advance = { openItem: `advance-${p}`, partyId };
      } else if (isAdvance[p]) advance = { openItem: part.advance!, partyId };
      if (isLease[p]) {
        lines.push(...leaseLines(p));
        return;
      }
      lines.push(
        line(
          {
            account: part.account,
            side: direction === 'sale' ? 'C' : 'D',
            bani: partNet[p]! + (kept ? partTax[p]! - deducted[p]! : 0n),
            ...advance,
          },
          partMinor[p]! + (kept ? partTaxMinor[p]! - deductedMinor[p]! : 0n),
        ),
      );
    });
    categories.forEach((category, c) => {
      // An exempt category is declared by its base (D300 rd. 1, 14, 15, 29), without VAT.
      const exempt = isExemptCategory(category.category);
      if (categoryTax[c] === 0n && !exempt) return;
      const members = parts.flatMap((part, p) => (part.vat === category.key ? [p] : []));
      const deductedTax = members.reduce((sum, p) => sum + deducted[p]!, 0n);
      const deductedTaxMinor = members.reduce((sum, p) => sum + deductedMinor[p]!, 0n);
      const ledger = direction === 'sale' ? categoryTax[c]! : deductedTax;
      // Under VAT on collection the VAT waits on 4428; a purchase defers only what it would
      // deduct (norme pct. 67 alin. (8)).
      const deferred = cash.party !== undefined && ledger !== 0n;
      if (ledger !== 0n)
        lines.push(
          line(
            {
              account: deferred ? '4428' : direction === 'sale' ? '4427' : '4426',
              side: direction === 'sale' ? 'C' : 'D',
              bani: ledger,
            },
            direction === 'sale' ? category.minorTax : deductedTaxMinor,
            fx?.vat,
          ),
        );
      const entry = vatEntry(
        invoice,
        {
          baseBani: categoryBase[c]!,
          taxBani: categoryTax[c]!,
          deductibleBani: direction === 'sale' ? 0n : deductedTax,
          ledgerBani: ledger,
          ...(ledger !== 0n ? { line: lines.length - 1 } : {}),
          taxPoint,
          ...(deferred ? { exigibility: null } : {}),
          taxPeriod,
          ...(fx
            ? {
                currency: {
                  code: fx.code,
                  baseMinor: category.minorBase,
                  taxMinor: category.minorTax,
                  rateId: fx.vat.id,
                  rate: fx.vat.rate,
                },
              }
            : {}),
        },
        exempt
          ? direction === 'sale'
            ? exemption.code!
            : exemptCodes.purchase
          : category.category === 'S'
            ? `S-${category.rate}`
            : 'O',
      );
      // A purchase part for both kinds of operations: the VAT the year-end adjustment takes to
      // the definitive pro-rata (art. 300 alin. (14)), and what the provisional deducted of it.
      const mixed = members.filter((p) => parts[p]!.deduction === 'prorata');
      taxEntries.push({
        ...entry,
        key: categories.length === 1 ? 'vat' : `vat:${category.key}`,
        attributes: {
          ...entry.attributes,
          ...(exempt
            ? {
                category: category.category,
                ...(direction === 'sale' ? { exemption: input.exemption! } : {}),
                ...(category.reason ? { reason: category.reason } : {}),
              }
            : {}),
          ...(mixed.length && direction === 'purchase'
            ? {
                prorata: String(prorata.percent),
                prorataTax: String(mixed.reduce((sum, p) => sum + partTax[p]!, 0n)),
                prorataDeducted: String(mixed.reduce((sum, p) => sum + deducted[p]!, 0n)),
              }
            : {}),
          ...(input.optionEvidenceId && direction === 'sale' && category.category === 'S'
            ? { option: 'art.292(3)' }
            : {}),
          ...(cash.party && !exempt ? { cashVat: cash.party, invoice: invoice.record.id } : {}),
        },
      });
    });
    if (direction === 'purchase')
      lines.push(
        line(
          { account: item.controlAccount, side: 'C', bani: gross, openItem: item.ref, partyId },
          fx?.gross,
        ),
      );
    const effect: Effect = {
      schema: 'effect@1',
      date: date(body.issueDate),
      journalClass: 'general',
      journalCode: direction === 'sale' ? 'VANZARI' : 'CUMPARARI',
      description: `${direction === 'sale' ? 'Factură emisă' : 'Factură primită'} ${body.number}`,
      lines,
      openItems: [item, ...advanceItems],
      taxEntries,
      schedules: [],
      explanation: {
        summary: fx
          ? `${body.number} din ${body.issueDate}: ${body.totals.gross} ${fx.code} la cursul ${fx.accounting.rate} (${fx.accounting.date}); TVA ${formatMoney(tax, LEDGER_CURRENCY)} lei.`
          : `${body.number} din ${body.issueDate}: bază ${body.totals.net}, TVA ${body.totals.tax}, total ${body.totals.gross} lei.`,
        details: {
          taxPoint,
          ...(chargeable.supplied
            ? { supplyDate: chargeable.supplied, taxPointBasis: chargeable.basis }
            : {}),
          ...(categories.length === 1
            ? { category: categories[0]!.category, rate: categories[0]!.rate }
            : { categories: categories.map((category) => category.key) }),
          deduction: direction === 'purchase' && !input.allocations ? input.deduction : null,
          ...(input.exemption
            ? {
                exemption: {
                  basis: input.exemption,
                  label: exemptionBases[input.exemption].label,
                  code: exemption.code ?? null,
                  clause: exemptionBases[input.exemption].clause,
                },
              }
            : {}),
          ...(prorata.percent !== undefined
            ? { prorata: { percent: prorata.percent, clauses: [EXEMPT_CLAUSES.provisional] } }
            : {}),
          ...(input.optionEvidenceId
            ? {
                option: { evidenceId: input.optionEvidenceId, clause: EXEMPT_CLAUSES.option },
              }
            : {}),
          ...(vehicles.decided.length
            ? { vehicles: vehicles.decided, vehicleClauses: VEHICLE_CLAUSES }
            : {}),
          ...(input.allocations
            ? {
                allocations: parts.map(
                  (part) =>
                    `${part.account} ${part.vat} ${part.amount}${direction === 'purchase' ? ` ${part.deduction}` : ''}`,
                ),
              }
            : {}),
          ...(supplier
            ? {
                supplierStatus: {
                  date: supplier.date,
                  inactive: supplier.inactive,
                  evidenceId: supplier.evidenceId,
                  ...(supplier.inactive ? { clause: INACTIVE_CLAUSE } : {}),
                  ...(input.inactiveException ? { exception: input.inactiveException } : {}),
                  ...(supplier.cashVat ? { cashVat: true } : {}),
                },
              }
            : {}),
          ...(cash.party
            ? {
                vatOnCollection: {
                  party: cash.party,
                  clauses: [
                    cashVatClauses.chargeability,
                    ...(cash.party !== 'own' ? [cashVatClauses.supplier] : []),
                    ...(direction === 'purchase' && cash.party !== 'supplier'
                      ? [cashVatClauses.own]
                      : []),
                  ],
                },
              }
            : input.affiliated
              ? { vatOnCollection: { excluded: 'affiliated', clauses: [cashVatClauses.scope] } }
              : {}),
        },
      },
    };
    return { effect, issues };
  },
};

/** What a vehicle's answer decided for an invoice, as the explanation shows it. */
type VehicleDecision = {
  vehicle: string;
  use: 'business_only' | 'mixed';
  from: string;
  exception: string | null;
  deduction: 'full' | 'limited';
  questionId: string;
  answerId: string;
  evidence: string[];
};

/**
 * Codul fiscal art. 298 on a purchase: a part about a road vehicle (`vehicle`) deducts what the
 * person's answer about that vehicle allows, cited in the proposal's basis (`vehicle.use`): in
 * full when it is used only for the business, shown by its log, or the article does not limit it
 * (over 3,500 kg or 9 seats, alin. (2); the uses of alin. (3) lit. b)–f)); else the limited
 * share. Without an answer that speaks for the tax point, the question is asked (`VEHICLE_USE`);
 * a deduction the answer does not allow is refused (`VEHICLE_DEDUCTION`). A part deducting the
 * limited share, or on an account that suggests a vehicle, without naming one, is confirmed by
 * the reviewer (`VEHICLE_UNNAMED`). Parts deducting nothing (`none`, or no VAT) need no answer.
 */
function vehicleIssues(
  input: RecognitionInput,
  invoice: Invoice,
  parts: readonly { account: string; vat: string; deduction: string; vehicle?: string }[],
  categories: readonly { key: string; category: string }[],
  isAdvance: readonly boolean[],
  loaded: Loaded,
  taxPoint: LocalDate,
): { issues: Issue[]; decided: VehicleDecision[] } {
  const issues: Issue[] = [];
  const decided: VehicleDecision[] = [];
  const at = (index: number, field: string) =>
    input.allocations ? `allocations.${index}.${field}` : field;
  if (invoice.direction === 'sale') {
    parts.forEach((part, index) => {
      if (part.vehicle)
        issues.push(
          block(
            'VEHICLE',
            'Vehiculul se indică doar pe o achiziție (art. 298 din Codul fiscal).',
            at(index, 'vehicle'),
          ),
        );
    });
    return { issues, decided };
  }
  const lines = invoice.body.lines.map((line) => line.description);
  const named = new Map<string, number[]>();
  const unnamed = new Set<string>();
  parts.forEach((part, index) => {
    const deducts =
      part.deduction !== 'none' &&
      categories.find((item) => item.key === part.vat)?.category === 'S';
    if (part.vehicle !== undefined && isAdvance[index]) {
      issues.push(
        block(
          'VEHICLE',
          'Limitarea deducerii pentru vehicule nu este încă suportată pe avansuri: un avans se înregistrează fără vehicul, cu TVA dedusă integral.',
          at(index, 'vehicle'),
        ),
      );
      return;
    }
    if (!deducts || isAdvance[index]) return;
    if (part.vehicle === undefined) {
      if (part.deduction === 'limited' || suggestsVehicle(part.account, lines))
        unnamed.add(part.account);
      return;
    }
    const plate = normalizePlate(part.vehicle);
    named.set(plate, [...(named.get(plate) ?? []), index]);
  });
  if (unnamed.size)
    issues.push({
      ...warn(
        'VEHICLE_UNNAMED',
        `Achiziția pare să privească un vehicul rutier (contul ${[...unnamed].join(', ')} sau liniile facturii), ori deduce TVA limitat, fără să numească vehiculul. Indicați numărul lui de înmatriculare (vehicle), ca deducerea să urmeze răspunsul despre folosirea lui (art. 298 din Codul fiscal), sau confirmați deducerea aleasă.`,
      ),
      details: { accounts: [...unnamed], clauses: VEHICLE_CLAUSES },
    });
  for (const [plate, indexes] of named) {
    const found = vehicleAnswer(loaded, plate);
    if (!found || !answerCovers(found.value, taxPoint)) {
      issues.push(
        questionIssue(
          'VEHICLE_USE',
          found
            ? `Răspunsul despre vehiculul ${plate} privește folosirea lui de la ${found.value.from}, după data exigibilității facturii (${taxPoint}): proprietarul spune cum era folosit la acea dată, iar propunerea se revizuiește citând răspunsul.`
            : `Achiziția privește vehiculul ${plate}: TVA se deduce integral doar dacă vehiculul este folosit exclusiv în scopul activității economice, cu foaia de parcurs, sau dacă art. 298 nu îl limitează (peste 3.500 kg sau 9 locuri, agenți de vânzări, transport cu plată, închiriere, mărfuri); altfel 50%. Întrebați proprietarul (vehicle.use) și revizuiți propunerea citând răspunsul.`,
          {
            kind: 'vehicle.use',
            subject: vehicleSubject(plate),
            params: { documentId: invoice.record.id, date: taxPoint },
          },
          'block',
          at(indexes[0]!, 'vehicle'),
        ),
      );
      continue;
    }
    const allowed = vehicleDeduction(found.value);
    const answer = { questionId: found.record.questionId, answerId: found.record.answerId };
    for (const index of indexes)
      if (parts[index]!.deduction !== allowed)
        issues.push({
          ...block(
            'VEHICLE_DEDUCTION',
            `După răspunsul despre vehiculul ${plate} (${found.value.exception ? `exceptat de la limitare: ${found.value.exception}` : found.value.use === 'business_only' ? 'folosit exclusiv în scopul activității economice' : 'folosit și în alte scopuri'}, de la ${found.value.from}), TVA se deduce ${allowed === 'full' ? 'integral (deduction: full)' : 'limitat, în proporția de la art. 298 (deduction: limited)'}.`,
            at(index, 'deduction'),
          ),
          details: { vehicle: plate, allowed, ...answer, clauses: VEHICLE_CLAUSES },
        });
    decided.push({
      vehicle: plate,
      use: found.value.use,
      from: found.value.from,
      exception: found.value.exception ?? null,
      deduction: allowed,
      ...answer,
      evidence: [
        found.record.evidenceId,
        ...(found.value.logEvidenceId ? [found.value.logEvidenceId] : []),
        ...(found.value.exceptionEvidenceId ? [found.value.exceptionEvidenceId] : []),
      ],
    });
  }
  return { issues, decided };
}

/** The registered clauses of exempt operations and the pro-rata. */
const EXEMPT_CLAUSES = {
  reason: 'ANAF/Cod-fiscal-consolidat:art.319(20)(l)',
  option: 'ANAF/Cod-fiscal-consolidat:norme.art.292.pct.57-59',
  prorata: 'ANAF/Cod-fiscal-consolidat:art.300(1)-(7)',
  provisional: 'ANAF/Cod-fiscal-consolidat:art.300(8)-(14)',
};

/**
 * A sale's exempt category and its legal basis (Codul fiscal art. 292, 294–296, 297 alin. (4)):
 * the basis is stated, allows the category, and the invoice's exemption reason agrees with it
 * (its VATEX code, BT-121); a reason given only as text is confirmed by the reviewer, as is an
 * exemption the books cannot prove by themselves (an export, an intra-community supply). An
 * intra-community supply needs the customer's VAT code of another member state (art. 294 alin.
 * (2) lit. a)). A purchase carries its supplier's reason through and names no basis.
 */
function exemptionIssues(
  input: RecognitionInput,
  invoice: Invoice,
  categories: readonly { key: string; category: string; reason: string | null }[],
  loaded: Loaded,
): { issues: Issue[]; code?: string } {
  const issues: Issue[] = [];
  const exempt = categories.filter((item) => isExemptCategory(item.category));
  if (invoice.direction === 'purchase') {
    if (input.exemption)
      issues.push(
        block(
          'EXEMPTION',
          'Temeiul scutirii se indică pentru o vânzare; o achiziție scutită păstrează motivul scutirii înscris de furnizor.',
          'exemption',
        ),
      );
    if (input.optionEvidenceId)
      issues.push(
        block(
          'OPTION',
          'Notificarea opțiunii de taxare se indică pentru o vânzare.',
          'optionEvidenceId',
        ),
      );
    return { issues };
  }
  if (input.optionEvidenceId) {
    if (!loaded.evidence.has(input.optionEvidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Notificarea opțiunii de taxare nu este disponibilă.',
          'optionEvidenceId',
        ),
      );
    if (!categories.some((item) => item.category === 'S'))
      issues.push(
        block(
          'OPTION',
          'Opțiunea de taxare (art. 292 alin. (3) din Codul fiscal) se aplică unei facturi cu TVA (categoria S); fără ea, închirierea sau livrarea bunului imobil este scutită (E).',
          'optionEvidenceId',
        ),
      );
  }
  if (!exempt.length) {
    if (input.exemption)
      issues.push(block('EXEMPTION', 'Factura nu are o categorie scutită (E, K, G).', 'exemption'));
    return { issues };
  }
  if (exempt.length > 1)
    issues.push(
      block(
        'EXEMPTION',
        `Factura are mai multe categorii scutite (${exempt.map((item) => item.key).join(', ')}): fiecare temei de scutire se facturează separat.`,
        'exemption',
      ),
    );
  if (!input.exemption) {
    issues.push(
      block(
        'EXEMPTION_BASIS',
        `Indicați temeiul scutirii (exemption): ${exemptionBasisIds.map((id) => `${id}, ${exemptionBases[id].label}`).join('; ')}. Temeiul decide dreptul de deducere (art. 297 alin. (4) din Codul fiscal) și rândul decontului.`,
        'exemption',
      ),
    );
    return { issues };
  }
  const id: ExemptionBasisId = input.exemption;
  const basis = exemptionBases[id];
  for (const item of exempt) {
    if (!(basis.categories as readonly string[]).includes(item.category))
      issues.push(
        block(
          'EXEMPTION_CATEGORY',
          `Temeiul ${id} se facturează cu categoria ${basis.categories.join(' sau ')}, nu ${item.category}.`,
          'exemption',
        ),
      );
    const agrees = reasonAgrees(id, item.reason);
    if (agrees === 'missing')
      issues.push(
        block(
          'EXEMPTION_REASON',
          'Factura nu înscrie motivul scutirii (BT-120 sau codul VATEX, BT-121): factura pentru o operațiune scutită cuprinde temeiul legal al scutirii (art. 319 alin. (20) lit. l) din Codul fiscal). Corectați factura.',
        ),
      );
    else if (agrees === 'contradicts' || agrees === 'other')
      issues.push({
        ...block(
          'EXEMPTION_REASON',
          `Codul motivului scutirii din factură (${item.reason}) nu corespunde temeiului ${id} (${basis.label}).`,
          'exemption',
        ),
        details: { reason: item.reason, basis: id, clause: basis.clause },
      });
    else if (agrees === 'text')
      issues.push({
        ...warn(
          'EXEMPTION_TEXT',
          `Factura înscrie motivul scutirii ca text („${item.reason}”), nu ca cod VATEX: confirmați că el arată temeiul ${id} (${basis.label}).`,
        ),
        details: { reason: item.reason, basis: id, clause: basis.clause },
      });
  }
  const proof: string | undefined = 'proof' in basis ? basis.proof : undefined;
  if (proof)
    issues.push({
      ...warn('EXEMPTION_PROOF', `${proof} Confirmați că documentele există.`),
      details: { basis: id, clause: basis.clause },
    });
  const customer = invoice.body.customer;
  if (id === 'art.294(2)(a)') {
    const prefix = euVatPrefixes[customer.country];
    const code = customer.taxId.toUpperCase().replace(/\s+/g, '');
    if (!prefix || customer.country === 'RO' || !code.startsWith(prefix))
      issues.push(
        block(
          'EXEMPTION_CUSTOMER',
          `Livrarea intracomunitară este scutită doar către o persoană care îi comunică furnizorului un cod de TVA atribuit de alt stat membru (art. 294 alin. (2) lit. a) din Codul fiscal); clientul ${customer.name} are ${code || 'niciun cod'} (${customer.country}).`,
        ),
      );
  }
  if (id === 'art.297(4)(d)' && (customer.country === 'RO' || euVatPrefixes[customer.country]))
    issues.push({
      ...warn(
        'EXEMPTION_PROOF',
        `Clientul ${customer.name} este stabilit în Uniunea Europeană (${customer.country}): dreptul de deducere al art. 297 alin. (4) lit. d) din Codul fiscal se păstrează doar dacă operațiunea este în legătură directă cu bunuri exportate. Confirmați.`,
      ),
      details: { basis: id, clause: basis.clause },
    });
  return { issues, code: basis.code };
}

/**
 * The provisional pro-rata a purchase part for both kinds of operations deducts (`prorata`,
 * Codul fiscal art. 300 alin. (5), (11)): the company's `vat.prorata` fact of the tax point's
 * year, asked when none is recorded. A special pro-rata and the option of alin. (20) are not
 * computed; nor is a pro-rata under VAT on collection (norme pct. 79 alin. (18)–(20)). A
 * company with a recorded pro-rata confirms each purchase allocated directly (alin. (3)–(4)).
 */
function prorataOf(
  input: RecognitionInput,
  invoice: Invoice,
  parts: readonly { vat: string; deduction: string }[],
  categories: readonly { key: string; category: string }[],
  loaded: Loaded,
  taxPoint: LocalDate,
  cashParty: CashVatParty | undefined,
): { issues: Issue[]; percent?: number } {
  const issues: Issue[] = [];
  const path = input.allocations ? 'allocations' : 'deduction';
  const taxed = (part: { vat: string }) =>
    categories.find((item) => item.key === part.vat)?.category === 'S';
  const wanted = parts.some((part) => part.deduction === 'prorata');
  if (invoice.direction === 'sale') return { issues };
  const provisional = provisionalProrata(loaded.profile, taxPoint);
  if (!wanted) {
    // A mixed company: a purchase allocated directly is confirmed by the reviewer.
    if (
      provisional.found &&
      provisional.fact.kind === 'percent' &&
      parts.some((part) => taxed(part) && part.deduction !== 'prorata')
    )
      issues.push({
        ...warn(
          'PRORATA_DIRECT',
          `Compania aplică pro rata (${provisional.fact.percent}% pentru ${taxPoint.slice(0, 4)}): o achiziție dedusă integral este destinată exclusiv operațiunilor cu drept de deducere (art. 300 alin. (3) din Codul fiscal), una nededusă exclusiv celor fără drept de deducere (alin. (4)). Confirmați destinația sau înregistrați-o cu deduction: prorata.`,
        ),
        details: { percent: provisional.fact.percent, clauses: [EXEMPT_CLAUSES.prorata] },
      });
    return { issues };
  }
  if (!provisional.found) {
    issues.push(
      questionIssue(
        'PRORATA_MISSING',
        provisional.reason === 'earlier_year'
          ? `Pro rata provizorie se comunică pentru fiecare an (art. 300 alin. (9) din Codul fiscal): cea înregistrată este din ${provisional.from}. Înregistrați pro rata provizorie a anului ${taxPoint.slice(0, 4)} (vat.prorata).`
          : `Achiziția este destinată ambelor feluri de operațiuni: TVA se deduce pe bază de pro rata (art. 300 alin. (5) din Codul fiscal). Înregistrați pro rata provizorie a anului (vat.prorata), cu comunicarea ei către organul fiscal.`,
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: `vat.prorata/${taxPoint.slice(0, 4)}` },
          params: { axis: 'vat.prorata', from: `${taxPoint.slice(0, 4)}-01-01` },
        },
        'block',
        path,
      ),
    );
    return { issues };
  }
  if (provisional.fact.kind === 'special')
    issues.push(
      block(
        'PRORATA_SPECIAL',
        'Pro rata specială aprobată sau impusă de Ministerul Finanțelor (art. 300 alin. (16)–(18) din Codul fiscal), pe sectoare de activitate sau pe operațiunile din decizie, nu este încă acoperită.',
        path,
      ),
    );
  if (provisional.fact.kind === 'opted_out')
    issues.push(
      block(
        'PRORATA_OPTED_OUT',
        'Compania a optat să nu deducă TVA aferentă achizițiilor destinate ambelor feluri de operațiuni (art. 300 alin. (20) din Codul fiscal): înregistrați achiziția cu deduction: none.',
        path,
      ),
    );
  if (cashParty !== undefined)
    issues.push(
      block(
        'PRORATA_CASH_VAT',
        'Deducerea pe bază de pro rata a unei achiziții în sistemul TVA la încasare (norme pct. 79 alin. (18)–(20)) nu este încă acoperită.',
        path,
      ),
    );
  parts.forEach((part, index) => {
    if (part.deduction === 'prorata' && !taxed(part))
      issues.push(
        block(
          'PRORATA',
          `Partea ${part.vat} nu are TVA de dedus pe bază de pro rata.`,
          input.allocations ? `allocations.${index}.deduction` : 'deduction',
        ),
      );
  });
  return provisional.fact.kind === 'percent'
    ? { issues, percent: provisional.fact.percent }
    : { issues };
}

/**
 * Whether an invoice falls under VAT on collection, and what to tell the reviewer about it. The
 * company's own system is read on the earlier of the issue date and the tax point: an invoice
 * issued before the supply stays in the system it was issued in (art. 282 alin. (7)). A sale
 * under the system defers its VAT unless the customer is affiliated (alin. (6) lit. d)); the
 * other exclusions of alin. (6) (reverse charge, exempt supplies, special regimes) are categories
 * this treatment refuses anyway. A purchase defers its deduction when the company applies the
 * system (art. 297 alin. (3)) or the supplier does (alin. (2)): by the invoice's mention or by
 * ANAF's register on the tax point, which governs even without the mention (norme pct. 67
 * alin. (6)).
 */
function cashVatOf(
  input: RecognitionInput,
  invoice: Invoice,
  loaded: Loaded,
  status: string | null,
  supplier: PartyStatus | undefined,
  advances: boolean[],
): { party: CashVatParty | undefined; issues: Issue[] } {
  const issues: Issue[] = [];
  const { body, direction } = invoice;
  const systemDate = date([body.issueDate, taxPointOf(body)].sort()[0]!);
  const own = profileAt(loaded, 'vat.cash', systemDate) === 'yes';
  if (own && status !== 'normal_vat')
    issues.push(
      block(
        'CASH_VAT_STATUS',
        'Profilul companiei indică TVA la încasare, dar nu și înregistrarea în scopuri de TVA: sistemul îl aplică doar persoanele înregistrate (art. 282 alin. (3^1) din Codul fiscal).',
      ),
    );
  const mention = body.vatOnCollection === true;
  let party: CashVatParty | undefined;
  if (direction === 'sale') {
    if (input.affiliated && !own)
      issues.push(
        block(
          'AFFILIATED',
          `Compania nu aplică TVA la încasare la ${systemDate}: beneficiarul afiliat nu schimbă exigibilitatea.`,
          'affiliated',
        ),
      );
    // Exempt supplies stay under the general rules (art. 282 alin. (6) lit. b)): an invoice
    // without taxed lines is not under the system.
    const taxed = body.taxes.some((tax) => tax.category === 'S');
    party = own && !input.affiliated && taxed ? 'own' : undefined;
    if (party && !mention)
      issues.push(
        warn(
          'CASH_VAT_MENTION',
          'Compania aplică TVA la încasare, iar factura nu are mențiunea „TVA la încasare” (art. 319 alin. (20) lit. p) din Codul fiscal, în comentariul BT-22): corectați factura.',
        ),
      );
    if (input.affiliated && own && mention)
      issues.push(
        warn(
          'CASH_VAT_MENTION',
          'Vânzarea către un beneficiar afiliat urmează regulile generale de exigibilitate (art. 282 alin. (6) lit. d) din Codul fiscal), dar factura are mențiunea „TVA la încasare”: corectați factura.',
        ),
      );
  } else {
    if (input.affiliated)
      issues.push(
        block(
          'AFFILIATED',
          'Beneficiarul afiliat (art. 282 alin. (6) lit. d) din Codul fiscal) se indică doar pentru o vânzare.',
          'affiliated',
        ),
      );
    const registered = supplier?.cashVat === true;
    if (mention && supplier && !registered)
      issues.push(
        warn(
          'CASH_VAT_SUPPLIER',
          `Factura are mențiunea „TVA la încasare”, dar furnizorul ${supplier.name} (CUI ${supplier.cui}) nu era în Registrul persoanelor care aplică sistemul TVA la încasare la ${supplier.date}: deducerea se amână după mențiune (art. 297 alin. (2) din Codul fiscal). Verificați registrul.`,
        ),
      );
    const supplierApplies = mention || registered;
    party = own
      ? supplierApplies
        ? 'own+supplier'
        : 'own'
      : supplierApplies
        ? 'supplier'
        : undefined;
  }
  if (party && body.currency !== LEDGER_CURRENCY)
    issues.push(
      block(
        'CASH_VAT_CURRENCY',
        'Facturile în valută în sistemul TVA la încasare nu sunt încă tratate.',
      ),
    );
  if (party && advances.some(Boolean))
    issues.push(
      block(
        'CASH_VAT_ADVANCE',
        'Avansurile facturate sau deduse în sistemul TVA la încasare nu sunt încă tratate.',
        input.allocations ? 'allocations' : 'account',
      ),
    );
  return { party, issues };
}

export const creditInput = z
  .object({
    documentId: z.uuid(),
    originalDocumentId: z.uuid(),
    /** The revenue or expense account the original invoice used, for every line. */
    account: z.string().regex(accountCodePattern).optional(),
    /** The original's deduction; `prorata` at the provisional pro-rata of the credit note's tax
     * point, in the original's year. */
    deduction: z.enum(['full', 'none', 'limited', 'prorata']).default('full'),
    /** Instead of `account`: each VAT category of the credit note split over the accounts the
     * original used, as positive amounts in lei, each part with the original's deduction. */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            vat: z.string().regex(/^(S-\d{1,2}(\.\d{1,2})?|O|E|K|G)$/),
            amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            deduction: z.enum(['full', 'none', 'limited', 'prorata']).default('full'),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  });
export type CreditInput = z.infer<typeof creditInput>;

/**
 * Recognizes a credit note (381, or a negative 380) against its original invoice: the original
 * accounts and VAT rates are reversed for the credited amounts in the credit note's own period,
 * and the original receivable or payable is reduced. Each VAT category of the credit note must be
 * one of the original's; a credit note on several categories splits them over accounts as the
 * original did. Crediting more than remains open is refused. An original under VAT on collection
 * has its deferral reduced first; what exceeds it adjusts the chargeable VAT on the credit note's
 * date, for the reviewer to confirm (art. 282 alin. (10), norme pct. 32 alin. (2) and (5)).
 */
export const creditRecognition: Treatment<CreditInput> = {
  id: 'invoices.credit',
  version: 1,
  description:
    'Notă de credit sau factură storno legată de factura inițială, cu cotele TVA ale acesteia.',
  input: creditInput,
  agent: true,
  summary:
    "Credit note or storno invoice linked to its original invoice, with the original's VAT rates.",
  toolset: 'inbox',
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId, input.originalDocumentId],
    openItems: [{ documentId: input.originalDocumentId, history: true }],
    profile: true,
  }),
  // The original's entries, for the VAT it still defers under VAT on collection.
  followUp(input, loaded) {
    const entries = [...loaded.openItems.values()]
      .filter((item) => item.documentId === input.originalDocumentId)
      .flatMap((item) => item.history ?? []);
    return entries.length ? { entries: [...new Set(entries)] } : null;
  },
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
    // The credit note's VAT is chargeable on its own date, the event's (art. 282 alin. (9)), even
    // if it repeats the original supply's date (BT-72); its rates are the original's, read on the
    // original's tax point.
    const taxPoint = date(credit.body.taxPointDate ?? credit.body.issueDate);
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const originalTaxPoint = taxPointOf(original.body);
    const originalVat = vatCategories(original, loaded, rules, originalTaxPoint);
    issues.push(...originalVat.issues);
    const originalKeys = originalVat.categories.map((item) => item.key);
    const categories = credit.body.taxes.map((tax) => ({
      key: categoryKey(tax.category, tax.rate),
      category: tax.category,
      rate: tax.rate,
      base: ron(tax.base),
      tax: ron(tax.tax),
    }));
    if (
      categories.some((item) => !originalKeys.includes(item.key)) ||
      new Set(categories.map((item) => item.key)).size !== categories.length
    )
      issues.push(
        block(
          'VAT_RATE',
          'Nota de credit păstrează categoriile și cotele TVA ale facturii inițiale.',
        ),
      );
    const parts = input.allocations ?? [
      ...categories.map((item) => ({
        account: input.account!,
        vat: item.key,
        amount: formatMoney(item.base, LEDGER_CURRENCY),
        deduction: input.deduction,
      })),
    ];
    if (input.allocations)
      for (const item of categories) {
        const allocated = input.allocations
          .filter((part) => part.vat === item.key)
          .reduce((sum, part) => sum + ron(part.amount), 0n);
        if (
          allocated !== item.base ||
          input.allocations.some((part) => !categories.some((c) => c.key === part.vat))
        )
          issues.push(
            block(
              'ALLOCATION',
              `Baza categoriei ${item.key} este ${formatMoney(item.base, LEDGER_CURRENCY)} lei; repartizarea însumează ${formatMoney(allocated, LEDGER_CURRENCY)}.`,
              'allocations',
            ),
          );
      }
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
    // An original under VAT on collection: what it still defers (art. 282 alin. (10)).
    const deferral = item ? deferredInvoice(item, loaded) : null;
    if (deferral && 'code' in deferral) issues.push(deferral);
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const deferring = deferral && !('code' in deferral) ? deferral : null;

    const purchase = credit.direction === 'purchase';
    const gross = ron(credit.body.totals.gross);
    const partyId = credit.record.partyId!;
    const partNet = parts.map((part) => ron(part.amount));
    // Each category's VAT split over its parts; a part reverses the deduction it had.
    const partTax = parts.map(() => 0n);
    for (const category of categories) {
      const members = parts.flatMap((part, p) => (part.vat === category.key ? [p] : []));
      share(
        category.tax,
        members.map((p) => partNet[p]!),
      ).forEach((value, i) => (partTax[members[i]!] = value));
    }
    const limited =
      purchase && parts.some((part) => part.deduction === 'limited')
        ? parseScaled(
            rules.param<string>(
              'ro.vat.deduction.limited',
              'vat_chargeability_date',
              originalTaxPoint,
            ),
            4,
          )
        : 0n;
    // A credit note on a purchase for both kinds of operations reverses its deduction at the
    // provisional pro-rata of its own tax point, in the original's year; across years the
    // definitive pro-rata of the original's year would apply, which is not covered.
    let percent = 0;
    if (purchase && parts.some((part) => part.deduction === 'prorata')) {
      const provisional = provisionalProrata(loaded.profile, taxPoint);
      if (taxPoint.slice(0, 4) !== originalTaxPoint.slice(0, 4))
        return {
          effect: null,
          issues: [
            block(
              'PRORATA_CREDIT_YEAR',
              `Nota de credit (${taxPoint}) ajustează o achiziție din ${originalTaxPoint.slice(0, 4)} dedusă pe bază de pro rata: regularizarea cu pro rata definitivă a acelui an nu este încă acoperită.`,
            ),
          ],
        };
      if (!provisional.found || provisional.fact.kind !== 'percent')
        return {
          effect: null,
          issues: [
            block(
              'PRORATA_MISSING',
              'Pro rata provizorie a anului nu este înregistrată (vat.prorata) sau nu este un procent.',
            ),
          ],
        };
      percent = provisional.fact.percent;
    }
    const deducted = parts.map((part, p) =>
      !purchase || part.deduction === 'none'
        ? 0n
        : part.deduction === 'full'
          ? partTax[p]!
          : part.deduction === 'prorata'
            ? prorataShare(partTax[p]!, percent)
            : divRound(partTax[p]! * limited, 1_000_000n, 'halfAwayFromZero'),
    );
    // The original's own tax entries, by key: an exempt category's code (its basis) is the
    // original's.
    const originalEntries = new Map(
      [...loaded.entries.values()]
        .flatMap((entry) => entry.taxEntries)
        .filter((entry) => entry.documentId === original.record.id)
        .map((entry) => [entry.key, entry]),
    );
    // Red storno: the original sides with negative amounts, so turnover stays correct.
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const partner: LineSpec = {
      account: purchase ? item!.controlAccount : '4111',
      side: purchase ? 'C' : 'D',
      bani: -gross,
      openItem: item!.id,
      partyId,
    };
    if (!purchase) lines.push(partner);
    parts.forEach((part, p) =>
      lines.push({
        account: part.account,
        side: purchase ? 'D' : 'C',
        bani: -(partNet[p]! + (purchase ? partTax[p]! - deducted[p]! : 0n)),
      }),
    );
    const cashVat: { code: string; deferred: string; chargeable: string }[] = [];
    for (const category of categories) {
      const exempt = isExemptCategory(category.category);
      if (category.tax === 0n && !exempt) continue;
      const members = parts.flatMap((part, p) => (part.vat === category.key ? [p] : []));
      const deductedTax = members.reduce((sum, p) => sum + deducted[p]!, 0n);
      const ledger = purchase ? deductedTax : category.tax;
      const originKey = originalKeys.length === 1 ? 'vat' : `vat:${category.key}`;
      const originCode = originalEntries.get(originKey)?.code;
      if (exempt && !originCode)
        return {
          effect: null,
          issues: [
            ...issues,
            block(
              'ORIGINAL_TAX_ENTRY',
              `Factura inițială nu are înregistrarea categoriei scutite ${category.key}.`,
              'originalDocumentId',
            ),
          ],
        };
      const code = exempt ? originCode! : category.category === 'S' ? `S-${category.rate}` : 'O';
      const mixed = members.filter((p) => parts[p]!.deduction === 'prorata');
      const mixedAttributes: Record<string, string> =
        purchase && mixed.length
          ? {
              prorata: String(percent),
              prorataTax: String(-mixed.reduce((sum, p) => sum + partTax[p]!, 0n)),
              prorataDeducted: String(-mixed.reduce((sum, p) => sum + deducted[p]!, 0n)),
            }
          : {};
      const key = categories.length === 1 ? 'vat' : `vat:${category.key}`;
      // Booked on `account` with the reduction `amounts` (positive), as a red storno.
      const book = (
        account: string,
        amounts: CashVatAmounts,
        extra: Partial<TaxEntrySpec> = {},
      ): TaxEntrySpec => {
        if (amounts.ledger !== 0n)
          lines.push({ account, side: purchase ? 'D' : 'C', bani: -amounts.ledger });
        const entry = vatEntry(
          credit,
          {
            baseBani: -amounts.base,
            taxBani: -amounts.tax,
            deductibleBani: -amounts.deductible,
            ledgerBani: -amounts.ledger,
            taxPoint,
            taxPeriod,
            ...(amounts.ledger !== 0n ? { line: lines.length - 1 } : {}),
            originTaxEntry: `${original.record.id}:${originKey}`,
            ...extra,
          },
          code,
        );
        return {
          ...entry,
          key,
          attributes: {
            ...entry.attributes,
            ...mixedAttributes,
            ...(exempt ? { category: category.category } : {}),
          },
        };
      };
      const reduction = {
        base: category.base,
        tax: category.tax,
        deductible: deductedTax,
        ledger,
      };
      const deferredCategory = deferring?.categories.find((item) => item.origin.code === code);
      if (!deferredCategory) {
        const entry = book(purchase ? '4426' : '4427', reduction);
        // A category of a deferred invoice that was not deferred still belongs to the invoice:
        // the credit note is a correction of it, not a settlement.
        taxEntries.push(
          deferring
            ? {
                ...entry,
                attributes: {
                  ...entry.attributes,
                  cashVat: deferring.categories[0]!.origin.attributes.cashVat!,
                  invoice: original.record.id,
                },
              }
            : entry,
        );
        continue;
      }
      // Under VAT on collection the credit note takes its VAT off the original's deferral
      // first; what exceeds it adjusts the VAT already chargeable (art. 282 alin. (10)).
      const split = creditSplit(deferredCategory, reduction, gross === deferring!.balance);
      const attributes = {
        cashVat: deferredCategory.origin.attributes.cashVat!,
        invoice: original.record.id,
      };
      const deferredEntry = book('4428', split.deferred, { exigibility: null });
      taxEntries.push({
        ...deferredEntry,
        attributes: { ...deferredEntry.attributes, ...attributes },
      });
      if (!isZeroAmounts(split.chargeable)) {
        const chargeable = book(purchase ? '4426' : '4427', split.chargeable);
        taxEntries.push({
          ...chargeable,
          key: `${key}:chargeable`,
          attributes: { ...chargeable.attributes, ...attributes },
        });
      }
      cashVat.push({
        code,
        deferred: formatMoney(split.deferred.tax, LEDGER_CURRENCY),
        chargeable: formatMoney(split.chargeable.tax, LEDGER_CURRENCY),
      });
      if (split.chargeable.tax !== 0n)
        issues.push(
          split.chargeable.tax > 0n
            ? warn(
                'CASH_VAT_CREDIT',
                `TVA a notei de credit pe cota ${code} depășește cu ${formatMoney(split.chargeable.tax, LEDGER_CURRENCY)} lei TVA neexigibilă rămasă a facturii ${original.body.number}: diferența reduce TVA ${purchase ? 'dedusă' : 'colectată'} la data notei (art. 282 alin. (10) lit. a) pct. 2 din Codul fiscal). Dacă ajustarea este pentru falimentul beneficiarului (art. 287 lit. d)), se anulează doar TVA neexigibilă: confirmați.`,
              )
            : warn(
                'CASH_VAT_CREDIT',
                `Nota de credit stinge factura ${original.body.number}, iar ${formatMoney(-split.chargeable.tax, LEDGER_CURRENCY)} lei din TVA neexigibilă pe cota ${code} nu sunt acoperiți de ea: devin ${purchase ? 'deductibili' : 'exigibili'} la data notei. Confirmați.`,
              ),
        );
    }
    if (purchase) lines.push(partner);
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
        details: {
          originalDocumentId: original.record.id,
          taxPoint,
          ...(cashVat.length
            ? { vatOnCollection: { categories: cashVat, clause: cashVatClauses.corrections } }
            : {}),
        },
      },
    };
    return { effect, issues };
  },
};
