import { z } from 'zod';
import {
  profileAt,
  vatPeriodOf,
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
import { monthEnd, parseLocalDate as date, type LocalDate, type Month } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';
import { selectRate } from '../fx';
import { obligationDue } from '../obligations';
import { invoiceKinds, taxPointOf } from '../treatments/invoices';
import { creditPartner } from '../treatments/settlement';
import type { DistanceThreshold } from './parameters';
import { memberStateOf, resolveRate } from './rates';

/*
 * A sale to a consumer in another Member State: an intra-community distance sale of goods (Codul
 * fiscal art. 266 alin. (1) pct. 35, art. 275 alin. (2)) or a telecommunications, broadcasting or
 * electronic service (art. 278 alin. (5) lit. h)). Below the threshold of art. 278^1 the place
 * stays in Romania and Romanian VAT applies (D300 rd. 17); above it, or by the option, the place
 * is the customer's state, whose VAT the company declares and pays through the Union scheme
 * (art. 315, form 398) when registered in it. The regime of the tax point is the company's
 * `vat.distance` fact (origin, destination, option) and its registration `vat.oss`; nothing is
 * defaulted.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details ? { details } : {}),
});
const info = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'info',
  message,
  ...(details ? { details } : {}),
});
/** OUG nr. 120/2021 (consolidated to 01.06.2026): B2C invoices with the place in Romania. */
const EFACTURA_B2C_CLAUSES = ['OUG120/2021-A:art.10^1(2)', 'OUG120/2021-A:art.10^1(3)-(4)'];
/** Regulation (EU) No 282/2011: the presumptions and evidence of the customer's place. */
const LOCATION_CLAUSES = [
  `${CODE}:norme.art.278.pct.21(4),(6)`,
  'REG282/2011-A:art.24b',
  'REG282/2011-A:art.24d',
  'REG282/2011-A:art.24f',
];

/** The tax code of a sale declared in the Union scheme: abroad with the right of deduction, as
 * the returns read every `EXP-…` code (art. 297 alin. (4) lit. b)). */
export const ossCode = 'EXP-OSS';

/** What the sale is: goods dispatched to the customer, or a service of art. 278 alin. (5) lit.
 * h). Other services to consumers abroad (immovable property, events, transport…) are not
 * covered. */
export const euConsumerSupplies = [
  'electronic',
  'telecom',
  'broadcasting',
  'distance_goods',
] as const;
export type EuConsumerSupply = (typeof euConsumerSupplies)[number];
export const supplyType = (supply: EuConsumerSupply) =>
  supply === 'distance_goods' ? ('goods' as const) : ('services' as const);

/** The items of evidence of norme pct. 21 alin. (6) for where the customer is. */
export const locationKinds = [
  'billing_address',
  'ip',
  'bank',
  'sim',
  'fixed_line',
  'other',
] as const;

const rate = z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/);
export const euConsumerInput = z
  .object({
    documentId: z.uuid(),
    /** The revenue account (70x). */
    account: z.string().regex(/^70[0-9](\d|\.[A-Z0-9_.-]+)?$/),
    supply: z.enum(euConsumerSupplies),
    /** For a credit note: the sale it corrects. */
    originalDocumentId: z.uuid().optional(),
    /** The tax authority the Union scheme's VAT is owed to (ANAF, a public institution). */
    authorityId: z.uuid().optional(),
    /** For a service: where the customer is, by two items that agree (norme pct. 21 alin. (4)
     * lit. d), (6); Regulation (EU) No 282/2011 art. 24b lit. (d), 24f), or by one: the customer's
     * fixed line or SIM the service is supplied through (art. 24b lit. (a)–(b)), or an item a
     * third party involved in the supply gave, below the €100,000 of art. 24b second paragraph. */
    location: z
      .array(
        z
          .object({
            kind: z.enum(locationKinds),
            country: z.string().regex(/^[A-Z]{2}$/),
            /** Given by a person involved in the supply other than the supplier and the customer
             * (the bank, a payment or network provider): art. 24b second paragraph. */
            thirdParty: z.boolean().optional(),
            evidenceId: z.uuid().optional(),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    /** For goods: the transport document showing the dispatch from Romania to the customer. */
    dispatchEvidenceId: z.uuid().optional(),
    /** For a reduced rate of the Member State: the TEDB category of what is sold, per rate. */
    categories: z.record(rate, z.string().regex(/^[A-Z0-9_]+$/)).optional(),
    /** For a Romanian reduced rate (below the threshold): the supply of art. 291 alin. (2) it is. */
    reducedRateBasis: z.string().trim().min(3).max(300).optional(),
  })
  .strict();
export type EuConsumerInput = z.infer<typeof euConsumerInput>;

/** The calendar quarter of a date, as the Union scheme's return covers it. */
export const quarterOf = (day: string) =>
  `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
export function quarterRange(quarter: string): { start: LocalDate; end: LocalDate } {
  const year = quarter.slice(0, 4);
  const last = Number(quarter.slice(6)) * 3;
  return {
    start: date(`${year}-${String(last - 2).padStart(2, '0')}-01`),
    end: monthEnd(`${year}-${String(last).padStart(2, '0')}` as Month),
  };
}

/** The VAT periods of a year up to a date, as the company keeps them (months or quarters). */
function periodsTo(loaded: Loaded, to: LocalDate): string[] {
  const periods = new Set<string>();
  for (let month = 1; month <= Number(to.slice(5, 7)); month++)
    periods.add(
      vatPeriodOf(loaded, date(`${to.slice(0, 4)}-${String(month).padStart(2, '0')}-01`)),
    );
  return [...periods];
}

/** The year's sales of art. 278^1 alin. (1) lit. b) booked before a document, in lei without VAT:
 * every entry the treatment records (`distance`), whatever its regime. */
export function distanceSalesBefore(loaded: Loaded, until: LocalDate, except: string): bigint {
  const seen = new Set<string>();
  let total = 0n;
  for (const ledger of loaded.taxLedger.values())
    for (const entry of ledger.entries) {
      const id = `${entry.entryId}|${entry.taxNo}`;
      if (seen.has(id) || entry.direction !== 'output' || !entry.attributes.distance) continue;
      seen.add(id);
      if (entry.documentId === except) continue;
      if (entry.taxPoint.slice(0, 4) === until.slice(0, 4) && entry.taxPoint <= until)
        total += entry.baseBani;
    }
  return total;
}

const factQuestion = (
  axis: string,
  from: LocalDate,
  message: string,
  code = 'DETERMINATION_MISSING',
) =>
  questionIssue(code, message, {
    kind: 'profile.fact',
    subject: { kind: 'profile', id: axis },
    params: { axis, from },
  });

type Part = {
  rate: string;
  baseMinor: bigint;
  taxMinor: bigint;
};

function partsOf(body: InvoiceDocument, sign: bigint): Part[] | Issue {
  const parts: Part[] = [];
  for (const tax of body.taxes) {
    if (tax.category !== 'S' || tax.rate === null)
      return block(
        'CATEGORY',
        `Vânzarea către un consumator din alt stat membru este taxabilă (categoria S, cu cota); categoria ${tax.category} nu se aplică.`,
      );
    parts.push({
      rate: tax.rate,
      baseMinor: sign * parseMoney(tax.base, body.currency),
      taxMinor: sign * parseMoney(tax.tax, body.currency),
    });
  }
  return parts;
}

/** base × rate ÷ 100, half away from zero, in the base's minor units. */
const vatOf = (base: bigint, rate: string) =>
  divRound(base * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');

export const euConsumerRecognition: Treatment<EuConsumerInput> = {
  id: 'invoices.euConsumer',
  version: 1,
  description:
    'Vânzare la distanță de bunuri sau serviciu de telecomunicații, radiodifuziune, televiziune ori furnizat pe cale electronică către un consumator din alt stat membru: TVA românească sub prag, TVA a statului membru de consum prin regimul special Uniune (OSS) peste prag.',
  input: euConsumerInput,
  agent: true,
  summary:
    "A distance sale or electronic service to an EU consumer abroad: Romanian VAT below the art. 278^1 threshold, the consumer state's VAT in the Union scheme (OSS) above it.",
  toolset: 'inbox',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId, ...(input.originalDocumentId ? [input.originalDocumentId] : [])],
    profile: true,
    ...(input.authorityId ? { parties: [input.authorityId] } : {}),
    // A credit note's original receivable, with its history: in a currency, it is reduced at
    // the rate it is carried at.
    ...(input.originalDocumentId
      ? { openItems: [{ documentId: input.originalDocumentId, history: true }] }
      : {}),
  }),
  followUp(input, loaded) {
    const parsed = invoiceDocumentSchema.safeParse(loaded.documents.get(input.documentId)?.body);
    if (!parsed.success) return null;
    const point = date(
      parsed.data.documentType === 'credit_note'
        ? (parsed.data.taxPointDate ?? parsed.data.issueDate)
        : taxPointOf(parsed.data),
    );
    const until = [parsed.data.issueDate, point].sort().at(-1)!;
    const carried = [...loaded.openItems.values()]
      .filter(
        (item) => item.documentId === input.originalDocumentId && item.currency !== LEDGER_CURRENCY,
      )
      .flatMap((item) => item.history ?? []);
    return {
      ...(carried.length ? { entries: [...new Set(carried)] } : {}),
      // The year's sales of the same kind before this one: the threshold is cumulated over them.
      taxPeriods: periodsTo(loaded, point).map((period) => ({ tax: 'VAT', period })),
      ...(parsed.data.currency === LEDGER_CURRENCY
        ? {}
        : { fx: [{ currency: parsed.data.currency, until: date(until) }] }),
    };
  },
  evaluate(input, loaded, rules) {
    const record = loaded.documents.get(input.documentId);
    if (!record)
      return {
        effect: null,
        issues: [block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId')],
      };
    const credit = record.kind === invoiceKinds.saleCredit;
    if (record.kind !== invoiceKinds.sale && !credit)
      return {
        effect: null,
        issues: [
          block(
            'DOCUMENT_KIND',
            'Se recunosc aici facturi emise și notele lor de credit.',
            'documentId',
          ),
        ],
      };
    const body = invoiceDocumentSchema.parse(record.body);
    const issues: Issue[] = [];
    const customer = body.customer;
    const state = memberStateOf(customer.country);
    if (!state)
      return {
        effect: null,
        issues: [
          block(
            'NOT_EU_CONSUMER',
            customer.country === 'RO'
              ? 'Clientul este din România: vânzarea este internă (invoices.recognize).'
              : `Clientul din ${customer.country} nu este dintr-un stat membru: exportul și serviciile în afara Uniunii nu se recunosc aici.`,
          ),
        ],
      };
    // A customer with a VAT code of its state is a taxable person: the B2B rules apply.
    const taxId = customer.taxId.toUpperCase().replace(/\s+/g, '');
    if (taxId.startsWith(state) && /\d/.test(taxId.slice(2)))
      issues.push(
        block(
          'CUSTOMER_TAXABLE',
          `Clientul are cod de TVA ${taxId}: este persoană impozabilă, iar livrarea sau serviciul urmează regulile între firme (invoices.crossBorder, livrare intracomunitară).`,
        ),
      );
    if (!isSupportedCurrency(body.currency))
      issues.push(block('CURRENCY', `Moneda ${body.currency} nu este acceptată.`));

    // The original sale, for a credit note: its regime and quarter decide the correction's.
    let original: InvoiceDocument | null = null;
    if (credit) {
      const found = input.originalDocumentId
        ? loaded.documents.get(input.originalDocumentId)
        : undefined;
      if (!found || found.kind !== invoiceKinds.sale)
        return {
          effect: null,
          issues: [
            block(
              'ORIGINAL',
              'Nota de credit cere factura inițială (originalDocumentId).',
              'originalDocumentId',
            ),
          ],
        };
      original = invoiceDocumentSchema.parse(found.body);
      const referenced = body.originalInvoiceNumber ?? body.invoiceReferences?.[0]?.number ?? null;
      if (referenced !== original.number || found.partyId !== record.partyId)
        issues.push(
          block(
            'REFERENCE',
            'Nota de credit nu face referire la factura inițială indicată.',
            'originalDocumentId',
          ),
        );
      if (original.currency !== body.currency)
        issues.push(
          block('CURRENCY', 'Nota de credit este în altă monedă decât factura inițială.'),
        );
    }
    const taxPoint = date(credit ? (body.taxPointDate ?? body.issueDate) : taxPointOf(body));
    // The place, and so the regime, is the supply's: a credit note follows its original.
    const supplied = original ? date(taxPointOf(original)) : taxPoint;
    const taxPeriod = vatPeriodOf(loaded, taxPoint);

    // The customer's place: two non-contradictory items for a service, the dispatch for goods.
    if (input.supply === 'distance_goods') {
      if (!input.dispatchEvidenceId)
        issues.push(
          ack(
            'DISPATCH_PROOF',
            `Bunurile se expediază din România către clientul din ${state} (art. 266 alin. (1) pct. 35, art. 275 alin. (2)): păstrați documentul de transport.`,
          ),
        );
      issues.push(
        info(
          'GOODS_WITHOUT_STOCK',
          'Costul bunurilor vândute nu se înregistrează: gestiunea stocurilor nu este încă construită.',
        ),
      );
    } else if (!credit) {
      const items = input.location ?? [];
      const countries = new Set(items.map((item) => memberStateOf(item.country) ?? item.country));
      const [only] = items;
      const agree = countries.size === 1 && countries.has(state);
      if (agree && items.length === 1 && (only!.kind === 'fixed_line' || only!.kind === 'sim'))
        // The presumptions of Regulation (EU) No 282/2011 art. 24b lit. (a)–(b), which the
        // supplier rebuts only with three items (art. 24d).
        issues.push(
          ack(
            'LOCATION_PRESUMED',
            only!.kind === 'fixed_line'
              ? `Locul clientului din ${state} se presupune a fi locul liniei telefonice fixe: confirmați că serviciul se prestează prin linia fixă a clientului (Regulamentul (UE) nr. 282/2011 art. 24b lit. (a); norme pct. 21 alin. (4) lit. a)).`
              : `Locul clientului din ${state} se presupune a fi țara codului mobil al cartelei SIM: confirmați că serviciul se prestează prin rețele mobile, pe cartela clientului (Regulamentul (UE) nr. 282/2011 art. 24b lit. (b); norme pct. 21 alin. (4) lit. b)).`,
            { clauses: LOCATION_CLAUSES },
          ),
        );
      else if (agree && items.length === 1 && only!.thirdParty && only!.kind !== 'other')
        // The single item of art. 24b second paragraph: the €100,000 (in lei at the ECB's rate of
        // 5.12.2017, not in the register) is the approver's to confirm.
        issues.push(
          ack(
            'LOCATION_SINGLE_ITEM',
            `Locul clientului din ${state} se stabilește pe un singur element de probă, dat de un terț implicat în prestare: se admite numai dacă serviciile de acest fel prestate de firmă din România nu au depășit 100.000 € (echivalentul în lei la cursul BCE din 5 decembrie 2017) nici în anul curent, până la această prestare, nici în cel precedent (Regulamentul (UE) nr. 282/2011 art. 24b al doilea și al treilea paragraf): confirmați.`,
            { clauses: LOCATION_CLAUSES },
          ),
        );
      else if (items.length < 2 || !agree)
        issues.push(
          block(
            'CUSTOMER_LOCATION',
            countries.size > 1
              ? `Elementele de probă privind locul clientului se contrazic (${[...countries].join(', ')}): locul nu se poate stabili (norme pct. 21 alin. (4) lit. d); Regulamentul (UE) nr. 282/2011 art. 24b lit. (d)).`
              : `Locul clientului din ${state} se stabilește prin două elemente de probă necontradictorii (adresa de facturare, adresa IP, banca, cartela SIM…; norme pct. 21 alin. (4) lit. d), (6); Regulamentul (UE) nr. 282/2011 art. 24b, 24f), prin linia fixă sau cartela SIM prin care se prestează serviciul, sau, sub 100.000 € pe an, printr-unul singur dat de un terț implicat în prestare (thirdParty): indicați-le (location).`,
            'location',
          ),
        );
    }

    // The company: registered for VAT (a non-payer's sales abroad are not covered).
    const status = profileAt(loaded, 'vat.status', supplied);
    if (!status)
      issues.push(
        factQuestion(
          'vat.status',
          supplied,
          'Înregistrați regimul TVA al companiei pentru această dată.',
        ),
      );
    else if (status !== 'normal_vat')
      issues.push(
        block(
          'EU_CONSUMER_NON_PAYER',
          'Vânzările către consumatori din alte state membre ale unei firme neînregistrate în scopuri de TVA (pragul art. 278^1 împreună cu scutirea art. 310 și codul art. 317 pentru regimul special) nu sunt încă acoperite.',
        ),
      );

    // Where the supply takes place: the company's `vat.distance` on the supply's date.
    const place = profileAt(loaded, 'vat.distance', supplied);
    if (!place)
      issues.push(
        factQuestion(
          'vat.distance',
          supplied,
          `Înregistrați unde au locul vânzările la distanță și serviciile electronice către consumatori din alte state membre la ${supplied}: în România sub pragul de 10.000 € (origin), la destinație peste prag (destination) sau prin opțiune (option, art. 278^1 alin. (3)).`,
        ),
      );
    const destination = place === 'destination' || place === 'option';
    let threshold: DistanceThreshold;
    try {
      threshold = rules.param<DistanceThreshold>(
        'ro.vat.distance.threshold',
        'reporting_period_start',
        date(`${supplied.slice(0, 4)}-01-01`),
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }
    const sign = credit ? -1n : 1n;
    const parts = partsOf(body, sign);
    if ('code' in parts) return { effect: null, issues: [...issues, parts] };

    // Amounts in lei: the receivable at the accounting rate of the issue date, the VAT base and
    // VAT at the VAT rate of the tax point (art. 290); revenue is what is left of the receivable.
    const foreign = body.currency !== LEDGER_CURRENCY;
    let accounting: FxRate | undefined;
    let vatRate: FxRate | undefined;
    if (foreign) {
      const a = selectRate(loaded, rules, body.currency, date(body.issueDate), 'accounting');
      const v = selectRate(loaded, rules, body.currency, taxPoint, 'vat');
      if ('code' in a) issues.push(a);
      else accounting = a;
      if ('code' in v) issues.push(v);
      else vatRate = v;
    }

    let regime: 'origin' | 'oss' | null = null;
    let ossDetails: {
      rates: { rate: string; type: 'standard' | 'reduced'; category?: string }[];
    } | null = null;
    let romanianRates: string[] = [];
    if (place === 'origin') {
      regime = 'origin';
      // The year's sales before this one, with this one: the sale that exceeds the threshold is
      // taxed where the customer is (art. 278^1 alin. (2)).
      if (!credit) {
        const before = distanceSalesBefore(loaded, supplied, record.id);
        const own = parts.reduce(
          (sum, part) =>
            sum +
            (vatRate
              ? convertMinor(part.baseMinor, body.currency, {
                  rate: vatRate.rate,
                  multiplier: vatRate.multiplier,
                })
              : part.baseMinor),
          0n,
        );
        const limit = BigInt(threshold.lei) * 100n;
        if (before + own > limit)
          issues.push(
            factQuestion(
              'vat.distance',
              supplied,
              `Vânzările la distanță și serviciile electronice către consumatori din alte state membre din ${supplied.slice(0, 4)} ajung, cu această factură, la ${formatMoney(before + own, 'RON')} lei, peste pragul de ${threshold.lei} lei (${threshold.eur} €, art. 278^1 alin. (1) lit. c), (5)): de la această vânzare locul este în ${state} (alin. (2)). Înregistrați vat.distance = destination de la ${supplied}.`,
              'DISTANCE_THRESHOLD_CROSSED',
            ),
          );
      }
      // Romanian VAT at the Romanian rates of the tax point.
      try {
        const standard = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', supplied, {
          category: 'S',
        });
        const reduced = rules.param<string>(
          'ro.vat.rate.reduced',
          'vat_chargeability_date',
          supplied,
        );
        romanianRates = [standard, reduced];
        for (const part of parts) {
          if (Number(part.rate) === Number(standard)) continue;
          if (Number(part.rate) === Number(reduced)) {
            if (!input.reducedRateBasis)
              issues.push(
                block(
                  'REDUCED_RATE_BASIS',
                  'Cota redusă cere livrarea de la art. 291 alin. (2) căreia i se aplică (reducedRateBasis).',
                  'reducedRateBasis',
                ),
              );
            else
              issues.push(
                ack(
                  'REDUCED_RATE',
                  `Cota redusă de ${reduced}% se aplică numai livrărilor de la art. 291 alin. (2): ${input.reducedRateBasis}.`,
                ),
              );
            continue;
          }
          issues.push(
            block(
              'ORIGIN_RATE',
              `Sub pragul art. 278^1 locul este în România: se aplică TVA românească (${standard}% sau ${reduced}%), nu ${part.rate}%.`,
            ),
          );
        }
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        issues.push(block('RULE_GAP', error.message));
      }
      issues.push(
        info(
          'EFACTURA_B2C',
          'Locul este în România: factura către persoana fizică se transmite în RO e-Factura în 5 zile lucrătoare de la emitere (relația B2C, OUG nr. 120/2021 art. 10^1 alin. (2)–(2^1)); clientul fără cod de identificare fiscală se înscrie cu 13 cifre de zero (alin. (3)).',
          { clauses: EFACTURA_B2C_CLAUSES },
        ),
      );
    } else if (destination) {
      const scheme = profileAt(loaded, 'vat.oss', supplied);
      if (!scheme)
        issues.push(
          factQuestion(
            'vat.oss',
            supplied,
            `Locul vânzării este în ${state}: înregistrați dacă firma aplică regimul special Uniune (vat.oss = union, cu decizia ANAF) de la ${supplied}, sau none; regimul se aplică de la prima vânzare în regim dacă ANAF a fost informată până pe 10 a lunii următoare (Regulamentul (UE) nr. 282/2011 art. 57d).`,
          ),
        );
      else if (scheme === 'non_union')
        issues.push(
          block(
            'OSS_NON_UNION',
            'Regimul non-Uniune (art. 314) îl folosește numai o persoană impozabilă fără sediu și fără sediu fix în Uniunea Europeană: o firmă stabilită în România folosește regimul Uniune (art. 315).',
          ),
        );
      else if (scheme !== 'union')
        issues.push(
          block(
            'OSS_NOT_REGISTERED',
            `Locul vânzării este în ${state} și firma nu aplică regimul special Uniune: TVA se datorează în ${state}, prin înregistrarea acolo, pe care aplicația nu o ține. Înregistrați-vă în regimul special (art. 315 alin. (3)) sau procesați vânzarea în afara aplicației, atribuit explicit.`,
          ),
        );
      else {
        regime = 'oss';
        ossDetails = { rates: [] };
        for (const part of parts) {
          const category = input.categories?.[part.rate];
          const resolved = resolveRate(rules, state, supplied, part.rate, category);
          if (!resolved.found) {
            issues.push(
              block(resolved.gap ? 'RULE_GAP' : 'OSS_RATE', resolved.reason, 'categories'),
            );
            continue;
          }
          if (resolved.type === 'reduced')
            issues.push(
              ack(
                'OSS_REDUCED_RATE',
                `Cota redusă de ${part.rate}% din ${state} se aplică categoriei ${category} (TEDB): confirmați că bunul sau serviciul vândut se încadrează în ea.`,
                { country: state, rate: part.rate, category: category! },
              ),
            );
          ossDetails.rates.push({
            rate: part.rate,
            type: resolved.type,
            ...(resolved.type === 'reduced' ? { category: category! } : {}),
          });
          // The invoice's VAT is the base at the rate, within a cent of rounding.
          const expected = vatOf(part.baseMinor, part.rate);
          if (expected - part.taxMinor > 1n || part.taxMinor - expected > 1n)
            issues.push(
              block(
                'OSS_VAT_AMOUNT',
                `TVA facturată (${formatMoney(part.taxMinor, body.currency)}) nu este ${part.rate}% din bază (${formatMoney(part.baseMinor, body.currency)} ${body.currency}).`,
              ),
            );
        }
        if (loaded.parties.get(input.authorityId ?? '')?.kind !== 'ro_public_institution')
          issues.push(
            block(
              'AUTHORITY',
              'Indicați autoritatea fiscală (ANAF, instituție publică) căreia i se plătește TVA din regimul special Uniune.',
              'authorityId',
            ),
          );
        issues.push(
          info(
            'EFACTURA_NOT_REQUIRED',
            `Locul este în ${state}: factura nu se transmite în RO e-Factura, care cuprinde vânzările B2C cu locul în România (OUG nr. 120/2021 art. 10^1 alin. (2)); facturarea urmează regulile României, statul de înregistrare (art. 319 alin. (5) lit. d)).`,
            { clauses: ['OUG120/2021-A:art.10^1(2)', `${CODE}:art.319(5)(d),(6)(b)`] },
          ),
        );
      }
    }
    if (issues.some((issue) => issue.severity === 'block') || !regime)
      return { effect: null, issues };

    const toLei = (minor: bigint, quote?: FxRate) =>
      quote
        ? convertMinor(minor, body.currency, { rate: quote.rate, multiplier: quote.multiplier })
        : minor;
    const grossMinor = sign * parseMoney(body.totals.payable, body.currency);
    const receivable = toLei(grossMinor, accounting);
    const currencyOf = (minor: bigint, quote?: FxRate) =>
      quote ? { currency: { code: body.currency, minor, rateId: quote.id, rate: quote.rate } } : {};
    const partyId = record.partyId ?? undefined;
    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    // The receivable: a new one for a sale; a credit note reduces its original's.
    const originalItem = credit
      ? [...loaded.openItems.values()].find(
          (item) =>
            item.documentId === input.originalDocumentId &&
            item.kind === 'receivable' &&
            item.controlAccount === '4111',
        )
      : undefined;
    if (credit && !originalItem)
      return {
        effect: null,
        issues: [
          ...issues,
          block('ORIGINAL_BOOKED', 'Factura inițială nu este înregistrată (creanța ei lipsește).'),
        ],
      };
    if (!credit)
      openItems.push({
        ref: 'counterparty',
        kind: 'receivable',
        controlAccount: '4111',
        partyId: partyId!,
        currency: body.currency,
        normalSide: 'D',
        mayReverse: false,
        documentId: record.id,
      });
    // A credit note reduces its original's receivable by what it still holds, at its carrying
    // amount (in euro, at the rate it is carried at: its invoice's or the last month-end
    // revaluation's), never past zero; beyond it (the sale collected already), the consumer is
    // owed a refund (462), in the invoice's currency.
    const partner = credit
      ? creditPartner({
          item: originalItem!,
          loaded,
          purchase: false,
          bani: -receivable,
          minor: -grossMinor,
          ...(accounting ? { rate: accounting } : {}),
          partyId: partyId!,
        })
      : null;
    if (partner) {
      lines.push(...partner.lines);
      openItems.push(...partner.openItems);
      if (partner.refund)
        issues.push(
          ack(
            'CREDIT_REFUND',
            `Factura inițială mai are deschiși ${formatMoney(-grossMinor - partner.refund.minor, body.currency)} ${body.currency}: restul notei de credit, ${formatMoney(partner.refund.minor, body.currency)} ${body.currency}, se datorează consumatorului (462 „Creditori diverși”), de restituit (OMFP nr. 1.802/2014, funcțiunea contului 462). Confirmați.`,
          ),
        );
    } else
      lines.push({
        account: '4111',
        side: 'D',
        bani: receivable,
        openItem: 'counterparty',
        partyId,
        ...currencyOf(grossMinor, accounting),
      });
    // The VAT lines follow the partner's and the revenue's.
    const first = lines.length + 1;
    const quarter = quarterOf(supplied);
    const common = {
      number: body.number,
      country: state,
      supply: input.supply,
      supplyType: supplyType(input.supply),
      ...(credit ? { corrects: quarter, original: original!.number } : {}),
    };
    let taxLei = 0n;
    let payable: string | null = null;
    let due: LocalDate | null = null;
    if (regime === 'origin') {
      // Romanian VAT on 4427, one tax entry per rate, as a domestic sale at that rate: D300 rd. 17
      // (by `distance`), D394 with the customer by its address, D406 by the rate's code.
      parts.forEach((part, index) => {
        const base = toLei(part.baseMinor, vatRate);
        const tax = foreign ? vatOf(base, part.rate) : part.taxMinor;
        taxLei += tax;
        taxEntries.push({
          key: parts.length > 1 ? `vat:S-${part.rate}` : 'vat',
          tax: 'VAT',
          code: `S-${Number(part.rate)}`,
          direction: 'output',
          baseBani: base,
          taxBani: tax,
          deductibleBani: 0n,
          ledgerBani: tax,
          line: first + index,
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          ...(partyId ? { partyId } : {}),
          ...(vatRate
            ? {
                currency: {
                  code: body.currency,
                  baseMinor: part.baseMinor,
                  taxMinor: part.taxMinor,
                  rateId: vatRate.id,
                  rate: vatRate.rate,
                },
              }
            : {}),
          attributes: { ...common, distance: 'origin', rate: part.rate },
        });
      });
      lines.push(
        ...parts.map((part, index) => ({
          account: '4427',
          side: 'C' as const,
          bani: taxEntries[index]!.taxBani,
        })),
      );
    } else {
      try {
        payable = rules.param<string>(
          'ro.vat.oss.payable_account',
          'vat_chargeability_date',
          supplied,
        );
        due = obligationDue('D398', quarterRange(quarterOf(taxPoint)), rules).due;
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
      }
      // The consumer state's VAT is owed in euro to the special account (art. 315 alin. (13)): an
      // item of the authority in the document's currency, due with the quarter's return.
      const ossMinor = parts.reduce((sum, part) => sum + part.taxMinor, 0n);
      const ossLei = toLei(ossMinor, accounting);
      taxLei = ossLei;
      parts.forEach((part, index) => {
        const resolved = ossDetails!.rates[index]!;
        taxEntries.push({
          key: parts.length > 1 ? `vat:OSS-${part.rate}` : 'vat',
          tax: 'VAT',
          code: ossCode,
          direction: 'output',
          baseBani: toLei(part.baseMinor, vatRate),
          taxBani: toLei(part.taxMinor, vatRate),
          deductibleBani: 0n,
          ledgerBani: 0n,
          taxPoint,
          exigibility: taxPoint,
          taxPeriod,
          documentId: record.id,
          ...(partyId ? { partyId } : {}),
          ...(vatRate
            ? {
                currency: {
                  code: body.currency,
                  baseMinor: part.baseMinor,
                  taxMinor: part.taxMinor,
                  rateId: vatRate.id,
                  rate: vatRate.rate,
                },
              }
            : {}),
          attributes: {
            ...common,
            distance: 'oss',
            regime: 'oss',
            return: 'D398',
            quarter: quarterOf(taxPoint),
            rate: part.rate,
            rateType: resolved.type,
            ...(resolved.category ? { category: resolved.category } : {}),
            // Amounts in the document's currency, for the return in euro.
            currency: body.currency,
            baseMinor: String(part.baseMinor),
            taxMinor: String(part.taxMinor),
          },
        });
      });
      openItems.push({
        ref: 'oss',
        kind: 'tax.payable',
        controlAccount: payable,
        partyId: input.authorityId!,
        currency: body.currency,
        normalSide: 'C',
        // A credit note's item is what the company may deduct from the next payment.
        mayReverse: credit,
        dueDate: due,
        documentId: record.id,
      });
      lines.push({
        account: payable,
        side: 'C',
        bani: ossLei,
        openItem: 'oss',
        partyId: input.authorityId!,
        memo: `TVA ${state} prin regimul special Uniune (D398 ${quarterOf(taxPoint)})`,
        ...currencyOf(ossMinor, accounting),
      });
    }
    // Revenue: the receivable less the VAT, so the receivable stays exact in its currency.
    lines.splice(first - 1, 0, { account: input.account, side: 'C', bani: receivable - taxLei });
    // A credit note's receivable released at its carrying amount, not at the note's rate: the
    // difference is a realized exchange difference (OMFP 1802/2014 pct. 322), a loss (6651) when
    // more is released than the note reverses, a gain (7651) otherwise.
    if (partner?.excess)
      lines.push({
        account: partner.excess > 0n ? '6651' : '7651',
        side: partner.excess > 0n ? 'D' : 'C',
        bani: partner.excess > 0n ? partner.excess : -partner.excess,
        memo: 'Diferență de curs realizată',
      });
    const effect: Effect = {
      schema: 'effect@1',
      date: date(body.issueDate),
      journalClass: 'general',
      journalCode: 'VANZARI',
      description: `${credit ? 'Notă de credit' : 'Factură'} ${body.number} către un consumator din ${state}${regime === 'oss' ? ' (OSS)' : ''}`,
      lines,
      openItems,
      taxEntries,
      schedules: [],
      explanation: {
        summary:
          regime === 'origin'
            ? `Locul în România (sub pragul de ${threshold.lei} lei, art. 278^1 alin. (1)): TVA românească ${formatMoney(taxLei, 'RON')} lei la ${parts.map((part) => `${part.rate}%`).join(', ')}, declarată în D300 rd. 17.`
            : `Locul în ${state} (art. ${input.supply === 'distance_goods' ? '275 alin. (2)' : '278 alin. (5) lit. h)'}): TVA ${state} ${formatMoney(
                parts.reduce((sum, part) => sum + part.taxMinor, 0n),
                body.currency,
              )} ${body.currency} la ${parts.map((part) => `${part.rate}%`).join(', ')}, declarată în D398 pentru ${quarterOf(taxPoint)}${credit && quarter !== quarterOf(taxPoint) ? ` ca rectificare a trimestrului ${quarter} (art. 315 alin. (11))` : ''} și plătită în euro până la ${due}.`,
        details: {
          regime,
          country: state,
          supply: input.supply,
          taxPoint,
          quarter: quarterOf(taxPoint),
          ...(credit ? { corrects: quarter } : {}),
          ...(regime === 'origin' ? { romanianRates } : { due: due!, rates: ossDetails!.rates }),
          clauses: [
            `${CODE}:art.278^1(1)-(2)`,
            ...(regime === 'oss' ? [`${CODE}:art.315(6)-(6^1)`, `${CODE}:art.315(12)-(13)`] : []),
          ],
        },
      },
    };
    return { effect, issues };
  },
};
