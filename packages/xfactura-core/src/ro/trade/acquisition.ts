import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Evaluation,
  type FxRate,
  type Issue,
  type JsonValue,
  type LineSpec,
  type OpenItemSpec,
  type ReadPlan,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import {
  convertMinor,
  divRound,
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { selectRate } from '../fx';
import { euVatPrefixes } from '../geo';
import { invoiceStockInput, invoiceStockQuery } from '../stock/invoices';
import { invoiceKinds } from '../treatments/invoices';
import { tradeArrangements, tradeCodes } from './codes';
import { bookGoods, goodsParts } from './goods';
import type { AcquisitionRule } from './parameters';
import { fifteenthAfter, supplyDateOf, unsupportedArrangement } from './supply';

/*
 * An intra-community acquisition of goods (Codul fiscal art. 268 alin. (3) lit. a), 273, 276 alin.
 * (1)): goods bought from a business registered for VAT in another Member State, transported to
 * Romania. The company self-assesses the VAT (art. 307 alin. (1) read with art. 326 alin. (2)):
 * collected on 4427 and deducted on 4426 in the same return (D300 rd. 5 and 5.1, 20 and 20.1;
 * OMFP nr. 1.802/2014, the function of 4426: "4427 în cazul în care se aplică taxare inversă"),
 * declared in D390 as type A. The tax point is the supplier's invoice, or the 15th of the month
 * after the supply when none was issued by then (art. 284 alin. (2)); the rate is the one in force
 * at the chargeable event (art. 291), the exchange rate the BNR's at the tax point (art. 290 alin.
 * (2)). The goods enter the stock register (the NIR) at the invoice's price, with the transport
 * the supplier invoiced on the same invoice (its charges, OMFP nr. 1.802/2014 pct. 8 pct. 6).
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});

export const euAcquisitionInput = z
  .object({
    documentId: z.uuid(),
    /** One account for the goods: a stock account (with `stock`), an expense or a fixed asset. */
    account: z.string().regex(accountCodePattern).optional(),
    /** Or the invoice's net split over accounts, in its currency. */
    allocations: goodsParts.optional(),
    arrangement: z.enum(tradeArrangements),
    /** The date the goods were dispatched (the chargeable event), when the invoice does not
     * state it (BT-72): from the CMR or the delivery note. */
    supplyDate: day.optional(),
    /** The rate the goods are taxed at in Romania: standard, or reduced for the supplies of art.
     * 291 alin. (2) (`reducedRateBasis`), which the reviewer confirms. */
    rate: z.enum(['standard', 'reduced']),
    reducedRateBasis: z.string().trim().min(3).max(300).optional(),
    /** Whether the self-assessed VAT is deducted (art. 297–298): `none` puts it in the cost. */
    deduction: z.enum(['full', 'none']),
    stock: invoiceStockInput.optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  });
export type EuAcquisitionInput = z.infer<typeof euAcquisitionInput>;

export const euAcquisitionRecognition: Treatment<EuAcquisitionInput> = {
  id: 'goods.euAcquisition',
  version: 1,
  description:
    'Achiziție intracomunitară de bunuri (art. 268 alin. (3) lit. a)): bunurile în gestiune sau pe cheltuieli, TVA autolichidată 4426 = 4427 la exigibilitatea art. 284 (D300 rd. 5 și 20, D390 A).',
  input: euAcquisitionInput,
  agent: true,
  summary:
    'An intra-community acquisition of goods: the goods into stock (the NIR) or expense, the VAT self-assessed 4426 = 4427 at the art. 284 tax point; D300 rd. 5/5.1 and 20/20.1, D390 A.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input): ReadPlan => ({
    documents: [input.documentId],
    profile: true,
    ...(input.stock ? { stock: invoiceStockQuery(input.stock) } : {}),
  }),
  followUp(input, loaded) {
    const parsed = invoiceDocumentSchema.safeParse(loaded.documents.get(input.documentId)?.body);
    if (!parsed.success || parsed.data.currency === LEDGER_CURRENCY) return null;
    // The rate of the issue date and of the tax point, at most the 15th of the next month: each
    // read up to its own date, since a read keeps only the latest rates before it (a month of
    // daily rates after the issue date would leave the issue date's out).
    const supplied = parsed.data.deliveryDate ?? input.supplyDate ?? parsed.data.issueDate;
    const until = [parsed.data.issueDate, fifteenthAfter(supplied as LocalDate, 15)].sort().at(-1)!;
    return {
      fx: [
        { currency: parsed.data.currency, until: parsed.data.issueDate as LocalDate },
        { currency: parsed.data.currency, until: until as LocalDate },
      ],
    };
  },
  evaluate(input, loaded, rules): Evaluation {
    const record = loaded.documents.get(input.documentId);
    if (!record || record.kind !== invoiceKinds.purchase)
      return {
        effect: null,
        issues: [
          block(
            'DOCUMENT_KIND',
            'Se recunoaște aici o factură primită (nu o notă de credit) pentru o achiziție intracomunitară de bunuri.',
            'documentId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const issues: Issue[] = [];
    const arrangement = unsupportedArrangement(input.arrangement);
    if (arrangement) issues.push(arrangement);
    const supplier = body.supplier;
    const prefix = euVatPrefixes[supplier.country];
    const code = supplier.taxId.toUpperCase().replace(/\s+/g, '');
    if (!prefix || supplier.country === 'RO')
      issues.push(
        block(
          'NOT_EU_SUPPLIER',
          `Furnizorul din ${supplier.country} nu este dintr-un alt stat membru: un import se înregistrează cu goods.import, o achiziție internă cu invoices.recognize.`,
        ),
      );
    else if (!code.startsWith(prefix) || !/\d/.test(code.slice(prefix.length)))
      issues.push(
        block(
          'SUPPLIER_VAT_ID',
          `Furnizorul ${supplier.name} nu înscrie un cod de TVA din ${supplier.country} (${prefix}…): achiziția intracomunitară cere livrarea unei persoane înregistrate în statul de plecare (art. 268 alin. (3) lit. a)), pe care o declară D390.`,
        ),
      );
    if (body.taxes.some((tax) => parseMoney(tax.tax, body.currency) !== 0n))
      issues.push(
        block(
          'VAT_CHARGED',
          'Factura conține TVA a altui stat membru: livrarea nu este scutită în statul de plecare (cumpărătorul nu a comunicat codul de TVA din România?). Cereți o factură fără TVA, cu codul RO al firmei.',
        ),
      );
    if (!isSupportedCurrency(body.currency))
      issues.push(block('CURRENCY', `Moneda ${body.currency} nu este acceptată.`));
    const supplied = supplyDateOf(body, input.supplyDate);
    if ('code' in supplied) return { effect: null, issues: [...issues, supplied] };
    const status = profileAt(loaded, 'vat.status', supplied.date);
    if (!status)
      issues.push(
        questionIssue(
          'DETERMINATION_MISSING',
          'Înregistrați regimul TVA al companiei pentru această dată.',
          {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: 'vat.status' },
            params: { axis: 'vat.status', from: supplied.date },
          },
        ),
      );
    else if (status !== 'normal_vat')
      issues.push(
        block(
          'EU_GOODS_NON_PAYER',
          'Achizițiile intracomunitare de bunuri ale unei firme neînregistrate în scopuri de TVA (plafonul de 10.000 euro al art. 268 alin. (4)–(7), codul art. 317 și decontul special D301) nu sunt acoperite.',
        ),
      );
    let rule: AcquisitionRule;
    let rate: string;
    try {
      rule = rules.param<AcquisitionRule>(
        'ro.vat.intra_eu.acquisition',
        'vat_chargeability_date',
        supplied.date,
      );
      const standard = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', supplied.date, {
        category: 'S',
      });
      rate =
        input.rate === 'standard'
          ? standard
          : rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', supplied.date);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }
    if (input.rate === 'reduced')
      issues.push(
        input.reducedRateBasis
          ? ack(
              'REDUCED_RATE',
              `Cota redusă de ${rate}% se aplică numai bunurilor de la art. 291 alin. (2): ${input.reducedRateBasis}.`,
            )
          : block(
              'REDUCED_RATE_BASIS',
              'Cota redusă cere bunurile de la art. 291 alin. (2) cărora li se aplică (reducedRateBasis).',
              'reducedRateBasis',
            ),
      );
    // Art. 284 alin. (2): the supplier's invoice, or the 15th of the month after the supply.
    const due = fifteenthAfter(supplied.date, rule.exigibilityDay);
    const exigibility = (body.issueDate <= due ? body.issueDate : due) as LocalDate;
    if (body.issueDate > due)
      issues.push(
        ack(
          'INVOICE_LATE',
          `Factura furnizorului este emisă la ${body.issueDate}, după ${due}: TVA achiziției devine exigibilă la ${due} (art. 284 alin. (2)) și se declară în perioada acelei date (D300 rd. 5, D390), nu în cea a facturii.`,
          { clauses: [`${CODE}:art.284(1)-(2)`] },
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // Amounts in lei: the goods at the accounting rate of the issue date; the VAT base at the
    // BNR rate valid at the tax point (art. 290 alin. (2)).
    const foreign = body.currency !== LEDGER_CURRENCY;
    const netMinor = parseMoney(body.totals.net, body.currency);
    let accounting: FxRate | undefined;
    let vatRate: FxRate | undefined;
    if (foreign) {
      const a = selectRate(loaded, rules, body.currency, body.issueDate as LocalDate, 'accounting');
      const v = selectRate(loaded, rules, body.currency, exigibility, 'vat');
      if ('code' in a) issues.push(a);
      else accounting = a;
      if ('code' in v) issues.push(v);
      else vatRate = v;
      if (!accounting || !vatRate) return { effect: null, issues };
    }
    const toLei = (quote?: FxRate) =>
      quote
        ? convertMinor(netMinor, body.currency, { rate: quote.rate, multiplier: quote.multiplier })
        : netMinor;
    const net = toLei(accounting);
    const base = toLei(vatRate);
    const tax = divRound(base * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
    const deducted = input.deduction === 'full' ? tax : 0n;
    const partyId = record.partyId ?? undefined;
    const goods = bookGoods({
      body,
      ...(input.account ? { account: input.account } : {}),
      ...(input.allocations ? { allocations: input.allocations } : {}),
      ...(input.stock ? { stock: input.stock } : {}),
      net,
      cost: tax - deducted,
      loaded,
      rules,
      date: body.issueDate as LocalDate,
      partyId: partyId ?? '',
      documentId: record.id,
      memo: `Achiziție intracomunitară ${body.number}`,
    });
    issues.push(...goods.issues);
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const lines: LineSpec[] = goods.lines;
    const currency = (quote: FxRate | undefined, minor: bigint) =>
      quote ? { currency: { code: body.currency, minor, rateId: quote.id, rate: quote.rate } } : {};
    const item: OpenItemSpec = {
      ref: 'counterparty',
      kind: 'payable',
      controlAccount: '401',
      partyId: partyId!,
      currency: body.currency,
      normalSide: 'C',
      mayReverse: false,
      documentId: record.id,
    };
    lines.push({
      account: '401',
      side: 'C',
      bani: net,
      openItem: item.ref,
      partyId,
      ...currency(accounting, netMinor),
    });
    const taxPeriod = vatPeriodOf(loaded, exigibility);
    const taxCode = tradeCodes.acquisition(rate);
    const entry = (direction: 'output' | 'input', fields: Partial<TaxEntrySpec>): TaxEntrySpec => ({
      key: `vat.${direction}`,
      tax: 'VAT',
      code: taxCode,
      direction,
      baseBani: base,
      taxBani: tax,
      deductibleBani: 0n,
      ledgerBani: 0n,
      taxPoint: exigibility,
      exigibility,
      taxPeriod,
      documentId: record.id,
      ...(partyId ? { partyId } : {}),
      ...(vatRate
        ? {
            currency: {
              code: body.currency,
              baseMinor: netMinor,
              taxMinor: 0n,
              rateId: vatRate.id,
              rate: vatRate.rate,
            },
          }
        : {}),
      attributes: {
        number: body.number,
        counterpartyTaxId: code,
        counterpartyCountry: supplier.country,
        supplied: supplied.date,
        rate,
        arrangement: input.arrangement,
        goods: 'intra_eu',
      },
      ...fields,
    });
    lines.push({ account: '4427', side: 'C', bani: tax });
    const taxEntries: TaxEntrySpec[] = [
      entry('output', { ledgerBani: tax, line: lines.length - 1 }),
    ];
    if (deducted) {
      lines.push({ account: '4426', side: 'D', bani: tax });
      taxEntries.push(
        entry('input', { deductibleBani: tax, ledgerBani: tax, line: lines.length - 1 }),
      );
    } else taxEntries.push(entry('input', {}));
    const effect: Effect = {
      schema: 'effect@1',
      date: body.issueDate as LocalDate,
      journalClass: 'general',
      journalCode: 'CUMPARARI',
      description: `Achiziție intracomunitară ${body.number} (${supplier.country})`,
      lines,
      openItems: [item, ...(goods.stock?.openItems ?? [])],
      taxEntries,
      schedules: [],
      ...(goods.stock?.book ? goods.stock.book.effectPart() : {}),
      explanation: {
        summary: `Achiziție intracomunitară ${body.number} de la ${supplier.name} (${code}): TVA ${formatMoney(tax, LEDGER_CURRENCY)} lei la ${rate}%, exigibilă la ${exigibility} (art. 284), D300 rd. 5 și 20, D390 A pentru ${exigibility.slice(0, 7)}.`,
        details: {
          supplied: supplied.date,
          exigibility,
          rate,
          base: formatMoney(base, LEDGER_CURRENCY),
          tax: formatMoney(tax, LEDGER_CURRENCY),
          deduction: input.deduction,
          ...(goods.stock ? { stock: goods.stock.details } : {}),
          clauses: [
            `${CODE}:art.268(3)-(4)`,
            `${CODE}:art.284(1)-(2)`,
            `${CODE}:art.290(2)`,
            `${CODE}:art.326(2)-(5)`,
            'OPANAF174/2026:rd.5-6',
            'OPANAF174/2026:rd.20-22',
          ],
        },
      },
    };
    return { effect, issues };
  },
};
