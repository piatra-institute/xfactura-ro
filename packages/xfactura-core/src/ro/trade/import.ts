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
  formatMoney,
  isSupportedCurrency,
  LEDGER_CURRENCY,
  parseMoney,
} from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError } from '../../rules';
import type { LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { selectRate } from '../fx';
import { euVatPrefixes } from '../geo';
import { invoiceStockInput, invoiceStockQuery } from '../stock/invoices';
import { invoiceKinds } from '../treatments/invoices';
import { tradeCodes } from './codes';
import { customsDeclarationSchema, customsDocumentKind } from './documents';
import { bookGoods, goodsParts } from './goods';
import type { ImportRule } from './parameters';

/*
 * An import of goods from outside the Union (Codul fiscal art. 268 alin. (2), 277): the
 * supplier's invoice, usually in a currency, and the customs declaration of import (DVI) that
 * states the customs value, the duties and the import VAT (art. 289). One entry books both, on
 * the declaration's acceptance (the chargeable event and the tax point, art. 285): the goods at
 * the invoice's price, the duties capitalized into their cost (OMFP nr. 1.802/2014, the function
 * of 446 and pct. 8 pct. 6), and the import VAT paid at customs (Dr 4426 / Cr the customs debt,
 * D300 rd. 24–25) or, under the deferral certificate of art. 326 alin. (4) lit. a), self-assessed
 * in the return (Dr 4426 / Cr 4427, D300 rd. 7 and 22). The deduction needs the declaration with
 * the company as importer (art. 299 alin. (1) lit. c)–d)).
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
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

export const importInput = z
  .object({
    /** The supplier's invoice (from outside the Union). */
    documentId: z.uuid(),
    /** The customs declaration of import (`customs.declaration`, procedure import). */
    declarationId: z.uuid(),
    account: z.string().regex(accountCodePattern).optional(),
    allocations: goodsParts.optional(),
    /** Whether the import VAT is deducted (art. 297–299): `none` puts it in the cost. */
    deduction: z.enum(['full', 'none']),
    /** The customs authority the duties and the VAT paid at customs are owed to. */
    authorityId: z.uuid(),
    /** For VAT not paid at customs: the deferral certificate (art. 326 alin. (4) lit. a)). */
    certificateEvidenceId: z.uuid().optional(),
    stock: invoiceStockInput.optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul, fie repartizarea pe conturi (allocations).',
  });
export type ImportInput = z.infer<typeof importInput>;

const bani = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const sameNumber = (a: string, b: string) =>
  a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();

export const importRecognition: Treatment<ImportInput> = {
  id: 'goods.import',
  version: 1,
  description:
    'Import de bunuri: factura furnizorului din afara Uniunii și declarația vamală de import (DVI), cu taxele vamale în costul bunurilor și TVA plătită în vamă (D300 rd. 24–25) sau amânată prin certificat (art. 326 alin. (4), rd. 7 și 22).',
  input: importInput,
  agent: true,
  summary:
    "An import of goods: the supplier's invoice and the customs declaration (DVI), duties capitalized into the goods' cost, import VAT paid at customs (D300 rd. 24–25) or deferred (art. 326(4), rd. 7/22).",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input): ReadPlan => ({
    documents: [input.documentId, input.declarationId],
    parties: [input.authorityId],
    profile: true,
    ...(input.certificateEvidenceId ? { evidence: [input.certificateEvidenceId] } : {}),
    ...(input.stock ? { stock: invoiceStockQuery(input.stock) } : {}),
  }),
  followUp(input, loaded) {
    const parsed = invoiceDocumentSchema.safeParse(loaded.documents.get(input.documentId)?.body);
    if (!parsed.success || parsed.data.currency === LEDGER_CURRENCY) return null;
    return { fx: [{ currency: parsed.data.currency, until: parsed.data.issueDate as LocalDate }] };
  },
  evaluate(input, loaded, rules): Evaluation {
    const record = loaded.documents.get(input.documentId);
    if (!record || record.kind !== invoiceKinds.purchase)
      return {
        effect: null,
        issues: [
          block(
            'DOCUMENT_KIND',
            'Se recunoaște aici factura primită a furnizorului din afara Uniunii.',
            'documentId',
          ),
        ],
      };
    const found = loaded.documents.get(input.declarationId);
    if (!found || found.kind !== customsDocumentKind)
      return {
        effect: null,
        issues: [
          block(
            'DECLARATION',
            'Indicați declarația vamală de import (un document customs.declaration).',
            'declarationId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const declaration = customsDeclarationSchema.parse(found.body);
    const issues: Issue[] = [];
    const supplier = body.supplier;
    if (supplier.country === 'RO' || euVatPrefixes[supplier.country])
      issues.push(
        block(
          'NOT_IMPORT',
          `Furnizorul este din ${supplier.country}, în Uniunea Europeană: bunurile se înregistrează ca achiziție intracomunitară (goods.euAcquisition) sau internă.`,
        ),
      );
    if (declaration.procedure !== 'import' || !declaration.vatPayment)
      issues.push(
        block('DECLARATION_PROCEDURE', 'Declarația vamală nu este de import.', 'declarationId'),
      );
    const listed = declaration.invoices.find((item) => sameNumber(item.number, body.number));
    if (!listed)
      issues.push(
        block(
          'DECLARATION_INVOICE',
          `Declarația vamală ${declaration.mrn} nu cuprinde factura ${body.number}: o declarație pentru mai multe facturi sau o factură în mai multe declarații nu este acoperită.`,
          'declarationId',
        ),
      );
    else if (
      declaration.invoices.length > 1 ||
      listed.currency !== body.currency ||
      listed.amount !== body.totals.payable
    )
      issues.push(
        block(
          'DECLARATION_INVOICE',
          `Declarația vamală ${declaration.mrn} înscrie ${declaration.invoices.map((item) => `${item.number} ${item.amount} ${item.currency}`).join(', ')}; factura are ${body.totals.payable} ${body.currency}: se acoperă o declarație pentru exact această factură.`,
          'declarationId',
        ),
      );
    if (body.taxes.some((tax) => parseMoney(tax.tax, body.currency) !== 0n))
      issues.push(
        block(
          'VAT_CHARGED',
          'Factura furnizorului din afara Uniunii conține TVA: TVA de import se stabilește prin declarația vamală.',
        ),
      );
    if (!isSupportedCurrency(body.currency))
      issues.push(block('CURRENCY', `Moneda ${body.currency} nu este acceptată.`));
    const authority = loaded.parties.get(input.authorityId);
    if (authority?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Indicați autoritatea vamală (instituție publică) căreia i se datorează taxele vamale și TVA din vamă.',
          'authorityId',
        ),
      );
    const taxPoint = declaration.acceptedOn as LocalDate;
    const status = profileAt(loaded, 'vat.status', taxPoint);
    if (!status)
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
    else if (status !== 'normal_vat')
      issues.push(
        block(
          'IMPORT_NON_PAYER',
          'Importurile unei firme neînregistrate în scopuri de TVA (TVA plătită în vamă, nedeductibilă) nu sunt încă acoperite.',
        ),
      );
    let rule: ImportRule;
    let rates: string[];
    try {
      rule = rules.param<ImportRule>('ro.vat.import', 'vat_chargeability_date', taxPoint);
      rates = [
        rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, { category: 'S' }),
        rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', taxPoint),
      ];
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }
    const lineRates = [...new Set(declaration.lines.map((line) => line.vatRate ?? ''))];
    if (lineRates.length !== 1 || !rates.some((item) => Number(item) === Number(lineRates[0])))
      issues.push(
        block(
          'IMPORT_RATE',
          `Declarația aplică ${lineRates.join(', ')}%: se acoperă o singură cotă, în vigoare la ${taxPoint} (${rates.join('%, ')}%).`,
        ),
      );
    else if (Number(lineRates[0]) !== Number(rates[0]))
      issues.push(
        ack(
          'REDUCED_RATE',
          `Declarația aplică cota redusă de ${lineRates[0]}%: confirmați că bunurile sunt dintre cele de la art. 291 alin. (2).`,
        ),
      );
    const deferred = declaration.vatPayment?.mode === 'deferred';
    if (deferred && !input.certificateEvidenceId)
      issues.push(
        block(
          'DEFERRAL_CERTIFICATE',
          `TVA nu s-a plătit în vamă (certificatul ${declaration.vatPayment?.mode === 'deferred' ? declaration.vatPayment.certificate : ''}): atașați certificatul de amânare de la plata în vamă (art. 326 alin. (4) lit. a)).`,
          'certificateEvidenceId',
        ),
      );
    if (!deferred && input.certificateEvidenceId)
      issues.push(
        block(
          'DEFERRAL_CERTIFICATE',
          'Declarația arată TVA plătită în vamă: certificatul de amânare nu se aplică.',
          'certificateEvidenceId',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const rate = lineRates[0]!;

    // The goods at the invoice's price in lei, at the issue date's BNR rate or the declaration's
    // customs rate, as `ro.vat.import` reads it.
    const foreign = body.currency !== LEDGER_CURRENCY;
    const netMinor = parseMoney(body.totals.net, body.currency);
    let quote: FxRate | undefined;
    if (foreign) {
      if (rule.invoiceRate === 'customs') {
        if (!declaration.exchangeRate)
          return {
            effect: null,
            issues: [
              ...issues,
              block('CUSTOMS_RATE', 'Declarația vamală nu înscrie cursul de schimb aplicat.'),
            ],
          };
        quote = {
          id: `customs:${declaration.mrn}`,
          source: 'customs',
          currency: body.currency,
          date: taxPoint,
          rate: declaration.exchangeRate,
          multiplier: 1,
        } as FxRate;
      } else {
        const selected = selectRate(
          loaded,
          rules,
          body.currency,
          body.issueDate as LocalDate,
          'accounting',
        );
        if ('code' in selected) return { effect: null, issues: [...issues, selected] };
        quote = selected;
      }
    }
    const net = quote
      ? convertMinor(netMinor, body.currency, { rate: quote.rate, multiplier: quote.multiplier })
      : netMinor;
    const duty = bani(declaration.totals.duty) + bani(declaration.totals.otherTaxes);
    const vat = bani(declaration.totals.vat);
    const base = bani(declaration.totals.vatBase);
    const deducted = input.deduction === 'full' ? vat : 0n;
    const partyId = record.partyId ?? undefined;
    const goods = bookGoods({
      body,
      ...(input.account ? { account: input.account } : {}),
      ...(input.allocations ? { allocations: input.allocations } : {}),
      ...(input.stock ? { stock: input.stock } : {}),
      net,
      cost: duty + (vat - deducted),
      loaded,
      rules,
      date: taxPoint,
      partyId: partyId ?? '',
      documentId: record.id,
      memo: `Import ${body.number}, DVI ${declaration.mrn}`,
    });
    issues.push(...goods.issues);
    if (duty)
      issues.push(
        ack(
          'IMPORT_DUTY_COST',
          `Taxele vamale (${formatMoney(duty, LEDGER_CURRENCY)} lei) intră în costul bunurilor (OMFP nr. 1.802/2014, funcțiunea contului 446), repartizate proporțional cu valoarea lor: confirmați.`,
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const lines: LineSpec[] = goods.lines;
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
      ...(quote
        ? { currency: { code: body.currency, minor: netMinor, rateId: quote.id, rate: quote.rate } }
        : {}),
    });
    // The customs debt: the duties, and the VAT paid at customs, one item of the authority.
    const customs = duty + (deferred ? 0n : vat);
    const openItems: OpenItemSpec[] = [item];
    if (customs) {
      openItems.push({
        ref: 'customs',
        kind: 'tax.payable',
        controlAccount: rule.customsAccount,
        partyId: input.authorityId,
        currency: LEDGER_CURRENCY,
        normalSide: 'C',
        mayReverse: false,
        dueDate: taxPoint,
        documentId: found.id,
      });
      lines.push({
        account: rule.customsAccount,
        side: 'C',
        bani: customs,
        openItem: 'customs',
        partyId: input.authorityId,
        memo: `Datorie vamală DVI ${declaration.mrn}`,
      });
    }
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const entry = (
      code: string,
      direction: 'output' | 'input',
      fields: Partial<TaxEntrySpec>,
    ): TaxEntrySpec => ({
      key: `vat.${direction}`,
      tax: 'VAT',
      code,
      direction,
      baseBani: base,
      taxBani: vat,
      deductibleBani: 0n,
      ledgerBani: 0n,
      taxPoint,
      exigibility: taxPoint,
      taxPeriod,
      documentId: record.id,
      ...(partyId ? { partyId } : {}),
      attributes: {
        number: body.number,
        mrn: declaration.mrn,
        declaration: found.id,
        counterpartyCountry: supplier.country,
        rate,
        goods: 'import',
        vatPayment: deferred ? 'deferred' : 'paid',
        ...(declaration.vatPayment?.mode === 'deferred'
          ? { certificate: declaration.vatPayment.certificate }
          : {}),
      },
      ...fields,
    });
    const taxEntries: TaxEntrySpec[] = [];
    if (deferred) {
      // Art. 326 alin. (5): collected and deductible in the return (rd. 7 and 22).
      const code = tradeCodes.importDeferred(rate);
      lines.push({ account: '4427', side: 'C', bani: vat });
      taxEntries.push(entry(code, 'output', { ledgerBani: vat, line: lines.length - 1 }));
      if (deducted) {
        lines.push({ account: '4426', side: 'D', bani: vat });
        taxEntries.push(
          entry(code, 'input', { deductibleBani: vat, ledgerBani: vat, line: lines.length - 1 }),
        );
      } else taxEntries.push(entry(code, 'input', {}));
    } else {
      // Paid at customs (art. 326 alin. (3)): deductible on rd. 24–25.
      const code = tradeCodes.importPaid(rate);
      if (deducted) {
        lines.push({ account: '4426', side: 'D', bani: vat });
        taxEntries.push(
          entry(code, 'input', { deductibleBani: vat, ledgerBani: vat, line: lines.length - 1 }),
        );
      } else taxEntries.push(entry(code, 'input', {}));
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: taxPoint,
      journalClass: 'general',
      journalCode: 'CUMPARARI',
      description: `Import ${body.number} (${supplier.country}), DVI ${declaration.mrn}`,
      lines,
      openItems: [...openItems, ...(goods.stock?.openItems ?? [])],
      taxEntries,
      schedules: [],
      ...(goods.stock?.book ? goods.stock.book.effectPart() : {}),
      explanation: {
        summary: `Import ${body.number}, DVI ${declaration.mrn} din ${taxPoint}: taxe vamale ${formatMoney(duty, LEDGER_CURRENCY)} lei în cost, TVA ${formatMoney(vat, LEDGER_CURRENCY)} lei ${deferred ? 'amânată (art. 326 alin. (4), D300 rd. 7 și 22)' : 'plătită în vamă (D300 rd. 24–25)'}.`,
        details: {
          mrn: declaration.mrn,
          taxPoint,
          customsValue: declaration.totals.customsValue,
          duty: formatMoney(duty, LEDGER_CURRENCY),
          vatBase: formatMoney(base, LEDGER_CURRENCY),
          vat: formatMoney(vat, LEDGER_CURRENCY),
          vatPayment: deferred ? 'deferred' : 'paid',
          invoiceRate: rule.invoiceRate,
          ...(quote ? { rate: quote.rate } : {}),
          deduction: input.deduction,
          ...(goods.stock ? { stock: goods.stock.details } : {}),
          clauses: [
            `${CODE}:art.285(1)-(2)`,
            `${CODE}:art.289(1)-(2)`,
            `${CODE}:art.299(1)(c)-(e)`,
            `${CODE}:art.326(2)-(5)`,
            'OMFP1802/2014:conturi.446',
            deferred ? 'OPANAF174/2026:rd.7' : 'OPANAF174/2026:rd.24-25',
          ],
        },
      },
    };
    return { effect, issues };
  },
};
