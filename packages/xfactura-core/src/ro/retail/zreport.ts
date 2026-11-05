import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { allocate, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { Amount } from '../../values';
import {
  invoiceStockQuery,
  issueInvoiceStock,
  type InvoiceStock,
  type StockResult,
} from '../stock/invoices';
import { retailAccountsOf, retailSynthetics, retailTag, retailWarehouse } from './accounts';
import { zReportDocumentSchema, zReportKind, type ZReportDocument } from './documents';
import type { ZReportRule } from './parameters';
import { zGoodsAnswerOf } from './questions';

/*
 * A fiscal cash register's day, from its Z report (OUG nr. 28/1999 art. 4 alin. (6)–(7)): what
 * the day collected by each means of payment (cash on 531x, cards in transit on 5125 until the
 * acquirer settles them, tickets on 5328), the revenue and the VAT collected by rate, and the
 * goods that left: at the stock register's value by item (G1) when the report or a person names
 * them, at their sale price from a warehouse kept at retail price, or nothing at a company on the
 * intermittent inventory. The day's sales need no invoice (Codul fiscal art. 319 alin. (10) lit.
 * a)); their VAT is D300's at its rate, D394's op2 by month, SAF-T's 3803xx.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
export const ZREPORT_CLAUSES = [
  'OUG28/1999:art.4(5)-(9)',
  'OPANAF146/2018:anexa2.II.7',
  `${CODE}:art.319(10)(a)`,
];

const block = (
  code: string,
  message: string,
  path?: string,
  details?: Issue['details'],
): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const rateText = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const analytic = (synthetic: string) =>
  z.string().regex(new RegExp(`^${synthetic}(\\.[A-Z0-9_-]{1,24})?$`));

export const zReportBookingInput = z
  .object({
    documentId: z.uuid(),
    /** The cash desk the day's cash goes to. */
    cash: analytic('5311'),
    /** Card payments in transit until the acquirer's settlement (5125, `ro.retail.zreport`). */
    card: z.string().regex(accountCodePattern).optional(),
    /** Meal and value tickets received (5328, `ro.retail.zreport`). */
    tickets: z.string().regex(accountCodePattern).optional(),
    /** Every rate's sales on one revenue account (70x). */
    account: z.string().regex(accountCodePattern).optional(),
    /** Or each rate's sales, VAT included, split over revenue accounts (goods on 707, services
     * on 704, …). */
    allocations: z
      .array(
        z
          .object({ rate: rateText, account: z.string().regex(accountCodePattern), amount: money })
          .strict(),
      )
      .min(1)
      .max(40)
      .optional(),
    /** Goods kept by quantity at cost (G1): each article line of the report (by position from 1)
     * with its catalogue item, out of a warehouse. */
    stock: z
      .object({
        warehouseId: z.uuid(),
        lines: z
          .array(z.object({ line: z.string().regex(/^\d{1,4}$/), itemId: z.uuid() }).strict())
          .min(1)
          .max(2000),
      })
      .strict()
      .optional(),
    /** Goods kept at their retail price: the sales on 707 leave this warehouse at sale price. */
    goods: z.object({ warehouseId: z.uuid() }).strict().optional(),
  })
  .strict()
  .refine((input) => (input.account === undefined) !== (input.allocations === undefined), {
    message: 'Indicați fie contul de venituri, fie repartizarea pe conturi (allocations).',
  })
  .refine((input) => !(input.stock && input.goods), {
    message:
      'Mărfurile ies fie din gestiunea pe articole (stock), fie din cea la preț cu amănuntul (goods).',
  });
export type ZReportInput = z.infer<typeof zReportBookingInput>;

function zReportOf(loaded: Loaded, id: string): { body: ZReportDocument } | Issue {
  const record = loaded.documents.get(id);
  if (!record) return block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId');
  if (record.kind !== zReportKind)
    return block(
      'DOCUMENT_KIND',
      'Tratamentul înregistrează rapoartele Z ale caselor de marcat (zreport).',
      'documentId',
    );
  return { body: zReportDocumentSchema.parse(record.body) };
}

/** The goods the day sold out of the stock register: the report's articles, or the answer. */
function stockOf(input: ZReportInput, loaded: Loaded, body: ZReportDocument) {
  if (input.stock)
    return {
      stock: {
        warehouseId: input.stock.warehouseId,
        lines: input.stock.lines.map((row) => ({
          line: row.line,
          itemId: row.itemId,
          quantity: body.items[Number(row.line) - 1]?.quantity ?? '0',
        })),
      } satisfies InvoiceStock,
      lines: body.items.map((item, index) => ({
        id: String(index + 1),
        key: `S-${item.rate}`,
        net: ron(item.gross.replace(/^-/, '')),
      })),
    };
  const answer = zGoodsAnswerOf(loaded, input.documentId);
  if (!answer) return null;
  return {
    stock: {
      warehouseId: answer.value.warehouseId,
      lines: answer.value.lines.map((row, index) => ({
        line: String(index + 1),
        itemId: row.itemId,
        quantity: row.quantity,
      })),
    } satisfies InvoiceStock,
    lines: answer.value.lines.map((_, index) => ({ id: String(index + 1), key: 'S', net: 0n })),
    answer,
  };
}

function param<T>(rules: RuleContext, key: string, date: LocalDate, issues: Issue[]): T | null {
  try {
    return rules.param<T>(key, 'accounting_transaction_date', date);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return null;
  }
}

/** Each rate standard or reduced on the day (the reduced confirmed, art. 291 alin. (2)). */
function rateIssues(rates: readonly string[], rules: RuleContext, date: LocalDate): Issue[] {
  const issues: Issue[] = [];
  const read = (key: string, scope?: Record<string, string>) => {
    try {
      return rules.param<string>(key, 'vat_chargeability_date', date, scope);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message));
      return null;
    }
  };
  const taxed = rates.filter((rate) => !new Amount(rate).isZero());
  if (!taxed.length) return issues;
  const standard = read('ro.vat.rate', { category: 'S' });
  const other = taxed.filter((rate) => rate !== standard);
  if (!other.length || standard === null) return issues;
  const reduced = read('ro.vat.rate.reduced');
  for (const rate of new Set(other))
    issues.push(
      rate === reduced
        ? ack(
            'REDUCED_RATE',
            `Cota redusă de ${reduced}% se aplică doar livrărilor și prestărilor de la art. 291 alin. (2) din Codul fiscal: confirmați că vânzările zilei la această cotă se încadrează.`,
          )
        : block(
            'VAT_RATE',
            `Cota ${rate}% din raportul Z diferă de cotele în vigoare la ${date} (${standard}%${reduced ? `, ${reduced}%` : ''}).`,
          ),
    );
  return issues;
}

/**
 * Books a register's day from its Z report: Dr the means of payment / Cr the revenue and the VAT
 * collected, by rate; the goods sold out of the stock register or the warehouse at retail price.
 */
export const zReportRecognition: Treatment<ZReportInput> = {
  id: 'retail.zReport',
  version: 1,
  description:
    'Raportul Z al unei case de marcat: încasările pe mijloace de plată (casa, cardurile în curs de decontare, tichetele), veniturile și TVA colectată pe cote și descărcarea gestiunii.',
  input: zReportBookingInput,
  agent: true,
  summary:
    "A cash register's Z report: the day's takings by means of payment (cash, cards in transit on 5125, tickets), revenue and VAT by rate, and the goods leaving stock.",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId],
    profile: true,
    ...(input.stock
      ? {
          stock: invoiceStockQuery({
            warehouseId: input.stock.warehouseId,
            lines: input.stock.lines.map((row) => ({
              line: row.line,
              itemId: row.itemId,
              quantity: '1',
            })),
          }),
        }
      : input.goods
        ? { stock: { warehouses: [input.goods.warehouseId] } }
        : // Neither: a person's answer may name the goods (`retail.goods`), which the plan cannot
          // know of, so the whole register is read (nothing, for a company that never moved
          // stock).
          { stock: { all: true, catalogue: true } }),
  }),
  evaluate(input, loaded, rules) {
    const found = zReportOf(loaded, input.documentId);
    if ('code' in found) return { effect: null, issues: [found] };
    const body = found.body;
    const issues: Issue[] = [];
    const date = body.issueDate as LocalDate;
    const taxPeriod = vatPeriodOf(loaded, date);
    const rule = param<ZReportRule>(rules, 'ro.retail.zreport', date, issues);
    if (
      body.currency !== LEDGER_CURRENCY ||
      body.payments.some((row) => row.currency !== LEDGER_CURRENCY)
    )
      issues.push(
        block(
          'CURRENCY',
          'Rapoartele Z în altă monedă decât leul (sau cu plăți în valută) nu sunt încă acoperite.',
        ),
      );
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
    if (status === 'normal_vat' && profileAt(loaded, 'vat.cash', date) === 'yes')
      issues.push(
        block(
          'ZREPORT_CASH_VAT',
          'UNSUPPORTED: rapoartele Z ale unei companii în sistemul TVA la încasare nu sunt încă acoperite.',
        ),
      );
    const taxes = body.taxes
      .filter((row) => ron(row.gross) !== 0n || ron(row.tax) !== 0n)
      .map((row) => ({ rate: row.rate, gross: ron(row.gross), tax: ron(row.tax) }));
    const exempt =
      ron(body.exempt) +
      taxes
        .filter((row) => new Amount(row.rate).isZero())
        .reduce((sum, row) => sum + row.gross, 0n);
    if (status === 'normal_vat' && exempt !== 0n)
      issues.push(
        block(
          'ZREPORT_EXEMPT',
          `UNSUPPORTED: raportul are operațiuni scutite de TVA (${lei(exempt)} lei); temeiul scutirii vânzărilor cu amănuntul nu este încă acoperit.`,
        ),
      );
    if (
      status === 'non_vat' &&
      taxes.some((row) => row.tax !== 0n || !new Amount(row.rate).isZero())
    )
      issues.push(
        block('TAX_CATEGORY', 'Un neplătitor de TVA vinde fără TVA: raportul Z are TVA la o cotă.'),
      );
    if (ron(body.otherTaxes) !== 0n)
      issues.push(
        block(
          'ZREPORT_OTHER_TAXES',
          `UNSUPPORTED: raportul are sume în afara bazei de impozitare a TVA (${body.otherTaxes} lei, de exemplu garanția sistemului de returnare): nu sunt încă acoperite.`,
        ),
      );
    if (status === 'normal_vat')
      issues.push(
        ...rateIssues(
          taxes.map((row) => row.rate),
          rules,
          date,
        ),
      );

    // The revenue parts: one account for every rate, or the allocations. A non-payer's day is
    // one amount without VAT (rate 0).
    const rates =
      status === 'non_vat'
        ? ron(body.totals.gross)
          ? [{ rate: '0', gross: ron(body.totals.gross), tax: 0n }]
          : []
        : taxes.filter((row) => !new Amount(row.rate).isZero());
    type Part = { rate: string; account: string; gross: bigint; path: string };
    const parts: Part[] = input.allocations
      ? input.allocations.map((part, index) => ({
          rate: new Amount(part.rate).toString(),
          account: part.account,
          gross: ron(part.amount),
          path: `allocations.${index}`,
        }))
      : rates.map((row) => ({
          rate: row.rate,
          account: input.account!,
          gross: row.gross,
          path: 'account',
        }));
    for (const part of parts)
      if (!/^70\d/.test(part.account))
        issues.push(block('ACCOUNT', 'Folosiți un cont de venituri (70x).', part.path));
    if (input.allocations) {
      for (const part of parts)
        if (!rates.some((row) => row.rate === part.rate))
          issues.push(
            block('ALLOCATION', `Raportul nu are vânzări la cota ${part.rate}%.`, part.path),
          );
      for (const row of rates) {
        const allocated = parts
          .filter((part) => part.rate === row.rate)
          .reduce((sum, part) => sum + part.gross, 0n);
        if (allocated !== row.gross)
          issues.push(
            block(
              'ALLOCATION',
              `Cota ${row.rate}% totalizează ${lei(row.gross)} lei în raport; repartizarea însumează ${lei(allocated)} lei.`,
              'allocations',
            ),
          );
      }
    }

    // The means of payment.
    const paid = new Map<string, bigint>();
    for (const payment of body.payments)
      paid.set(payment.method, (paid.get(payment.method) ?? 0n) + ron(payment.amount));
    if (rule)
      for (const method of rule.unsupported)
        if ((paid.get(method) ?? 0n) !== 0n)
          issues.push(
            block(
              'ZREPORT_PAYMENT',
              `UNSUPPORTED: încasările prin ${paymentNames[method] ?? method} (${lei(paid.get(method)!)} lei) nu sunt încă acoperite.`,
              undefined,
              { method },
            ),
          );
    const cardTotal = paid.get('card') ?? 0n;
    const ticketTotal = (paid.get('mealTickets') ?? 0n) + (paid.get('valueTickets') ?? 0n);
    if (cardTotal && !input.card)
      issues.push(
        block(
          'ZREPORT_CARD',
          'Încasările cu cardul se înregistrează în contul sumelor în curs de decontare (card).',
          'card',
        ),
      );
    if (rule && input.card && !input.card.startsWith(rule.card))
      issues.push(
        block('ZREPORT_CARD', `Încasările cu cardul se înregistrează în ${rule.card}.`, 'card'),
      );
    if (ticketTotal && !input.tickets)
      issues.push(
        block(
          'ZREPORT_TICKETS',
          'Tichetele primite se înregistrează în contul lor (tickets).',
          'tickets',
        ),
      );
    if (rule && input.tickets && !input.tickets.startsWith(rule.tickets))
      issues.push(
        block(
          'ZREPORT_TICKETS',
          `Tichetele primite se înregistrează în ${rule.tickets}.`,
          'tickets',
        ),
      );
    if (ticketTotal)
      issues.push(
        ack(
          'ZREPORT_TICKETS',
          `Tichetele primite în plată (${lei(ticketTotal)} lei) rămân în 5328 până le decontează emitentul; funcțiunea contului 532 numește tichetele achiziționate: confirmați înregistrarea (lectura e la expert, ro.retail.zreport).`,
        ),
      );

    // The goods.
    const retail = profileAt(loaded, 'policy.stock.retail', date);
    const inventory = profileAt(loaded, 'policy.stock.inventory', date);
    const goodsParts = parts.filter((part) => part.account.startsWith('707'));
    let stock: StockResult | null = null;
    let fromAnswer: ReturnType<typeof stockOf> = null;
    if (input.goods && retail !== 'retail')
      issues.push(
        block(
          'RETAIL_POLICY',
          'Mărfurile nu se țin la preț cu amănuntul (policy.stock.retail): descărcarea se face din gestiunea pe articole.',
          'goods',
        ),
      );
    if (input.stock && retail === 'retail')
      issues.push(
        block(
          'RETAIL_POLICY',
          'Mărfurile se țin la preț cu amănuntul (policy.stock.retail): descărcarea se face din gestiunea la preț de vânzare (goods).',
          'stock',
        ),
      );
    if (goodsParts.length && !input.goods && !input.stock) {
      if (retail === 'retail')
        issues.push(
          block(
            'RETAIL_WAREHOUSE',
            'Indicați gestiunea la preț cu amănuntul din care au ieșit mărfurile vândute (goods.warehouseId).',
            'goods',
          ),
        );
      else if (!inventory || (!retail && inventory === 'permanent'))
        issues.push(
          questionIssue(
            'POLICY_MISSING',
            !inventory
              ? 'Înregistrați metoda de evidență a stocurilor (policy.stock.inventory): de ea depinde descărcarea gestiunii la vânzare.'
              : 'Înregistrați dacă mărfurile se țin la cost sau la preț cu amănuntul (policy.stock.retail).',
            {
              kind: 'profile.fact',
              subject: {
                kind: 'profile',
                id: !inventory ? 'policy.stock.inventory' : 'policy.stock.retail',
              },
              params: {
                axis: !inventory ? 'policy.stock.inventory' : 'policy.stock.retail',
                from: date,
              },
            },
          ),
        );
      else if (inventory === 'permanent') {
        fromAnswer = stockOf(input, loaded, body);
        if (!fromAnswer)
          issues.push(
            questionIssue(
              'ZREPORT_GOODS',
              body.items.length
                ? 'Raportul are articolele vândute: indicați articolul din nomenclator al fiecăreia (stock).'
                : 'Raportul Z are doar totaluri: ce mărfuri au ieșit din gestiune? Întrebați (retail.goods) și revizuiți propunerea citând răspunsul, sau indicați articolele raportului (stock).',
              {
                kind: 'retail.goods',
                subject: { kind: 'document', id: input.documentId },
                params: { date },
              },
            ),
          );
      } else
        issues.push({
          code: 'ZREPORT_INTERMITTENT',
          severity: 'info',
          message:
            'Cu inventarul intermitent, mărfurile vândute nu se descarcă la vânzare: stocul se stabilește la inventariere.',
        });
    }
    if (input.stock && body.items.length === 0)
      issues.push(
        block(
          'ZREPORT_ITEMS',
          'Raportul nu are articole: mărfurile vândute se indică prin răspunsul retail.goods.',
          'stock',
        ),
      );
    if (input.stock)
      input.stock.lines.forEach((row, index) => {
        if (!body.items[Number(row.line) - 1])
          issues.push(
            block(
              'ZREPORT_ITEMS',
              `Raportul nu are articolul ${row.line}.`,
              `stock.lines.${index}.line`,
            ),
          );
      });
    const retailWarehouseRecord = input.goods
      ? retailWarehouse(loaded.warehouses, input.goods.warehouseId, 'goods.warehouseId')
      : null;
    if (retailWarehouseRecord && 'severity' in retailWarehouseRecord)
      issues.push(retailWarehouseRecord);
    if (input.goods && inventory === 'intermittent')
      issues.push(
        block(
          'RETAIL_INTERMITTENT',
          'Metoda prețului cu amănuntul (global-valorică) nu se aplică cu inventarul intermitent (OMFP 1802/2014 pct. 291 alin. (5)).',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // Revenue and VAT by part, cash and the other means by payment.
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const partTax = parts.map(() => 0n);
    for (const row of rates) {
      const members = parts.flatMap((part, index) => (part.rate === row.rate ? [index] : []));
      allocate(
        row.tax,
        members.map((index) => parts[index]!.gross),
      ).forEach((value, i) => (partTax[members[i]!] = value));
    }
    parts.forEach((part, index) =>
      lines.push({ account: part.account, side: 'C', bani: part.gross - partTax[index]! }),
    );
    if (status === 'normal_vat')
      for (const row of rates) {
        lines.push({ account: '4427', side: 'C', bani: row.tax });
        const code = `S-${row.rate}`;
        taxEntries.push({
          key: rates.length === 1 ? 'vat' : `vat:${code}`,
          tax: 'VAT',
          code,
          direction: 'output',
          baseBani: row.gross - row.tax,
          taxBani: row.tax,
          deductibleBani: 0n,
          line: lines.length - 1,
          ledgerBani: row.tax,
          taxPoint: date,
          exigibility: date,
          taxPeriod,
          documentId: input.documentId,
          attributes: {
            documentType: 'zreport',
            register: body.register,
            number: body.number,
            receipts: String(body.receipts),
          },
        });
      }
    const cashTotal = paid.get('cash') ?? 0n;
    if (cashTotal)
      lines.push({ account: input.cash, side: 'D', bani: cashTotal, memo: `Z ${body.number}` });
    if (cardTotal)
      lines.push({
        account: input.card!,
        side: 'D',
        bani: cardTotal,
        analytics: { item: `zreport:${input.documentId}` },
        memo: `Carduri Z ${body.number} ${body.register}`,
      });
    if (ticketTotal)
      lines.push({
        account: input.tickets!,
        side: 'D',
        bani: ticketTotal,
        memo: `Tichete Z ${body.number}`,
      });

    // The goods sold: out of the register by item, or out of the warehouse at sale price.
    if (fromAnswer || input.stock) {
      const source = fromAnswer ?? stockOf(input, loaded, body)!;
      stock = issueInvoiceStock({
        stock: source.stock,
        loaded,
        rules,
        date,
        invoiceLines: source.lines,
        lines,
      });
      issues.push(...stock.issues);
    }
    if (input.goods && retailWarehouseRecord && !('severity' in retailWarehouseRecord)) {
      const synthetics = retailSynthetics(rules, date);
      const byRate = new Map<string, bigint>();
      for (const part of goodsParts)
        byRate.set(part.rate, (byRate.get(part.rate) ?? 0n) + part.gross);
      for (const [rate, gross] of byRate) {
        const accounts = retailAccountsOf(synthetics, retailWarehouseRecord.code, rate);
        lines.push({
          account: accounts.goods,
          side: 'C',
          bani: gross,
          analytics: { item: retailTag(retailWarehouseRecord.id) },
          memo: `Descărcare Z ${body.number}`,
        });
        lines.push({
          account: '607',
          side: 'D',
          bani: gross,
          memo: `Descărcare la preț de vânzare Z ${body.number}`,
        });
      }
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'general',
      journalCode: 'VANZARI',
      description: `Raport Z ${body.number} casa ${body.register}`.slice(0, 500),
      lines,
      openItems: [...(stock?.openItems ?? [])],
      taxEntries,
      schedules: [],
      ...(stock?.book ? stock.book.effectPart() : {}),
      explanation: {
        summary: `Raportul Z ${body.number} al casei ${body.register} din ${body.issueDate}: ${body.receipts} bonuri, ${body.totals.gross} lei, TVA ${body.totals.tax} lei; numerar ${lei(cashTotal)}, card ${lei(cardTotal)}${ticketTotal ? `, tichete ${lei(ticketTotal)}` : ''}.`,
        details: {
          register: body.register,
          number: body.number,
          receipts: body.receipts,
          payments: Object.fromEntries([...paid].map(([method, bani]) => [method, lei(bani)])),
          ...(body.cumulative ? { cumulative: body.cumulative.gross } : {}),
          ...(stock ? { stock: stock.details } : {}),
          ...(fromAnswer && 'answer' in fromAnswer && fromAnswer.answer
            ? {
                goodsAnswer: {
                  questionId: fromAnswer.answer.record.questionId,
                  answerId: fromAnswer.answer.record.answerId,
                },
              }
            : {}),
          ...(input.goods ? { retailWarehouse: input.goods.warehouseId } : {}),
          clauses: ZREPORT_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};

const paymentNames: Record<string, string> = {
  cashAdvance: 'avans în numerar',
  voucher: 'voucher',
  credit: 'credit',
  modern: 'metode moderne de plată',
  other: 'alte metode',
};
