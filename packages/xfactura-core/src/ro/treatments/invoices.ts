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
  type OpenItemSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  allocate,
  convertMinor,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
} from '../../money';
import { selectRate } from '../fx';
import { RuleGapError, type RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';

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
    if (tax.rate !== rate) {
      let reduced: string | null = null;
      try {
        reduced = rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', taxPoint);
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
      }
      // The reduced rate applies only to the supplies of art. 291 alin. (2): the reviewer confirms.
      issues.push(
        tax.rate === reduced
          ? warn(
              'REDUCED_RATE',
              `Cota redusă de ${reduced}% se aplică doar livrărilor și prestărilor de la art. 291 alin. (2) din Codul fiscal: confirmați că operațiunea se încadrează.`,
            )
          : block(
              'VAT_RATE',
              `Cota din document (${tax.rate}%) diferă de cotele în vigoare (${rate}%${reduced ? `, ${reduced}%` : ''}).`,
            ),
      );
    }
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

/** An allocated amount: negative only for an advance deducted by the final invoice. */
const amountPattern = /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

export const recognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Every line on one account: revenue (70x) for a sale; expense (6xx) or fixed asset (20x,
     * 21x) for a purchase. */
    account: z.string().regex(accountCodePattern).optional(),
    /** Input VAT deduction for a purchase booked on one account; ignored for a sale. */
    deduction: z.enum(['full', 'none']).default('full'),
    /**
     * Instead of `account`: each VAT category's taxable amount (BT-116) split over accounts, in
     * the document's currency. A category is `S-<rate>` or `O`, and its parts add up to its
     * amount; allowances and charges are inside it. An advance invoice puts its part on 419
     * (4091, 4092 for a purchase); the final invoice's negative line deducting it goes there too,
     * naming the advance it settles.
     */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            vat: z.string().regex(/^(S-\d{1,2}(\.\d{1,2})?|O)$/),
            amount: z.string().regex(amountPattern),
            /** Input VAT deduction of this part, for a purchase. */
            deduction: z.enum(['full', 'none']).default('full'),
            /** The advance (its open item) a negative part on 419, 4091 or 4092 settles. */
            advance: z.uuid().optional(),
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
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
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
    issues.push(
      block('DETERMINATION_MISSING', 'Înregistrați regimul TVA al companiei pentru această dată.'),
    );
  const categories = body.taxes.map((tax) => ({
    key: categoryKey(tax.category, tax.rate),
    category: tax.category,
    rate: tax.rate,
    base: tax.base,
    tax: tax.tax,
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
    } else if (tax.category !== 'O' || ron(tax.tax) !== 0n)
      issues.push(
        block('TAX_CATEGORY', `Categoria TVA ${tax.category} cere un tratament separat.`),
      );
    if (invoice.direction === 'sale') {
      if (status === 'normal_vat' && tax.category !== 'S')
        issues.push(
          block('TAX_CATEGORY', 'Un plătitor de TVA facturează această operațiune cu TVA.'),
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
 * with its own deduction: one tax entry per category, one line per part.
 */
export const invoiceRecognition: Treatment<RecognitionInput> = {
  id: 'invoices.recognize',
  version: 1,
  description:
    'Factură internă: venit, cheltuială sau imobilizare pe unul sau mai multe conturi, TVA pe cote și creanța sau datoria față de partener.',
  input: recognitionInput,
  agent: true,
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => {
    const advances = (input.allocations ?? []).flatMap((part) =>
      part.advance ? [part.advance] : [],
    );
    return {
      documents: [input.documentId],
      profile: true,
      ...(advances.length ? { openItems: [{ ids: advances }] } : {}),
    };
  },
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
    const vat = vatCategories(invoice, loaded, rules, taxPoint);
    const amounts = amountsFor(invoice, loaded, rules, taxPoint);
    const issues = [...vat.issues, ...amounts.issues];
    const parts: {
      account: string;
      vat: string;
      amount: string;
      deduction: 'full' | 'none';
      advance?: string;
    }[] = input.allocations ?? [
      ...vat.categories.map((item) => ({
        account: input.account!,
        vat: item.key,
        amount: item.base,
        deduction: input.deduction,
      })),
    ];
    // Advances: received from customers on 419, paid to suppliers on 4091 (stocks) or 4092
    // (services), each an open item of the partner.
    const advanceAccount = direction === 'sale' ? /^419$/ : /^409[12]$/;
    const advanceKind = direction === 'sale' ? 'advance.received' : 'advance.paid';
    const isAdvance = parts.map((part) => advanceAccount.test(part.account));
    const negative = parts.map((part) => part.amount.startsWith('-'));
    parts.forEach((part, index) => {
      const path = input.allocations ? `allocations.${index}` : 'account';
      if (
        !isAdvance[index] &&
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
        parts.some((part) => part.vat === item.key && part.deduction === 'none')
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
    if (
      direction === 'purchase' &&
      vat.status === 'non_vat' &&
      parts.some(
        (part) =>
          part.deduction === 'full' &&
          vat.categories.find((item) => item.key === part.vat)?.category === 'S',
      )
    )
      issues.push(
        block(
          'DEDUCTION',
          'Un neplătitor de TVA nu deduce TVA.',
          input.allocations ? 'allocations' : 'deduction',
        ),
      );
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
      // Suppliers of fixed assets are held on 404, other suppliers on 401.
      controlAccount: direction === 'sale' ? '4111' : assets ? '404' : '401',
      partyId,
      currency: fx?.code ?? LEDGER_CURRENCY,
      normalSide: direction === 'sale' ? ('D' as const) : ('C' as const),
      mayReverse: false,
      documentId: invoice.record.id,
    };
    const deductible = parts.map((part) => direction === 'purchase' && part.deduction === 'full');
    if (direction === 'sale')
      lines.push(
        line({ account: '4111', side: 'D', bani: gross, openItem: item.ref, partyId }, fx?.gross),
      );
    const advanceItems: OpenItemSpec[] = [];
    parts.forEach((part, p) => {
      const kept = direction === 'purchase' && !deductible[p];
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
      lines.push(
        line(
          {
            account: part.account,
            side: direction === 'sale' ? 'C' : 'D',
            bani: partNet[p]! + (kept ? partTax[p]! : 0n),
            ...advance,
          },
          partMinor[p]! + (kept ? partTaxMinor[p]! : 0n),
        ),
      );
    });
    categories.forEach((category, c) => {
      if (categoryTax[c] === 0n) return;
      const members = parts.flatMap((part, p) => (part.vat === category.key ? [p] : []));
      const deducted = members.reduce((sum, p) => sum + (deductible[p] ? partTax[p]! : 0n), 0n);
      const deductedMinor = members.reduce(
        (sum, p) => sum + (deductible[p] ? partTaxMinor[p]! : 0n),
        0n,
      );
      const ledger = direction === 'sale' ? categoryTax[c]! : deducted;
      if (ledger !== 0n)
        lines.push(
          line(
            {
              account: direction === 'sale' ? '4427' : '4426',
              side: direction === 'sale' ? 'C' : 'D',
              bani: ledger,
            },
            direction === 'sale' ? category.minorTax : deductedMinor,
            fx?.vat,
          ),
        );
      taxEntries.push({
        ...vatEntry(
          invoice,
          {
            baseBani: categoryBase[c]!,
            taxBani: categoryTax[c]!,
            deductibleBani: direction === 'sale' ? 0n : deducted,
            ledgerBani: ledger,
            ...(ledger !== 0n ? { line: lines.length - 1 } : {}),
            taxPoint,
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
          category.category === 'S' ? `S-${category.rate}` : 'O',
        ),
        key: categories.length === 1 ? 'vat' : `vat:${category.key}`,
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
          ...(categories.length === 1
            ? { category: categories[0]!.category, rate: categories[0]!.rate }
            : { categories: categories.map((category) => category.key) }),
          deduction: direction === 'purchase' && !input.allocations ? input.deduction : null,
          ...(input.allocations
            ? {
                allocations: parts.map(
                  (part) =>
                    `${part.account} ${part.vat} ${part.amount}${direction === 'purchase' ? ` ${part.deduction}` : ''}`,
                ),
              }
            : {}),
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
      lines.push({
        account: item!.controlAccount,
        side: 'C',
        bani: -gross,
        openItem: item!.id,
        partyId,
      });
    } else {
      lines.push({ account: input.account, side: 'D', bani: -gross });
      lines.push({
        account: item!.controlAccount,
        side: 'C',
        bani: -gross,
        openItem: item!.id,
        partyId,
      });
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
