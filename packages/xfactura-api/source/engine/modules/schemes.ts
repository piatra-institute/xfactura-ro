import { and, asc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { JsonValue, TaxLedgerEntry } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import type { D394Operation, D394Partner } from 'xfactura-core/ro/declarations/d394';
import { isValidCnp, isValidCui } from 'xfactura-core/ro/identifiers';
import {
  folded,
  isGoodsMarginCode,
  isTravelMarginCode,
  schemeCodes,
  schemeMentions,
} from 'xfactura-core/ro/schemes';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { entries, taxEntries } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import type { CloseCheck } from '../kernel/periods';
import { maskCnps } from '../kernel/personal';
import type { WorkStep } from '../kernel/work';
import {
  amountLabel,
  periodLabel,
  textLabel,
  treatmentName,
  type DetailLabels,
} from '../kernel/work-names';
import type { DeclarationProblem } from './declarations';

/*
 * The special VAT schemes on read (docs/ACCOUNTING_ENGINE.md, "Special VAT schemes (V4)"): the
 * register of a dealer's items under the margin scheme (norme pct. 86 alin. (6)), built from the
 * tagged lines' tax entries; a travel agency's sales under the scheme that no posted computation
 * counted (the worklist and the month close); and where D394 reports the schemes (the LS and AS
 * operations and the margins' information fields).
 */

const money = (bani: bigint) => formatMoney(bani, 'RON');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const step = (operation: string, by: 'agent' | 'human', inputHint: WorkStep['inputHint'] = {}) =>
  ({ operation, by, inputHint }) satisfies WorkStep;

type Row = {
  entryId: string;
  taxNo: number;
  seq: number;
  code: string;
  direction: 'output' | 'input';
  base: bigint;
  tax: bigint;
  taxPoint: string;
  taxPeriod: string | null;
  documentId: string | null;
  attributes: Record<string, string>;
};

/** The scheme's tax entries of entries that stand, reversals left out, in posting order. */
async function schemeRows(tx: Transaction, companyId: string, codes: string[], patterns: string[]) {
  const rows = await tx
    .select({ tax: taxEntries, seq: entries.seq })
    .from(taxEntries)
    .innerJoin(
      entries,
      and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
    )
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        isNull(taxEntries.originTaxEntry),
        or(
          ...(codes.length ? [inArray(taxEntries.code, codes)] : []),
          ...patterns.map((pattern) => like(taxEntries.code, pattern)),
        ),
        entryStands('"acc_entries"'),
      ),
    )
    .orderBy(asc(entries.seq), asc(taxEntries.taxNo));
  return rows.map((row): Row => ({
    entryId: row.tax.entryId,
    taxNo: Number(row.tax.taxNo),
    seq: Number(row.seq),
    code: row.tax.code,
    direction: row.tax.direction,
    base: row.tax.baseBani,
    tax: row.tax.taxBani,
    taxPoint: row.tax.taxPoint,
    taxPeriod: row.tax.taxPeriod,
    documentId: row.tax.documentId,
    attributes: JSON.parse(row.tax.attributes) as Record<string, string>,
  }));
}

export const goodsRegisterInput = z
  .object({
    /** Only the items bought or sold from this day. */
    from: day.optional(),
    /** Only the items bought by this day; a sale after it shows the item held. */
    to: day.optional(),
  })
  .strict();

const registerItem = z.object({
  purchaseDocumentId: z.string(),
  goods: z.string(),
  purchase: z.object({
    number: z.string(),
    date: z.string(),
    supplier: z.string(),
    supplierTaxId: z.string(),
    cost: z.string(),
  }),
  state: z.enum(['held', 'sold']),
  sale: z
    .object({
      documentId: z.string(),
      number: z.string(),
      date: z.string(),
      regime: z.enum(['margin', 'normal']),
      price: z.string().nullable(),
      margin: z.string().nullable(),
      base: z.string(),
      vat: z.string(),
    })
    .nullable(),
});
export const goodsRegisterView = z.object({
  items: z.array(registerItem),
  /** The register of norme pct. 86 alin. (6) lit. c): per VAT period and rate, the base and the
   * VAT of the supplies under the scheme. */
  periods: z.array(
    z.object({
      period: z.string(),
      rate: z.string(),
      supplies: z.number(),
      sales: z.string(),
      costs: z.string(),
      base: z.string(),
      vat: z.string(),
    }),
  ),
  next: z.string().nullable(),
});

/** The dealer's items under the margin scheme: each purchase document with its sale. */
export async function goodsRegister(
  tx: Transaction,
  companyId: string,
  input: z.infer<typeof goodsRegisterInput>,
): Promise<z.infer<typeof goodsRegisterView>> {
  const rows = await schemeRows(tx, companyId, [schemeCodes.goodsPurchase], ['MS-312-%', 'S-%']);
  const purchases = rows.filter((row) => row.code === schemeCodes.goodsPurchase);
  const sales = rows.filter((row) => isGoodsMarginCode(row.code));
  const normal = rows.filter(
    (row) => row.direction === 'output' && row.attributes.scheme === 'goods_normal',
  );
  const items = purchases
    .filter((row) => !input.to || row.taxPoint <= input.to)
    .map((row): z.infer<typeof registerItem> => {
      const id = row.documentId ?? '';
      const sold = sales.find((sale) => sale.attributes.item === id);
      const asNormal = normal.find((sale) => (sale.attributes.items ?? '').split(',').includes(id));
      const within = (date: string) => !input.to || date <= input.to;
      const sale =
        sold && within(sold.taxPoint)
          ? {
              documentId: sold.documentId ?? '',
              number: sold.attributes.number ?? '',
              date: sold.taxPoint,
              regime: 'margin' as const,
              price: sold.attributes.price ?? null,
              margin: sold.attributes.margin ?? null,
              base: money(sold.base),
              vat: money(sold.tax),
            }
          : asNormal && within(asNormal.taxPoint)
            ? {
                documentId: asNormal.documentId ?? '',
                number: asNormal.attributes.number ?? '',
                date: asNormal.taxPoint,
                regime: 'normal' as const,
                price: null,
                margin: null,
                base: money(asNormal.base),
                vat: money(asNormal.tax),
              }
            : null;
      return {
        purchaseDocumentId: id,
        goods: row.attributes.goods ?? '',
        purchase: {
          number: row.attributes.number ?? '',
          date: row.taxPoint,
          supplier: row.attributes.supplier ?? '',
          supplierTaxId: row.attributes.counterpartyTaxId ?? '',
          cost: money(row.base),
        },
        state: sale ? 'sold' : 'held',
        sale,
      };
    })
    .filter(
      (item) =>
        !input.from || item.purchase.date >= input.from || (item.sale?.date ?? '') >= input.from,
    );
  const periods = new Map<
    string,
    {
      period: string;
      rate: string;
      supplies: number;
      sales: bigint;
      costs: bigint;
      base: bigint;
      vat: bigint;
    }
  >();
  for (const sale of sales) {
    if ((input.from && sale.taxPoint < input.from) || (input.to && sale.taxPoint > input.to))
      continue;
    const rate = sale.code.slice('MS-312-'.length);
    const key = `${sale.taxPeriod}|${rate}`;
    const held = periods.get(key) ?? {
      period: sale.taxPeriod ?? '',
      rate,
      supplies: 0,
      sales: 0n,
      costs: 0n,
      base: 0n,
      vat: 0n,
    };
    held.supplies += 1;
    held.sales += parseMoney(sale.attributes.price ?? '0', 'RON');
    held.costs += parseMoney(sale.attributes.cost ?? '0', 'RON');
    held.base += sale.base;
    held.vat += sale.tax;
    periods.set(key, held);
  }
  return {
    items,
    periods: [...periods.values()].map((held) => ({
      ...held,
      sales: money(held.sales),
      costs: money(held.costs),
      base: money(held.base),
      vat: money(held.vat),
    })),
    next: null,
  };
}

/** A travel agency's sales under the scheme no posted computation counted, by VAT period. */
export async function travelUncounted(tx: Transaction, companyId: string) {
  const rows = await schemeRows(tx, companyId, [schemeCodes.travelSale], ['MS-311-%']);
  const counted = new Set(
    rows
      .filter((row) => isTravelMarginCode(row.code))
      .flatMap((row) => (row.attributes.documents ?? '').split(',')),
  );
  const byPeriod = new Map<string, { documents: string[]; numbers: string[]; bani: bigint }>();
  for (const row of rows) {
    if (row.code !== schemeCodes.travelSale || !row.documentId || counted.has(row.documentId))
      continue;
    const period = row.taxPeriod ?? row.taxPoint.slice(0, 7);
    const held = byPeriod.get(period) ?? { documents: [], numbers: [], bani: 0n };
    held.documents.push(row.documentId);
    held.numbers.push(row.attributes.number ?? row.documentId);
    held.bani += row.base;
    byPeriod.set(period, held);
  }
  return byPeriod;
}

/** An item of the special schemes, as the worklist reads it. */
export type SchemeWorkItem = {
  kind: 'margin.travel';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  period: string;
  message: string;
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};

/**
 * A VAT period whose travel sales under the scheme no computation counted: warned once the period
 * ended, blocking from the 25th of the next month (the D300's deadline). Sales of a trip supplied
 * in a later period stay listed until then: the computation of that period counts them.
 */
export async function schemeWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
): Promise<SchemeWorkItem[]> {
  const items: SchemeWorkItem[] = [];
  for (const [period, held] of await travelUncounted(tx, companyId)) {
    const end = vatPeriodEnd(period);
    if (today <= end) continue;
    const month = Number(end.slice(5, 7));
    const due = `${month === 12 ? Number(end.slice(0, 4)) + 1 : end.slice(0, 4)}-${String((month % 12) + 1).padStart(2, '0')}-25`;
    items.push({
      kind: 'margin.travel',
      subject: { kind: 'vatPeriod', id: period },
      severity: today >= due ? 'block' : 'warn',
      period,
      message: `Facturile ${held.numbers.join(', ')} (${money(held.bani)} lei) sunt vânzări ale agenției de turism în regimul marjei pe care niciun calcul al marjei nu le cuprinde: TVA se calculează pe marja serviciilor unice prestate în perioadă (art. 311 alin. (4), norme pct. 85 alin. (4)) și se declară în decont (rd. 9).`,
      details: {
        period,
        documents: held.documents,
        total: money(held.bani),
        rule: 'ro.vat.margin.travel',
      },
      labels: {
        period: periodLabel('Perioadă'),
        documents: textLabel('Documente'),
        total: amountLabel('Total', { currency: 'RON' }),
        rule: textLabel('Regulă'),
      },
      next: [
        step('proposals.propose', 'agent', {
          treatment: 'margin.travel',
          input: { period, date: end, trips: [] },
        }),
      ],
    });
  }
  return items;
}

/** The month close warns of a travel agency's sales under the scheme left out of every margin. */
export const schemeChecks: CloseCheck[] = [
  {
    id: 'margin.travel',
    async run(tx, companyId, month) {
      // The VAT period ending in the month closed: its margin belongs to its return.
      const uncounted = [...(await travelUncounted(tx, companyId))].filter(([period]) =>
        vatPeriodEnd(period).startsWith(month),
      );
      const documents = uncounted.flatMap(([, held]) => held.documents);
      return documents.length
        ? [
            {
              code: 'TRAVEL_MARGIN_UNCOMPUTED',
              severity: 'warn' as const,
              message: `${documents.length} vânzări ale agenției de turism în regimul marjei nu sunt cuprinse în marja perioadei (${treatmentName('margin.travel').toLowerCase()}): fără calcul, decontul nu are TVA lor.`,
              count: documents.length,
              items: documents.slice(0, 20),
            },
          ]
        : [];
    },
  },
];

export class SpecialSchemes {
  constructor(private readonly commands: Commands) {}

  /** The register as this caller reads it: a purchase from an individual names the CNP the
   * invoice states, masked for a caller who may not read personal data (`maskCnps`). */
  register(actor: Actor, input: z.infer<typeof goodsRegisterInput>) {
    return this.commands.read(actor, 'margin.goods.register', async (tx, access) => {
      const register = await goodsRegister(tx, actor.companyId, input);
      return (await this.commands.disclosable(tx, actor, access.role))(['personal'])
        ? register
        : maskCnps(register);
    });
  }
}

// D394.

/** Whether a margin-scheme item was bought from a person not registered for VAT: D394 N. */
export const goodsFromUnregistered = (entry: Pick<TaxLedgerEntry, 'code' | 'attributes'>) =>
  entry.code === schemeCodes.goodsPurchase &&
  !/^RO\d+$/.test((entry.attributes.counterpartyTaxId ?? '').toUpperCase().replace(/\s+/g, ''));

/** The entries of the schemes D394 reports in sections of their own (LS, AS, informatii); an
 * item bought from a person not registered for VAT and the farmer's compensation are N. */
export const isD394SchemeEntry = (entry: Pick<TaxLedgerEntry, 'code' | 'attributes'>) =>
  isTravelMarginCode(entry.code) ||
  isGoodsMarginCode(entry.code) ||
  entry.code === schemeCodes.travelSale ||
  entry.code === schemeCodes.travelPurchase ||
  (entry.code === schemeCodes.goodsPurchase && !goodsFromUnregistered(entry));

/** A partner as D394 identifies it from a tax entry's counterparty: registered by its RO code,
 * otherwise by its CUI or CNP, otherwise by its invoicing details' address. */
function partnerOf(
  entry: TaxLedgerEntry,
  name: string,
  details: Party | undefined,
  problems: DeclarationProblem[],
): { partner: D394Partner; key: string } | null {
  const taxId = (entry.attributes.counterpartyTaxId ?? '').toUpperCase().replace(/\s+/g, '');
  if (/^RO\d+$/.test(taxId) && isValidCui(taxId))
    return {
      partner: { kind: 'registered', cui: taxId.slice(2), name },
      key: `1|${taxId.slice(2)}`,
    };
  if (isValidCnp(taxId) || isValidCui(taxId))
    return { partner: { kind: 'unregistered', code: taxId, name }, key: `2|${taxId}` };
  const address = details?.address;
  if (!address || (address.country === 'RO' && !address.subdivision)) {
    problems.push({
      code: 'D394_ADDRESS',
      message: `Partenerul ${name} nu are cod de identificare sau adresă cu județ.`,
    });
    return null;
  }
  return {
    partner: {
      kind: 'unregistered',
      name,
      address: {
        country: address.country,
        ...(address.country === 'RO' && address.subdivision ? { county: address.subdivision } : {}),
        locality: address.city,
        street: address.lines.join(', '),
      },
    },
    key: `2|party:${entry.partyId}`,
  };
}

/**
 * The special schemes in D394: supplies under the margin schemes (LS, the price as invoiced, per
 * partner and type of partner, without VAT) and acquisitions from those applying them (AS, from a
 * partner registered for VAT), the values on the invoices, margin and VAT included (OPANAF nr.
 * 3.769/2015 anexa nr. 2 secțiunea a 2-a); the margins' information fields (secțiunea 1 lit. I
 * pct. 6) from the period's computations: a travel agency's receipts, costs, the base of its
 * single services (the margin without VAT) and VAT (incasari_ag, costuri_ag, marja_ag, tva_ag),
 * and the items sold: their sale and purchase prices, the margin as the difference between them
 * and the VAT (pret_vanzare, pret_cumparare, marja_antic, tva_antic), in whole lei. An item
 * bought from a person not registered for VAT and the farmer's compensation are acquisitions of
 * type N, which the statement's own loop writes.
 */
export function schemeSections(
  entries: readonly TaxLedgerEntry[],
  names: (entry: TaxLedgerEntry) => string,
  details: (entry: TaxLedgerEntry) => Party | undefined,
  roundToLeu: (bani: bigint) => bigint,
  problems: DeclarationProblem[],
) {
  // Each document's value in its group: a storno in the period cancels its invoice's.
  const groups = new Map<
    string,
    { type: 'LS' | 'AS'; partner: D394Partner; documents: Map<string, bigint>; bani: bigint }
  >();
  const travel = { sales: 0n, costs: 0n, base: 0n, vat: 0n, found: false };
  const goods = { sales: 0n, costs: 0n, base: 0n, vat: 0n, found: false };
  for (const entry of entries) {
    if (isTravelMarginCode(entry.code)) {
      travel.found = true;
      travel.sales += parseMoney(entry.attributes.sales ?? '0', 'RON');
      travel.costs += parseMoney(entry.attributes.costs ?? '0', 'RON');
      travel.base += entry.baseBani;
      travel.vat += entry.taxBani;
      continue;
    }
    const type: 'LS' | 'AS' | null =
      entry.code === schemeCodes.travelSale || isGoodsMarginCode(entry.code)
        ? 'LS'
        : entry.code === schemeCodes.travelPurchase || entry.code === schemeCodes.goodsPurchase
          ? 'AS'
          : null;
    if (!type) continue;
    // A supply's value is its price as invoiced: an item's price, a single service's base.
    const bani = isGoodsMarginCode(entry.code)
      ? parseMoney(entry.attributes.price ?? '0', 'RON')
      : entry.baseBani;
    if (isGoodsMarginCode(entry.code)) {
      goods.found = true;
      goods.sales += bani;
      goods.costs += parseMoney(entry.attributes.cost ?? '0', 'RON');
      goods.base += entry.baseBani;
      goods.vat += entry.taxBani;
    }
    const found = partnerOf(entry, names(entry), details(entry), problems);
    if (!found) continue;
    if (type === 'AS' && found.partner.kind !== 'registered') {
      problems.push({
        code: 'D394_OPERATION',
        message: `Achiziția în regimul marjei ${entry.attributes.number ?? entry.documentId} este de la un partener fără cod de TVA: o achiziție de tip AS este de la o persoană înregistrată care aplică regimul.`,
      });
      continue;
    }
    const key = `${type}|${found.key}`;
    const group = groups.get(key) ?? {
      type,
      partner: found.partner,
      documents: new Map<string, bigint>(),
      bani: 0n,
    };
    const document = entry.documentId ?? `${entry.entryId}`;
    group.documents.set(document, (group.documents.get(document) ?? 0n) + bani);
    group.bani += bani;
    groups.set(key, group);
  }
  const operations: D394Operation[] = [...groups.values()].flatMap((group) => {
    const invoices = [...group.documents.values()].filter((bani) => bani !== 0n).length;
    return invoices || group.bani !== 0n
      ? [
          {
            type: group.type,
            rate: '0' as const,
            partner: group.partner,
            invoices,
            base: Number(roundToLeu(group.bani)),
            vat: 0,
          },
        ]
      : [];
  });
  const whole = (bani: bigint) => Number(roundToLeu(bani));
  // A period whose sales a storno cancelled has no margins to report.
  for (const held of [travel, goods])
    held.found &&= [held.sales, held.costs, held.base, held.vat].some((bani) => bani !== 0n);
  return {
    operations,
    margins: {
      ...(travel.found
        ? {
            travel: {
              receipts: whole(travel.sales),
              costs: whole(travel.costs),
              margin: whole(travel.base),
              vat: whole(travel.vat),
            },
          }
        : {}),
      ...(goods.found
        ? {
            goods: {
              sales: whole(goods.sales),
              purchases: whole(goods.costs),
              // pct. 6.2: the margin is the sale price less the purchase price, VAT included,
              // where pct. 6.1 asks the travel agency for the margin without VAT.
              margin: whole(goods.sales - goods.costs),
              vat: whole(goods.vat),
            },
          }
        : {}),
    },
  };
}

// Issuing (sales.issue).

/** A sale under a margin scheme, issued without VAT and with the scheme's mention (art. 311
 * alin. (8), art. 312 alin. (12), art. 319 alin. (20) lit. n)–o)): a travel agency's single
 * service, or a dealer's items, each named by its purchase document with its price. */
export const marginIssue = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('travel') }).strict(),
  z
    .object({
      scheme: z.literal('goods'),
      items: z
        .array(
          z
            .object({
              purchaseDocumentId: z.uuid(),
              price: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);
export type MarginIssue = z.infer<typeof marginIssue>;

/** What a margin-scheme invoice must hold: every line in category E without VAT, the scheme's
 * mention on the breakdown's reason, a company registered for VAT, lei, and for goods the items'
 * prices adding up to the invoice. */
export function marginIssueProblems(
  input: {
    margin?: MarginIssue;
    typeCode: string;
    currency: string;
    notes: readonly string[];
    lines: readonly { vat: { category: string; rate?: string; exemptionReason?: string } }[];
    adjustments: readonly { vat: { category: string; rate?: string; exemptionReason?: string } }[];
  },
  invoice: { totals: { payable: string } },
  status: string | null,
): { code: string; message: string }[] {
  const margin = input.margin;
  if (!margin) return [];
  const problems: { code: string; message: string }[] = [];
  const vats = [
    ...input.lines.map((line) => line.vat),
    ...input.adjustments.map((item) => item.vat),
  ];
  if (input.typeCode !== '380')
    problems.push({
      code: 'MARGIN_CREDIT',
      message: 'Notele de credit în regimul marjei nu sunt încă acoperite.',
    });
  if (status !== 'normal_vat')
    problems.push({
      code: 'MARGIN_NOT_REGISTERED',
      message: 'Regimul marjei îl aplică o companie înregistrată în scopuri de TVA.',
    });
  if (input.currency !== 'RON')
    problems.push({
      code: 'MARGIN_CURRENCY',
      message: 'Facturile în regimul marjei în valută nu sunt încă acoperite.',
    });
  if (vats.some((vat) => vat.category !== 'E' || Number(vat.rate ?? '0') !== 0))
    problems.push({
      code: 'MARGIN_LINES',
      message:
        'O factură în regimul marjei are toate liniile în categoria E, fără TVA înscrisă (art. 311 alin. (8), art. 312 alin. (12)).',
    });
  const kinds =
    margin.scheme === 'travel'
      ? [schemeMentions.travel]
      : [
          schemeMentions.second_hand,
          schemeMentions.works_of_art,
          schemeMentions.collectibles_antiques,
        ];
  const said = (text: string | undefined) =>
    !!text && kinds.some((mention) => folded(text).includes(folded(mention)));
  if (!vats.every((vat) => said(vat.exemptionReason)))
    problems.push({
      code: 'MARGIN_MENTION',
      message: `Înscrieți mențiunea ${kinds.map((mention) => `„${mention}”`).join(' sau ')} ca motiv al scutirii (BT-120) fiecărei linii (art. 319 alin. (20) lit. ${margin.scheme === 'travel' ? 'n' : 'o'})).`,
    });
  if (margin.scheme === 'goods') {
    const priced = margin.items.reduce((sum, item) => sum + parseMoney(item.price, 'RON'), 0n);
    if (priced !== parseMoney(invoice.totals.payable, 'RON'))
      problems.push({
        code: 'MARGIN_ITEMS',
        message: `Prețurile bunurilor însumează ${money(priced)} lei; factura are de plată ${invoice.totals.payable} lei.`,
      });
  }
  return problems;
}

/** The recognition `sales.issue` proposes for a margin-scheme invoice. */
export const marginRecognition = (margin: MarginIssue, documentId: string, account: string) =>
  margin.scheme === 'travel'
    ? { documentId, scheme: 'travel' as const, account }
    : {
        documentId,
        scheme: 'goods' as const,
        regime: 'margin' as const,
        account,
        costAccount: '607',
        items: margin.items,
      };
