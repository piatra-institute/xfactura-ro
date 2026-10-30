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

/** A document's tax point: its issue date unless it states another (BT-7). It is also the date
 * a purchase's supplier status is checked on. */
export const taxPointOf = (body: Pick<InvoiceDocument, 'issueDate' | 'taxPointDate'>) =>
  date(body.taxPointDate ?? body.issueDate);

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

export const recognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Every line on one account: revenue (70x) for a sale; expense (6xx) or fixed asset (20x,
     * 21x) for a purchase. */
    account: z.string().regex(accountCodePattern).optional(),
    /** Input VAT deduction for a purchase booked on one account; ignored for a sale. `limited`
     * deducts the register's share for vehicles not used only for the business (art. 298). */
    deduction: z.enum(['full', 'none', 'limited']).default('full'),
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
            deduction: z.enum(['full', 'none', 'limited']).default('full'),
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
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => {
    const advances = (input.allocations ?? []).flatMap((part) =>
      part.advance ? [part.advance] : [],
    );
    const leases = (input.allocations ?? []).flatMap((part) => (part.lease ? [part.lease] : []));
    return {
      documents: [input.documentId],
      profile: true,
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
    if (body.currency !== LEDGER_CURRENCY)
      plan.fx = [
        { currency: body.currency, until: date([body.issueDate, taxPointOf(body)].sort().at(-1)!) },
      ];
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
    const taxPoint = taxPointOf(body);
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const vat = vatCategories(invoice, loaded, rules, taxPoint);
    const amounts = amountsFor(invoice, loaded, rules, taxPoint);
    const issues = [...vat.issues, ...amounts.issues];
    const parts: {
      account: string;
      vat: string;
      amount: string;
      deduction: 'full' | 'none' | 'limited';
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
    const cash = cashVatOf(input, invoice, loaded, vat.status, supplier, isAdvance);
    issues.push(...cash.issues);
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
      if (categoryTax[c] === 0n) return;
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
        category.category === 'S' ? `S-${category.rate}` : 'O',
      );
      taxEntries.push({
        ...entry,
        key: categories.length === 1 ? 'vat' : `vat:${category.key}`,
        ...(cash.party
          ? {
              attributes: {
                ...entry.attributes,
                cashVat: cash.party,
                invoice: invoice.record.id,
              },
            }
          : {}),
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
    party = own && !input.affiliated ? 'own' : undefined;
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
    deduction: z.enum(['full', 'none', 'limited']).default('full'),
    /** Instead of `account`: each VAT category of the credit note split over the accounts the
     * original used, as positive amounts in lei, each part with the original's deduction. */
    allocations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            vat: z.string().regex(/^(S-\d{1,2}(\.\d{1,2})?|O)$/),
            amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            deduction: z.enum(['full', 'none', 'limited']).default('full'),
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
    const taxPoint = date(credit.body.taxPointDate ?? credit.body.issueDate);
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const originalTaxPoint = date(original.body.taxPointDate ?? original.body.issueDate);
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
    const deducted = parts.map((part, p) =>
      !purchase || part.deduction === 'none'
        ? 0n
        : part.deduction === 'full'
          ? partTax[p]!
          : divRound(partTax[p]! * limited, 1_000_000n, 'halfAwayFromZero'),
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
      if (category.tax === 0n) continue;
      const members = parts.flatMap((part, p) => (part.vat === category.key ? [p] : []));
      const deductedTax = members.reduce((sum, p) => sum + deducted[p]!, 0n);
      const ledger = purchase ? deductedTax : category.tax;
      const originKey = originalKeys.length === 1 ? 'vat' : `vat:${category.key}`;
      const code = category.category === 'S' ? `S-${category.rate}` : 'O';
      const key = categories.length === 1 ? 'vat' : `vat:${category.key}`;
      // Booked on `account` with the reduction `amounts` (positive), as a red storno.
      const book = (
        account: string,
        amounts: CashVatAmounts,
        extra: Partial<TaxEntrySpec> = {},
      ): TaxEntrySpec => {
        if (amounts.ledger !== 0n)
          lines.push({ account, side: purchase ? 'D' : 'C', bani: -amounts.ledger });
        return {
          ...vatEntry(
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
          ),
          key,
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
