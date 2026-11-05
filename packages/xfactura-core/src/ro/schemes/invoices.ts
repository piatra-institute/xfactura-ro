import { z } from 'zod';
import {
  accountCodePattern,
  itemLinesKey,
  partyStatusKey,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { LEDGER_CURRENCY } from '../../money';
import { questionIssue } from '../../questions/kinds';
import type { LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';
import { isValidCnp, isValidCui } from '../identifiers';
import { chargeabilityOf, invoiceKinds } from '../treatments/invoices';
import {
  block,
  GOODS_CLAUSES,
  goodsKinds,
  lei,
  marginRates,
  marginVat,
  MENTION_CLAUSE,
  ron,
  schemeCodes,
  schemeMentions,
  showsNoVat,
  statesMention,
  TRAVEL_CLAUSES,
  warn,
  type GoodsKind,
} from './margin';

/*
 * Invoices under the margin schemes (Codul fiscal art. 311 and 312), sales and purchases.
 *
 * - A travel agency's sale (art. 311): the single service's price, invoiced without VAT and with
 *   the mention «regimul marjei - agenții de turism» (art. 311 alin. (8), art. 319 alin. (20)
 *   lit. n)), booked as revenue at the price; its VAT is the period's, on the margin of the
 *   single services supplied in it (`margin.travel`).
 * - A dealer's item of second-hand goods, works of art, collectors' items or antiques (art. 312):
 *   bought from a person not taxable, another dealer under the scheme, an exempt supply of art.
 *   292 alin. (2) lit. g) or a small enterprise's capital good (alin. (2)), one purchase document
 *   per item, on 371 tagged with the item; sold under the scheme with the VAT of its own margin
 *   (norme pct. 86 alin. (4)–(5)), or under the normal regime (alin. (7)). The stock module (G1)
 *   does not exist: items have no quantities, each is its purchase document, and the register is
 *   built on read from the tagged lines.
 */

/** The analytics item of a dealer's item on 371: its kind and its purchase document. */
export const marginItem = (goods: GoodsKind, documentId: string) => `margin:${goods}:${documentId}`;
export function parseMarginItem(item: string): { goods: GoodsKind; documentId: string } | null {
  const match = /^margin:([a-z_]+):(.+)$/.exec(item);
  if (!match || !(goodsKinds as readonly string[]).includes(match[1]!)) return null;
  return { goods: match[1] as GoodsKind, documentId: match[2]! };
}
/** The account of the dealer's items: goods for resale (Mărfuri). */
export const ITEM_ACCOUNT = '371';
const itemLines = { prefixes: [ITEM_ACCOUNT] };

const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const account = z.string().regex(accountCodePattern);

export const marginSaleInput = z.discriminatedUnion('scheme', [
  z
    .object({
      documentId: z.uuid(),
      scheme: z.literal('travel'),
      /** The revenue account of the single services (704). */
      account,
    })
    .strict(),
  z
    .object({
      documentId: z.uuid(),
      scheme: z.literal('goods'),
      /** `margin`: the special scheme; `normal`: the normal regime the dealer may apply to any
       * eligible supply (art. 312 alin. (7)), with VAT on the whole price. */
      regime: z.enum(['margin', 'normal']).default('margin'),
      /** The revenue account (707) and the cost of goods sold (607). */
      account,
      costAccount: account,
      /** Each item sold: its purchase document and its price on this invoice, in lei, with the
       * VAT of its margin included (margin) or without VAT (normal). */
      items: z
        .array(z.object({ purchaseDocumentId: z.uuid(), price: amount }).strict())
        .min(1)
        .max(50),
    })
    .strict(),
]);
export type MarginSaleInput = z.infer<typeof marginSaleInput>;

export const supplierKinds = ['individual', 'dealer', 'exempt', 'small_enterprise'] as const;
export type SupplierKind = (typeof supplierKinds)[number];

export const marginPurchaseInput = z.discriminatedUnion('scheme', [
  z
    .object({
      documentId: z.uuid(),
      scheme: z.literal('travel'),
      /** The expense account of the single service bought (604, 628). */
      account,
    })
    .strict(),
  z
    .object({
      documentId: z.uuid(),
      scheme: z.literal('goods'),
      goods: z.enum(goodsKinds),
      /** Who sold the item (art. 312 alin. (2)): a person not taxable, through the dealer's
       * self-invoice (norme pct. 86 alin. (6) lit. d)); a dealer that applied the scheme; a
       * taxable person whose supply was exempt under art. 292 alin. (2) lit. g); a small
       * enterprise selling a capital good. */
      supplier: z.enum(supplierKinds),
      /** Goods for resale: 371. */
      account: z.literal(ITEM_ACCOUNT).default(ITEM_ACCOUNT),
    })
    .strict(),
]);
export type MarginPurchaseInput = z.infer<typeof marginPurchaseInput>;

function invoiceOf(loaded: Loaded, documentId: string, kind: string, issues: Issue[]) {
  const record = loaded.documents.get(documentId);
  if (!record) {
    issues.push(block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId'));
    return null;
  }
  if (record.kind !== kind) {
    issues.push(
      block(
        'DOCUMENT_KIND',
        kind === invoiceKinds.sale
          ? 'Se recunoaște aici o factură emisă; notele de credit în regimul marjei nu sunt încă acoperite.'
          : 'Se recunoaște aici o factură primită (sau autofactura emisă furnizorului); notele de credit în regimul marjei nu sunt încă acoperite.',
        'documentId',
      ),
    );
    return null;
  }
  const body = invoiceDocumentSchema.parse(record.body);
  if (body.currency !== LEDGER_CURRENCY)
    issues.push(block('CURRENCY', 'Facturile în regimul marjei în valută nu sunt încă acoperite.'));
  if (body.totals.prepaid !== '0.00' || body.totals.rounding !== '0.00')
    issues.push(
      block('PREPAID', 'Avansurile deduse și rotunjirile pe factură nu sunt încă acoperite.'),
    );
  if (!record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
  return { record, body };
}

/** The company's VAT status on the tax point: the margin schemes are a registered person's. */
function registered(loaded: Loaded, date: LocalDate, issues: Issue[]) {
  const status = profileAt(loaded, 'vat.status', date);
  if (!status)
    issues.push(
      questionIssue(
        'DETERMINATION_MISSING',
        'Înregistrați regimul TVA al companiei pentru această dată.',
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'vat.status' },
          params: { axis: 'vat.status', from: date },
        },
      ),
    );
  else if (status !== 'normal_vat')
    issues.push(
      block(
        'MARGIN_NOT_REGISTERED',
        'Compania nu este înregistrată în scopuri de TVA la data operațiunii: regimul marjei îl aplică persoanele impozabile care colectează TVA; un neplătitor facturează fără TVA (categoria O).',
      ),
    );
}

/** Goods for resale under the scheme need the company's statement that it keeps no quantity
 * stock: each item is its purchase document until the stock module (G1). */
function itemsOnly(loaded: Loaded, date: LocalDate, issues: Issue[]) {
  const goods = profileAt(loaded, 'activity.goods', date);
  if (goods === 'margin_goods') return;
  if (goods === 'yes')
    issues.push(
      block(
        'MARGIN_STOCK',
        'Compania a declarat că ține stocuri de bunuri (activity.goods yes): gestiunea cantitativă a stocurilor nu este încă acoperită (modulul de stocuri, G1); regimul marjei se ține aici doar pe bunuri individuale, câte un document de achiziție pe bun (activity.goods margin_goods).',
      ),
    );
  else
    issues.push(
      questionIssue(
        'MARGIN_STOCK',
        goods === 'no'
          ? 'Compania a declarat că nu lucrează cu bunuri (activity.goods no): înregistrați că ține doar bunuri individuale în regimul marjei (margin_goods).'
          : 'Înregistrați dacă firma ține doar bunuri individuale în regimul marjei, câte un document de achiziție pe bun, fără gestiune cantitativă (activity.goods margin_goods).',
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'activity.goods' },
          params: { axis: 'activity.goods', from: date },
        },
      ),
    );
}

const counterpartyAttributes = (body: InvoiceDocument, sale: boolean): Record<string, string> => {
  const counterparty = sale ? body.customer : body.supplier;
  return {
    documentType: body.documentType,
    number: body.number,
    counterpartyTaxId: counterparty.taxId,
    counterpartyCountry: counterparty.country,
  };
};

/**
 * A sale under a margin scheme: a travel agency's single service, at its price (its VAT is the
 * period's margin's, `margin.travel`), or a dealer's items, each with the VAT of its margin over
 * its purchase price (the scheme) or with VAT on its whole price (the normal regime).
 */
export const marginSale: Treatment<MarginSaleInput> = {
  id: 'margin.sale',
  version: 1,
  description:
    'Factură emisă în regimul marjei: serviciul unic al agenției de turism (art. 311), la prețul lui, sau bunurile second-hand, operele de artă, obiectele de colecție și antichitățile vândute, cu TVA marjei fiecăruia (art. 312) sau, la alegere, în regim normal.',
  input: marginSaleInput,
  agent: true,
  summary:
    "A sale under a margin scheme: a travel agency's service at its price (VAT comes with the period's margin), or a dealer's items, each taxed on its margin over its purchase (or normally).",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [
      input.documentId,
      ...(input.scheme === 'goods' ? input.items.map((item) => item.purchaseDocumentId) : []),
    ],
    profile: true,
    ...(input.scheme === 'goods' ? { itemLines } : {}),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const found = invoiceOf(loaded, input.documentId, invoiceKinds.sale, issues);
    if (!found) return { effect: null, issues };
    const { record, body } = found;
    const taxPoint = chargeabilityOf(body).date;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    registered(loaded, taxPoint, issues);
    if (!input.account.startsWith('70'))
      issues.push(block('ACCOUNT', 'Folosiți un cont de venituri (70x).', 'account'));
    const total = ron(body.totals.payable);
    const partyId = record.partyId!;
    const receivable: OpenItemSpec = {
      ref: 'counterparty',
      kind: 'receivable',
      controlAccount: '4111',
      partyId,
      currency: LEDGER_CURRENCY,
      normalSide: 'D',
      mayReverse: false,
      documentId: record.id,
    };
    const attributes = counterpartyAttributes(body, true);

    if (input.scheme === 'travel') {
      if (!showsNoVat(body))
        issues.push(
          block(
            'MARGIN_VAT_SHOWN',
            'Agenția de turism nu înscrie taxa distinct în factura către călător (art. 311 alin. (8)): factura serviciului unic se emite fără TVA, cu mențiunea regimului.',
          ),
        );
      if (!statesMention(body, schemeMentions.travel))
        issues.push(
          warn(
            'MARGIN_MENTION',
            `Confirmați că factura înscrie mențiunea „${schemeMentions.travel}” (art. 319 alin. (20) lit. n)): motorul o caută în motivul scutirii (BT-120) și nu o găsește.`,
            { clauses: [MENTION_CLAUSE] },
          ),
        );
      if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
      const effect: Effect = {
        schema: 'effect@1',
        date: body.issueDate as LocalDate,
        journalClass: 'general',
        journalCode: 'VANZARI',
        description: `Factură emisă ${body.number}, regimul marjei - agenții de turism`,
        lines: [
          { account: '4111', side: 'D', bani: total, openItem: receivable.ref, partyId },
          { account: input.account, side: 'C', bani: total },
        ],
        openItems: [receivable],
        taxEntries: [
          {
            key: 'vat.output',
            tax: 'VAT',
            code: schemeCodes.travelSale,
            direction: 'output',
            baseBani: total,
            taxBani: 0n,
            deductibleBani: 0n,
            ledgerBani: 0n,
            taxPoint,
            exigibility: taxPoint,
            taxPeriod,
            documentId: record.id,
            partyId,
            attributes: { ...attributes, scheme: 'travel' },
          },
        ],
        schedules: [],
        explanation: {
          summary: `${body.number} din ${body.issueDate}: serviciu unic al agenției de turism, ${lei(total)} lei fără TVA înscrisă; TVA se calculează pe marja serviciilor unice ale perioadei (margin.travel), la data prestării.`,
          details: { taxPoint, scheme: 'travel', clauses: [...TRAVEL_CLAUSES, MENTION_CLAUSE] },
        },
      };
      return { effect, issues };
    }

    // A dealer's items.
    itemsOnly(loaded, taxPoint, issues);
    if (!input.costAccount.startsWith('607'))
      issues.push(
        block('ACCOUNT', 'Costul bunurilor vândute se înregistrează pe 607.', 'costAccount'),
      );
    const rates = marginRates(rules, 'ro.vat.margin.goods', taxPoint, issues);
    const held = new Map(
      (loaded.itemLines.get(itemLinesKey(itemLines)) ?? []).map((row) => [row.item, row]),
    );
    const seen = new Set<string>();
    const items = input.items.map((item, index) => {
      const path = `items.${index}`;
      if (seen.has(item.purchaseDocumentId))
        issues.push(block('MARGIN_ITEM', 'Bunul apare de două ori pe factură.', path));
      seen.add(item.purchaseDocumentId);
      const purchase = loaded.documents.get(item.purchaseDocumentId);
      const goods = goodsKinds.find((kind) => held.has(marginItem(kind, item.purchaseDocumentId)));
      const row = goods ? held.get(marginItem(goods, item.purchaseDocumentId)) : undefined;
      const cost = row ? row.debit - row.credit : 0n;
      if (!purchase || !row)
        issues.push(
          block(
            'MARGIN_ITEM_UNKNOWN',
            `Documentul ${purchase?.number ?? item.purchaseDocumentId} nu este achiziția unui bun înregistrat în regimul marjei (margin.purchase): un bun se vinde în regimul marjei doar dacă a fost cumpărat în condițiile art. 312 alin. (2).`,
            path,
          ),
        );
      else if (cost <= 0n)
        issues.push(
          block(
            'MARGIN_ITEM_SOLD',
            `Bunul cumpărat cu ${purchase.number ?? purchase.id} nu mai este în gestiune: a fost vândut sau achiziția lui a fost stornată.`,
            path,
          ),
        );
      return {
        purchaseDocumentId: item.purchaseDocumentId,
        number: purchase?.number ?? item.purchaseDocumentId,
        goods: goods ?? 'second_hand',
        price: ron(item.price),
        cost,
      };
    });
    const priced = items.reduce((sum, item) => sum + item.price, 0n);
    if (input.regime === 'margin') {
      if (!showsNoVat(body))
        issues.push(
          block(
            'MARGIN_VAT_SHOWN',
            'Revânzătorul nu înscrie taxa distinct în factura emisă clientului pentru livrările în regimul marjei (art. 312 alin. (12)): factura se emite fără TVA, cu mențiunea regimului.',
          ),
        );
      for (const kind of new Set(items.map((item) => item.goods)))
        if (!statesMention(body, schemeMentions[kind]))
          issues.push(
            warn(
              'MARGIN_MENTION',
              `Confirmați că factura înscrie mențiunea „${schemeMentions[kind]}” (art. 319 alin. (20) lit. o)): motorul o caută în motivul scutirii (BT-120) și nu o găsește.`,
              { clauses: [MENTION_CLAUSE] },
            ),
          );
      if (priced !== total)
        issues.push(
          block(
            'ALLOCATION',
            `Factura are de plată ${lei(total)} lei; prețurile bunurilor însumează ${lei(priced)} lei.`,
            'items',
          ),
        );
    } else {
      const standard = body.taxes.filter((tax) => tax.category === 'S');
      if (standard.length !== 1 || body.taxes.length !== 1 || standard[0]!.rate !== rates?.rate)
        issues.push(
          block(
            'MARGIN_NORMAL_RATE',
            `În regim normal bunurile se facturează cu TVA la cota standard (${rates?.rate ?? '–'}%), o singură categorie pe factură; cota redusă și facturile mixte nu sunt încă acoperite.`,
          ),
        );
      const base = standard.reduce((sum, tax) => sum + ron(tax.base), 0n);
      if (priced !== base)
        issues.push(
          block(
            'ALLOCATION',
            `Baza impozabilă a facturii este ${lei(base)} lei; prețurile bunurilor însumează ${lei(priced)} lei.`,
            'items',
          ),
        );
    }
    if (issues.some((issue) => issue.severity === 'block') || !rates)
      return { effect: null, issues };

    const lines: LineSpec[] = [
      { account: '4111', side: 'D', bani: total, openItem: receivable.ref, partyId },
    ];
    const taxEntries: TaxEntrySpec[] = [];
    const computed = items.map((item) => {
      const margin = item.price - item.cost;
      return { ...item, margin, ...marginVat(margin, rates.rate) };
    });
    if (input.regime === 'margin') {
      const vat = computed.reduce((sum, item) => sum + item.vat, 0n);
      lines.push({ account: input.account, side: 'C', bani: total - vat });
      if (vat !== 0n) lines.push({ account: '4427', side: 'C', bani: vat });
      const taxLine = vat !== 0n ? lines.length - 1 : undefined;
      computed.forEach((item, index) =>
        taxEntries.push({
          key: computed.length === 1 ? 'vat.output' : `vat.output:${index + 1}`,
          tax: 'VAT',
          code: schemeCodes.goods(rates.rate),
          direction: 'output',
          baseBani: item.base,
          taxBani: item.vat,
          deductibleBani: 0n,
          ledgerBani: item.vat,
          ...(taxLine !== undefined && item.vat !== 0n ? { line: taxLine } : {}),
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          partyId,
          attributes: {
            ...attributes,
            scheme: 'goods',
            goods: item.goods,
            item: item.purchaseDocumentId,
            price: lei(item.price),
            cost: lei(item.cost),
            margin: lei(item.margin),
          },
        }),
      );
    } else {
      const tax = body.taxes[0]!;
      lines.push({ account: input.account, side: 'C', bani: ron(tax.base) });
      lines.push({ account: '4427', side: 'C', bani: ron(tax.tax) });
      taxEntries.push({
        key: 'vat.output',
        tax: 'VAT',
        code: `S-${rates.rate}`,
        direction: 'output',
        baseBani: ron(tax.base),
        taxBani: ron(tax.tax),
        deductibleBani: 0n,
        ledgerBani: ron(tax.tax),
        line: lines.length - 1,
        taxPoint,
        exigibility: taxPoint,
        taxPeriod,
        documentId: record.id,
        partyId,
        attributes: {
          ...attributes,
          scheme: 'goods_normal',
          items: computed.map((item) => item.purchaseDocumentId).join(','),
        },
      });
    }
    // The items leave the goods for resale at their purchase price.
    for (const item of computed) {
      lines.push({ account: input.costAccount, side: 'D', bani: item.cost });
      lines.push({
        account: ITEM_ACCOUNT,
        side: 'C',
        bani: item.cost,
        analytics: { item: marginItem(item.goods, item.purchaseDocumentId) },
        memo: `Bun ${item.number}`,
      });
    }
    const vat = computed.reduce((sum, item) => sum + item.vat, 0n);
    const effect: Effect = {
      schema: 'effect@1',
      date: body.issueDate as LocalDate,
      journalClass: 'general',
      journalCode: 'VANZARI',
      description: `Factură emisă ${body.number}, ${input.regime === 'margin' ? 'regimul marjei' : 'bunuri din regimul marjei, în regim normal'}`,
      lines,
      openItems: [receivable],
      taxEntries,
      schedules: [],
      explanation: {
        summary:
          input.regime === 'margin'
            ? `${body.number} din ${body.issueDate}: ${computed.length} ${computed.length === 1 ? 'bun vândut' : 'bunuri vândute'} în regimul marjei, ${lei(total)} lei; TVA pe marjă ${lei(vat)} lei (procedeul sutei mărite, cota ${rates.rate}%), marja negativă fără TVA.`
            : `${body.number} din ${body.issueDate}: bunuri cumpărate în regimul marjei, vândute în regim normal (art. 312 alin. (7)), TVA ${body.taxes[0]!.tax} lei pe întregul preț.`,
        details: {
          taxPoint,
          regime: input.regime,
          rate: rates.rate,
          items: computed.map((item) => ({
            purchase: item.number,
            goods: item.goods,
            price: lei(item.price),
            cost: lei(item.cost),
            margin: lei(item.margin),
            vat: input.regime === 'margin' ? lei(item.vat) : null,
          })),
          clauses: [...GOODS_CLAUSES, MENTION_CLAUSE],
        },
      },
    };
    return { effect, issues };
  },
};

/**
 * A purchase under a margin scheme: a single service bought from another travel agency that
 * applied the scheme (norme pct. 85 alin. (7)), a cost of the traveller's single service, or a
 * dealer's item for resale (art. 312 alin. (2)), into 371 tagged with its purchase document.
 * Neither shows VAT, and none is deducted (art. 311 alin. (6), art. 312 alin. (6)).
 */
export const marginPurchase: Treatment<MarginPurchaseInput> = {
  id: 'margin.purchase',
  version: 1,
  description:
    'Achiziție în regimul marjei: serviciul cumpărat de la o altă agenție de turism în regim special (art. 311) sau bunul second-hand, opera de artă, obiectul de colecție ori antichitatea cumpărate pentru revânzare (art. 312 alin. (2)), fără TVA de dedus.',
  input: marginPurchaseInput,
  agent: true,
  summary:
    'A purchase under a margin scheme: a travel service from another agency in the scheme, or a second-hand, art or antique item bought for resale from a non-taxable seller or a dealer; no VAT is deducted.',
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId], profile: true }),
  followUp(input, loaded) {
    const record = loaded.documents.get(input.documentId);
    const parsed = invoiceDocumentSchema.safeParse(record?.body);
    if (!record?.partyId || !parsed.success) return null;
    return {
      parties: [record.partyId],
      partyStatus: [{ partyId: record.partyId, date: chargeabilityOf(parsed.data).date }],
    };
  },
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const found = invoiceOf(loaded, input.documentId, invoiceKinds.purchase, issues);
    if (!found) return { effect: null, issues };
    const { record, body } = found;
    const taxPoint = chargeabilityOf(body).date;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    registered(loaded, taxPoint, issues);
    const total = ron(body.totals.payable);
    const partyId = record.partyId!;
    const supplierId = body.supplier.taxId.toUpperCase().replace(/\s+/g, '');
    const vatCode = /^RO\d+$/.test(supplierId) && isValidCui(supplierId);
    const status = record.partyId
      ? loaded.partyStatus.get(partyStatusKey(record.partyId, taxPoint))
      : undefined;
    if (body.supplier.country !== 'RO')
      issues.push(
        block(
          'DOMESTIC',
          'Achizițiile în regimul marjei de la furnizori din străinătate (achiziții intracomunitare, importuri) nu sunt încă acoperite.',
        ),
      );
    if (!showsNoVat(body))
      issues.push(
        block(
          'MARGIN_VAT_CHARGED',
          'Documentul înscrie TVA: o achiziție taxată în regim normal nu este o achiziție în regimul marjei (art. 312 alin. (2)); înregistrați-o cu invoices.recognize.',
        ),
      );
    const lines: LineSpec[] = [];
    const payable: OpenItemSpec = {
      ref: 'counterparty',
      kind: 'payable',
      controlAccount: '401',
      partyId,
      currency: LEDGER_CURRENCY,
      normalSide: 'C',
      mayReverse: false,
      documentId: record.id,
    };
    let entry: Pick<TaxEntrySpec, 'code' | 'attributes'>;
    let summary: string;
    if (input.scheme === 'travel') {
      if (!/^6/.test(input.account))
        issues.push(block('ACCOUNT', 'Folosiți un cont de cheltuieli (6xx).', 'account'));
      if (!vatCode || (status && !status.vatPayer))
        issues.push(
          block(
            'MARGIN_SUPPLIER',
            `Furnizorul ${body.supplier.name} nu este înregistrat în scopuri de TVA: un serviciu în regimul marjei se cumpără de la o agenție de turism care îl aplică (norme pct. 85 alin. (7)).`,
          ),
        );
      if (!statesMention(body, schemeMentions.travel))
        issues.push(
          warn(
            'MARGIN_MENTION',
            `Confirmați că factura furnizorului înscrie mențiunea „${schemeMentions.travel}” (art. 319 alin. (20) lit. n)).`,
            { clauses: [MENTION_CLAUSE] },
          ),
        );
      lines.push({ account: input.account, side: 'D', bani: total });
      entry = {
        code: schemeCodes.travelPurchase,
        attributes: { ...counterpartyAttributes(body, false), scheme: 'travel' },
      };
      summary = `${body.number} din ${body.issueDate}: serviciu cumpărat de la o agenție de turism în regim special, ${lei(total)} lei; intră în costurile serviciului unic (margin.travel), fără TVA de dedus.`;
    } else {
      itemsOnly(loaded, taxPoint, issues);
      const supplier = input.supplier;
      const cnp = isValidCnp(supplierId);
      if (supplier === 'dealer') {
        if (!vatCode || (status && !status.vatPayer))
          issues.push(
            block(
              'MARGIN_SUPPLIER',
              `Furnizorul ${body.supplier.name} nu are cod de TVA valabil: un revânzător care aplică regimul marjei este înregistrat în scopuri de TVA (art. 312 alin. (2) lit. d)).`,
            ),
          );
        if (!statesMention(body, schemeMentions[input.goods]))
          issues.push(
            warn(
              'MARGIN_MENTION',
              `Confirmați că factura revânzătorului înscrie mențiunea „${schemeMentions[input.goods]}” (art. 319 alin. (20) lit. o)): doar livrarea lui în regim special permite revânzarea în regimul marjei (art. 312 alin. (2) lit. d)).`,
              { clauses: [MENTION_CLAUSE] },
            ),
          );
      } else if (supplier === 'individual') {
        if (vatCode || (status && status.vatPayer))
          issues.push(
            block(
              'MARGIN_SUPPLIER',
              `Furnizorul ${body.supplier.name} are cod de TVA: o persoană neimpozabilă nu este înregistrată în scopuri de TVA (art. 312 alin. (2) lit. a)).`,
            ),
          );
        issues.push(
          warn(
            'MARGIN_SELF_INVOICE',
            `Confirmați că documentul este autofactura emisă persoanei ${body.supplier.name}, care nu are obligația să emită factură, cu elementele normelor pct. 86 alin. (6) lit. d) (numărul și data, data achiziției, părțile, codul de TVA al companiei, bunul și prețul), și că vânzătorul nu este persoană impozabilă pentru acest bun.`,
            { clauses: GOODS_CLAUSES, cnp: cnp ? 'yes' : 'no' },
          ),
        );
      } else if (supplier === 'exempt') {
        if (!body.taxes.every((tax) => tax.category === 'E'))
          issues.push(
            block(
              'MARGIN_SUPPLIER',
              'Livrarea scutită după art. 292 alin. (2) lit. g) se facturează în categoria E (art. 312 alin. (2) lit. b)).',
            ),
          );
        issues.push(
          warn(
            'MARGIN_EXEMPT_SUPPLY',
            'Confirmați că livrarea furnizorului a fost scutită după art. 292 alin. (2) lit. g) (bunuri afectate unei activități scutite fără drept de deducere): doar atunci bunul intră în regimul marjei (art. 312 alin. (2) lit. b)).',
            { clauses: GOODS_CLAUSES },
          ),
        );
      } else {
        if (vatCode && (!status || status.vatPayer))
          issues.push(
            block(
              'MARGIN_SUPPLIER',
              `Furnizorul ${body.supplier.name} are cod de TVA: o întreprindere mică nu este înregistrată în scopuri de TVA (art. 310).`,
            ),
          );
        if (input.goods !== 'second_hand')
          issues.push(
            block(
              'MARGIN_SUPPLIER',
              'De la o întreprindere mică intră în regimul marjei doar bunurile de capital ale ei (art. 312 alin. (2) lit. c)).',
            ),
          );
        issues.push(
          warn(
            'MARGIN_SMALL_ENTERPRISE',
            'Confirmați că factura întreprinderii mici menționează că bunul a fost folosit de ea ca activ corporal fix (norme pct. 86 alin. (7)): doar bunurile ei de capital intră în regimul marjei (art. 312 alin. (2) lit. c)).',
            { clauses: GOODS_CLAUSES },
          ),
        );
      }
      if (body.lines.length > 1)
        issues.push(
          warn(
            'MARGIN_ITEM_LINES',
            `Documentul are ${body.lines.length} linii: motorul îl ține ca un singur bun, cu prețul de cumpărare de ${lei(total)} lei (un document de achiziție pe bun, până la modulul de stocuri). Bunurile cumpărate împreună și vândute separat se înregistrează pe documente separate.`,
          ),
        );
      lines.push({
        account: ITEM_ACCOUNT,
        side: 'D',
        bani: total,
        analytics: { item: marginItem(input.goods, record.id) },
        memo: `Bun ${body.number}`,
      });
      entry = {
        code: schemeCodes.goodsPurchase,
        attributes: {
          ...counterpartyAttributes(body, false),
          scheme: 'goods',
          goods: input.goods,
          supplier,
        },
      };
      summary = `${body.number} din ${body.issueDate}: bun cumpărat pentru revânzare în regimul marjei (${input.goods}, de la ${supplier}), ${lei(total)} lei pe 371; prețul de cumpărare al marjei, fără TVA de dedus.`;
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    lines.push({ account: '401', side: 'C', bani: total, openItem: payable.ref, partyId });
    const effect: Effect = {
      schema: 'effect@1',
      date: body.issueDate as LocalDate,
      journalClass: 'general',
      journalCode: 'CUMPARARI',
      description: `Factură primită ${body.number}, regimul marjei`,
      lines,
      openItems: [payable],
      taxEntries: [
        {
          key: 'vat.input',
          tax: 'VAT',
          code: entry.code,
          direction: 'input',
          baseBani: total,
          taxBani: 0n,
          deductibleBani: 0n,
          ledgerBani: 0n,
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          partyId,
          attributes: entry.attributes,
        },
      ],
      schedules: [],
      explanation: {
        summary,
        details: {
          taxPoint,
          scheme: input.scheme,
          ...(status
            ? { partnerStatus: { date: status.date, evidenceId: status.evidenceId } }
            : {}),
          clauses: input.scheme === 'travel' ? TRAVEL_CLAUSES : GOODS_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};
