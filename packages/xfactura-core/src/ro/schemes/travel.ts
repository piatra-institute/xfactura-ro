import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type Loaded,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { questionIssue } from '../../questions/kinds';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { invoiceKinds } from '../treatments/invoices';
import { vatPeriodEnd } from '../treatments/vat-settlement';
import {
  block,
  isTravelMarginCode,
  lei,
  marginRates,
  marginVat,
  ron,
  schemeCodes,
  TRAVEL_CLAUSES,
  warn,
} from './margin';

/*
 * The VAT of a travel agency's single services (Codul fiscal art. 311), computed per fiscal
 * period as the norms say (pct. 85 alin. (4)): from the sales journal of the single services
 * supplied in the period (their prices, the travellers paying no VAT shown) and the purchase
 * journal of their costs (the price, VAT included, of what other taxable persons supplied for the
 * traveller's direct benefit), the margin of the period is the sales less the costs, and its VAT
 * is the margin × the standard rate ÷ (100 + the rate). Advances whose costs are not yet known and
 * costs of services not sold are left out (lit. c)): a trip enters the period it is supplied in,
 * with every sale and cost of it. The costs' VAT is not deducted (art. 311 alin. (6)): a cost
 * booked with a deduction is refused. Trips outside the Union (alin. (5)) and a period's negative
 * margin, which the texts do not settle, are UNSUPPORTED.
 */

const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const day = z.string().refine((value) => isLocalDate(value), 'Dată invalidă.');

export const travelMarginInput = z
  .object({
    /** The VAT period, a month or a quarter (`2026-Q4`). */
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
    /** A later computation of the same period, for trips added after the first was posted. */
    round: z.number().int().min(1).max(99).default(1),
    /** The posting date, in the period (its last day, usually). */
    date: day,
    /** The revenue account the single services were sold on (704): the margin's VAT comes out
     * of it, the travellers having paid it within the price. */
    account: z.string().regex(accountCodePattern),
    /** The period's computation (situația de calcul) with its sales and purchase journals. */
    evidenceId: z.uuid(),
    trips: z
      .array(
        z
          .object({
            /** The trip or package, as the contract or voucher names it. */
            reference: z.string().trim().min(1).max(100),
            /** The day the single service was supplied (the trip's last day). */
            supplied: day,
            /** Where the goods and services bought for the traveller were supplied: inside the
             * Union, outside it, or both (art. 311 alin. (5)). */
            place: z.enum(['eu', 'outside_eu', 'mixed']),
            /** The sales of the trip under the scheme (`margin.sale`, travel): every invoice its
             * travellers were issued, advances included. */
            sales: z.array(z.uuid()).min(1).max(50),
            /** The costs bought for the traveller's direct benefit: each purchase invoice, with
             * the part of its total (VAT included) the trip bears when the invoice serves several. */
            costs: z
              .array(z.object({ documentId: z.uuid(), amount: amount.optional() }).strict())
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type TravelMarginInput = z.infer<typeof travelMarginInput>;

/** The first day of a VAT period. */
export function periodStart(period: string): LocalDate {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter)
    return `${quarter[1]}-${String(Number(quarter[2]) * 3 - 2).padStart(2, '0')}-01` as LocalDate;
  return `${period}-01` as LocalDate;
}

/** The VAT periods whose ledgers may hold an earlier computation using a document: every month
 * and quarter of the period's year and the year before. */
export function earlierPeriods(period: string): string[] {
  const year = Number(period.slice(0, 4));
  return [year - 1, year].flatMap((y) => [
    ...Array.from({ length: 12 }, (_, index) => `${y}-${String(index + 1).padStart(2, '0')}`),
    ...[1, 2, 3, 4].map((quarter) => `${y}-Q${quarter}`),
  ]);
}

/** The documents a posted computation counted, net of its reversals, from the ledgers read. */
export function documentsCounted(loaded: Loaded, periods: readonly string[]): Map<string, string> {
  const weights = new Map<string, { weight: number; period: string }>();
  for (const period of periods)
    for (const entry of loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []) {
      if (!isTravelMarginCode(entry.code) || !entry.attributes.documents) continue;
      const sign = entry.originTaxEntry ? -1 : 1;
      for (const id of entry.attributes.documents.split(',')) {
        const held = weights.get(id) ?? { weight: 0, period: entry.attributes.period ?? period };
        held.weight += sign;
        weights.set(id, held);
      }
    }
  return new Map(
    [...weights].filter(([, held]) => held.weight > 0).map(([id, held]) => [id, held.period]),
  );
}

const allDocuments = (input: TravelMarginInput) =>
  input.trips.flatMap((trip) => [...trip.sales, ...trip.costs.map((cost) => cost.documentId)]);

/**
 * The VAT of the single services a travel agency supplied in a period, on their margin: Dr the
 * revenue account / Cr 4427, tax entry `MS-311-<rate>` (D300 rd. 9) carrying the period's sales,
 * costs and margin (D394's informatii) and the documents counted, so none counts twice.
 */
export const travelMargin: Treatment<TravelMarginInput> = {
  id: 'margin.travel',
  version: 1,
  description:
    'TVA aferentă marjei agenției de turism pentru serviciile unice prestate într-o perioadă fiscală (art. 311 din Codul fiscal, norme pct. 85 alin. (4)): vânzările serviciilor unice minus costurile lor cu TVA, prin procedeul sutei mărite la cota standard.',
  input: travelMarginInput,
  agent: true,
  summary:
    "A travel agency's VAT on the margin of the single services supplied in a VAT period: the travellers' prices less the costs bought for them (VAT included), taxed by the hundred-plus method at the standard rate.",
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `margin.travel:${input.period}:${input.round}`,
  plan: (input) => {
    const documents = [...new Set(allDocuments(input))];
    return {
      documents,
      evidence: [input.evidenceId],
      profile: true,
      openItems: documents.map((documentId) => ({ documentId, origins: true })),
      taxPeriods: earlierPeriods(input.period).map((period) => ({ tax: 'VAT', period })),
    };
  },
  followUp(input, loaded) {
    // The bookings of the costs, whose tax entries show whether their VAT was deducted.
    const costs = new Set(input.trips.flatMap((trip) => trip.costs.map((cost) => cost.documentId)));
    const entries = [...loaded.openItems.values()]
      .filter((item) => item.documentId && costs.has(item.documentId))
      .map((item) => item.originEntryId);
    return entries.length ? { entries: [...new Set(entries)] } : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const date = input.date as LocalDate;
    const start = periodStart(input.period);
    const end = vatPeriodEnd(input.period);
    if (date < start || date > end || vatPeriodOf(loaded, date) !== input.period)
      issues.push(
        block(
          'PERIOD',
          `Data ${date} nu este în perioada fiscală ${input.period} a companiei (${vatPeriodOf(loaded, date)}).`,
          'date',
        ),
      );
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Situația de calcul nu este disponibilă.', 'evidenceId'));
    if (!input.account.startsWith('70'))
      issues.push(
        block('ACCOUNT', 'Folosiți contul de venituri al serviciilor unice (70x).', 'account'),
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
    else if (status !== 'normal_vat')
      issues.push(
        block(
          'MARGIN_NOT_REGISTERED',
          'Compania nu este înregistrată în scopuri de TVA: regimul special al agențiilor de turism îl aplică persoanele care colectează TVA.',
        ),
      );
    const rates = marginRates(rules, 'ro.vat.margin.travel', date, issues);

    // Each document once, in this computation and across the posted ones.
    const counted = documentsCounted(loaded, earlierPeriods(input.period));
    const seen = new Set<string>();
    const origins = new Map<string, string[]>();
    for (const item of loaded.openItems.values())
      if (item.documentId && item.origin)
        origins.set(item.documentId, [
          ...(origins.get(item.documentId) ?? []),
          item.origin.treatmentId,
        ]);
    const bookings = [...loaded.entries.values()];
    let sales = 0n;
    let costs = 0n;
    const trips = input.trips.map((trip, index) => {
      const path = `trips.${index}`;
      if (trip.supplied < start || trip.supplied > end)
        issues.push(
          block(
            'TRAVEL_SUPPLIED',
            `Călătoria ${trip.reference} este prestată la ${trip.supplied}, în afara perioadei ${input.period}: intră în perioada în care se prestează serviciul unic (norme pct. 85 alin. (4) lit. c)).`,
            `${path}.supplied`,
          ),
        );
      if (trip.place !== 'eu')
        issues.push(
          block(
            'TRAVEL_OUTSIDE_EU',
            `Călătoria ${trip.reference} are servicii realizate în afara Uniunii: partea lor este scutită ca serviciu de intermediar (art. 311 alin. (5)), caz neacoperit încă.`,
            `${path}.place`,
            { clauses: TRAVEL_CLAUSES },
          ),
        );
      if (!trip.costs.length)
        issues.push(
          block(
            'TRAVEL_OWN_MEANS',
            `Călătoria ${trip.reference} nu are costuri de la alți furnizori: regimul special nu se aplică serviciilor prestate exclusiv cu mijloace proprii (norme pct. 85 alin. (2)); facturați-le în regim normal.`,
            `${path}.costs`,
          ),
        );
      const documents = [...trip.sales, ...trip.costs.map((cost) => cost.documentId)];
      for (const id of documents) {
        if (seen.has(id))
          issues.push(
            block(
              'TRAVEL_DOCUMENT_TWICE',
              `Documentul ${id} apare de mai multe ori în calcul.`,
              path,
            ),
          );
        seen.add(id);
        const earlier = counted.get(id);
        if (earlier)
          issues.push(
            block(
              'TRAVEL_DOCUMENT_USED',
              `Documentul ${loaded.documents.get(id)?.number ?? id} este cuprins deja în marja perioadei ${earlier}.`,
              path,
            ),
          );
      }
      let tripSales = 0n;
      for (const id of trip.sales) {
        const record = loaded.documents.get(id);
        const body = invoiceDocumentSchema.safeParse(record?.body);
        if (!record || record.kind !== invoiceKinds.sale || !body.success) {
          issues.push(
            block('TRAVEL_SALE', `Documentul ${id} nu este o factură emisă.`, `${path}.sales`),
          );
          continue;
        }
        if (!(origins.get(id) ?? []).includes('margin.sale'))
          issues.push(
            block(
              'TRAVEL_SALE_UNBOOKED',
              `Factura ${record.number ?? id} nu este înregistrată ca vânzare în regimul marjei (margin.sale, travel).`,
              `${path}.sales`,
            ),
          );
        tripSales += ron(body.data.totals.payable);
      }
      let tripCosts = 0n;
      trip.costs.forEach((cost, at) => {
        const record = loaded.documents.get(cost.documentId);
        const body = invoiceDocumentSchema.safeParse(record?.body);
        const costPath = `${path}.costs.${at}`;
        if (!record || record.kind !== invoiceKinds.purchase || !body.success) {
          issues.push(
            block(
              'TRAVEL_COST',
              `Documentul ${cost.documentId} nu este o factură primită.`,
              costPath,
            ),
          );
          return;
        }
        const gross = ron(body.data.totals.payable);
        const part = cost.amount === undefined ? gross : ron(cost.amount);
        if (part > gross || part === 0n)
          issues.push(
            block(
              'TRAVEL_COST',
              `Partea din factura ${record.number ?? record.id} este ${lei(part)} lei; factura are ${lei(gross)} lei.`,
              costPath,
            ),
          );
        const booked = [...loaded.openItems.values()].filter(
          (item) => item.documentId === cost.documentId,
        );
        if (!booked.length)
          issues.push(
            block(
              'TRAVEL_COST_UNBOOKED',
              `Factura ${record.number ?? record.id} nu este înregistrată: costurile serviciului unic se înregistrează întâi (invoices.recognize fără deducere, sau margin.purchase de la o altă agenție).`,
              costPath,
            ),
          );
        const deducted = bookings
          .filter((entry) => booked.some((item) => item.originEntryId === entry.id))
          .flatMap((entry) => entry.taxEntries)
          .filter((entry) => entry.direction === 'input' && entry.deductibleBani !== 0n);
        if (deducted.length)
          issues.push(
            block(
              'TRAVEL_COST_DEDUCTED',
              `TVA facturii ${record.number ?? record.id} este dedusă: agenția nu deduce taxa livrărilor și prestărilor în beneficiul direct al călătorului (art. 311 alin. (6)). Stornați înregistrarea și înregistrați-o fără deducere.`,
              costPath,
              { clauses: TRAVEL_CLAUSES },
            ),
          );
        tripCosts += part;
      });
      sales += tripSales;
      costs += tripCosts;
      return {
        reference: trip.reference,
        supplied: trip.supplied,
        sales: tripSales,
        costs: tripCosts,
      };
    });
    const margin = sales - costs;
    if (rates && margin < 0n)
      issues.push(
        block(
          'TRAVEL_MARGIN_NEGATIVE',
          `Marja perioadei ${input.period} este negativă (${lei(margin)} lei): normele nu spun cum se tratează o marjă negativă a perioadei (o raportare în perioada următoare sau nimic); caz neacoperit, pentru expertul contabil.`,
          'trips',
          { clauses: TRAVEL_CLAUSES },
        ),
      );
    if (margin === 0n)
      issues.push(
        block('NOTHING', `Marja perioadei ${input.period} este zero: nu se colectează TVA.`),
      );
    const negative = trips.filter((trip) => trip.sales < trip.costs);
    if (negative.length)
      issues.push({
        code: 'TRAVEL_TRIP_NEGATIVE',
        severity: 'info',
        message: `Călătoriile ${negative.map((trip) => trip.reference).join(', ')} au marjă negativă: marja se calculează pe serviciile unice ale perioadei, împreună (norme pct. 85 alin. (4) lit. c)).`,
      });
    issues.push(
      warn(
        'TRAVEL_COSTS',
        'Confirmați că fiecare cost este al unei livrări sau prestări în beneficiul direct al călătorului (transport, cazare, masă, asigurarea mijlocului de transport, taxe de viză, de drum și de parcare, combustibil), nu o cheltuială generală a agenției, și că vânzările cuprind tot ce au plătit călătorii pentru serviciul unic (norme pct. 85 alin. (3)).',
        { clauses: TRAVEL_CLAUSES },
      ),
    );
    if (issues.some((issue) => issue.severity === 'block') || !rates)
      return { effect: null, issues };

    const { vat, base } = marginVat(margin, rates.rate);
    const ids = [...seen];
    const entry: TaxEntrySpec = {
      key: 'vat.output',
      tax: 'VAT',
      code: schemeCodes.travel(rates.rate),
      direction: 'output',
      baseBani: base,
      taxBani: vat,
      deductibleBani: 0n,
      ledgerBani: vat,
      line: 1,
      taxPoint: date,
      exigibility: date,
      taxPeriod: input.period,
      attributes: {
        scheme: 'travel',
        period: input.period,
        round: String(input.round),
        sales: lei(sales),
        costs: lei(costs),
        margin: lei(margin),
        trips: String(trips.length),
        documents: ids.join(','),
        evidenceId: input.evidenceId,
      },
    };
    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `TVA marja agenției de turism ${input.period}${input.round > 1 ? ` (${input.round})` : ''}`,
      lines: [
        { account: input.account, side: 'D', bani: vat, memo: `Marja ${input.period}` },
        { account: '4427', side: 'C', bani: vat },
      ],
      openItems: [],
      taxEntries: [entry],
      schedules: [],
      explanation: {
        summary: `${input.period}: ${trips.length} servicii unice prestate, vânzări ${lei(sales)} lei, costuri cu TVA ${lei(costs)} lei, marja ${lei(margin)} lei; TVA ${lei(vat)} lei (${rates.rate} × 100 / ${100 + Number(rates.rate)} din marjă), baza ${lei(base)} lei.`,
        details: {
          period: input.period,
          rate: rates.rate,
          basis: rates.rule.basis,
          trips: trips.map((trip) => ({
            reference: trip.reference,
            supplied: trip.supplied,
            sales: lei(trip.sales),
            costs: lei(trip.costs),
            margin: lei(trip.sales - trip.costs),
          })),
          clauses: TRAVEL_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};
