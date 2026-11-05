import type {
  AnswerRecord,
  Evaluation,
  ItemLines,
  Loaded,
  OpenItemState,
  PartyRecord,
  PostedEntry,
} from '../../../kernel';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../../ubl/invoice-document';
import { invoiceKinds } from '../../treatments/invoices';
import { flatRateInput, flatRateRecognition } from '../../schemes/agriculture';
import { ITEM_ACCOUNT, marginItem, marginSale, marginSaleInput } from '../../schemes/invoices';
import { marginVat, schemeMentions } from '../../schemes/margin';
import { travelMargin, travelMarginInput } from '../../schemes/travel';
import type { CaseOutcome, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of the special VAT schemes from ANAF's consolidated Fiscal Code (snapshot
 * ANAF/Cod-fiscal-consolidat, sha256 aba0c753…): art. 311 and the norms' pct. 85 (travel
 * agencies), art. 312 and pct. 86 (second-hand goods, works of art, collectors' items and
 * antiques), art. 315^1 and pct. 87^1 (the agricultural flat rate), with the D300 rows of OPANAF
 * nr. 174/2026. The worlds below are fixed; the treatments compute every outcome against the
 * register under review, and the core tests reuse the worlds.
 */

export const schemeIds = {
  company: '00000000-0000-4000-8000-0000000000f0',
  partner: '00000000-0000-4000-8000-0000000000f1',
  farmer: '00000000-0000-4000-8000-0000000000f2',
  evidence: '00000000-0000-4000-8000-0000000000f3',
  sale: (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  purchase: (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`,
  entry: (n: number) => `00000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`,
  question: '00000000-0000-4000-8000-0000000004f0',
} as const;

const COMPANY = { name: 'Companie exemplu SRL', taxId: 'RO18547290', country: 'RO' };
const money = (bani: bigint) => {
  const digits = bani.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
const bani = (text: string) => BigInt(text.replace('.', ''));

/** A domestic invoice in lei without VAT (category E, or O for a non-payer), its lines' amounts
 * as given and the reason (BT-120) on its breakdown. */
export function schemeInvoice(options: {
  number: string;
  issueDate: string;
  sale: boolean;
  partner: { name: string; taxId: string };
  lines: string[];
  category?: 'E' | 'O' | 'S';
  rate?: string;
  tax?: string;
  reason?: string | null;
}): InvoiceDocument {
  const category = options.category ?? 'E';
  const net = options.lines.reduce((sum, line) => sum + bani(line), 0n);
  const tax = bani(options.tax ?? '0.00');
  const partner = { ...options.partner, country: 'RO' };
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: options.number,
    issueDate: options.issueDate,
    taxPointDate: null,
    currency: 'RON',
    supplier: options.sale ? COMPANY : partner,
    customer: options.sale ? partner : COMPANY,
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1',
    lines: options.lines.map((line, index) => ({
      id: String(index + 1),
      description: 'Bun sau serviciu',
      net: line,
      vatCategory: category,
      vatRate: options.rate ?? '0',
    })),
    taxes: [
      {
        base: money(net),
        tax: money(tax),
        category,
        rate: options.rate ?? '0',
        exemptionReason: options.reason === undefined ? null : options.reason,
      },
    ],
    totals: {
      lineNet: money(net),
      net: money(net),
      tax: money(tax),
      gross: money(net + tax),
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: money(net + tax),
    },
  });
}

function put(loaded: Loaded, id: string, kind: string, body: InvoiceDocument, partyId: string) {
  (loaded.documents as Map<string, unknown>).set(id, {
    id,
    kind,
    schema: body.parserVersion,
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId,
    currency: 'RON',
    number: body.number,
    evidenceId: null,
  });
}

function item(
  loaded: Loaded,
  documentId: string,
  sale: boolean,
  treatmentId: string,
  entryId: string,
  date: string,
) {
  const state: OpenItemState = {
    id: `item-${documentId}`,
    kind: sale ? 'receivable' : 'payable',
    controlAccount: sale ? '4111' : '401',
    partyId: schemeIds.partner,
    currency: 'RON',
    normalSide: sale ? 'D' : 'C',
    mayReverse: false,
    balanceBani: 0n,
    balanceMinor: 0n,
    documentId,
    dueDate: null,
    originEntryId: entryId,
    movements: 1,
    origin: { treatmentId, subject: `document:${documentId}`, date: date as LocalDate, tag: null },
  };
  (loaded.openItems as Map<string, OpenItemState>).set(state.id, state);
}

/** A company registered for VAT (monthly) since 2020. */
const registeredCompany = (extra: Loaded['profile'] = []) =>
  emptyLoaded([
    { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
    ...extra,
  ]);

const issueLines = (evaluation: Evaluation) =>
  evaluation.issues.map(
    (issue) =>
      `${issue.severity === 'block' ? 'Blocare' : issue.severity === 'ack' ? 'De confirmat' : 'Informare'} ${issue.code}: ${issue.message}`,
  );
const parameterLines = (register: ParameterRegister, rules: RuleContext) =>
  [...rules.used.keys()].map((id) => {
    const version = register.versions.find((value) => value.id === id);
    return `Parametru ${id} = ${JSON.stringify(version?.value)}`;
  });
const blocked = (evaluation: Evaluation) =>
  `Blocat: ${[...new Set(evaluation.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code))].join(', ')}`;

// Travel agencies (art. 311).

/** A trip in the travel world: the travellers' invoices and the costs bought for them, with
 * whether each cost's VAT was deducted. */
export type Trip = {
  reference: string;
  sales: string[];
  costs: { gross: string; deducted?: boolean }[];
};

/** The books of a travel agency registered for VAT, its trips of October 2026 booked: each sale
 * with `margin.sale`, each cost with `invoices.recognize` (21%, not deducted unless said). */
export function travelWorld(trips: readonly Trip[]): {
  loaded: Loaded;
  input: Record<string, unknown>;
} {
  const loaded = registeredCompany();
  (loaded.evidence as Map<string, unknown>).set(schemeIds.evidence, {
    id: schemeIds.evidence,
    hash: 'example',
    filename: 'situatie-marja.pdf',
    mediaType: 'application/pdf',
  });
  let sales = 0;
  let purchases = 0;
  let entries = 0;
  const partner = { name: 'Client exemplu SRL', taxId: 'RO13548146' };
  const supplier = { name: 'Hotel exemplu SRL', taxId: 'RO13548146' };
  const input = trips.map((trip) => {
    const saleIds = trip.sales.map((amount) => {
      const id = schemeIds.sale(++sales);
      put(
        loaded,
        id,
        invoiceKinds.sale,
        schemeInvoice({
          number: `AT-${sales}`,
          issueDate: '2026-10-05',
          sale: true,
          partner,
          lines: [amount],
          reason: schemeMentions.travel,
        }),
        schemeIds.partner,
      );
      item(loaded, id, true, 'margin.sale', schemeIds.entry(++entries), '2026-10-05');
      return id;
    });
    const costs = trip.costs.map((cost) => {
      const id = schemeIds.purchase(++purchases);
      const gross = bani(cost.gross);
      const tax = (gross * 21n + 60n) / 121n;
      put(
        loaded,
        id,
        invoiceKinds.purchase,
        schemeInvoice({
          number: `H-${purchases}`,
          issueDate: '2026-10-10',
          sale: false,
          partner: supplier,
          lines: [money(gross - tax)],
          category: 'S',
          rate: '21',
          tax: money(tax),
        }),
        schemeIds.partner,
      );
      const entryId = schemeIds.entry(++entries);
      item(loaded, id, false, 'invoices.recognize', entryId, '2026-10-10');
      const posted: PostedEntry = {
        id: entryId,
        number: entries,
        date: '2026-10-10' as LocalDate,
        journalCode: 'CUMPARARI',
        description: 'Cazare',
        lines: [],
        taxEntries: [
          {
            key: 'vat',
            tax: 'VAT',
            code: 'S-21',
            direction: 'input',
            baseBani: gross - tax,
            taxBani: tax,
            deductibleBani: cost.deducted ? tax : 0n,
            ledgerBani: cost.deducted ? tax : 0n,
            taxPoint: '2026-10-10' as LocalDate,
            exigibility: '2026-10-10' as LocalDate,
            taxPeriod: '2026-10',
            attributes: {},
          },
        ],
      };
      (loaded.entries as Map<string, PostedEntry>).set(entryId, posted);
      return { documentId: id };
    });
    return {
      reference: trip.reference,
      supplied: '2026-10-20',
      place: 'eu',
      sales: saleIds,
      costs,
    };
  });
  return {
    loaded,
    input: {
      period: '2026-10',
      date: '2026-10-31',
      account: '704',
      evidenceId: schemeIds.evidence,
      trips: input,
    },
  };
}

/** `margin.travel` in a travel world, against a register. */
export function travelEvaluation(register: ParameterRegister, trips: readonly Trip[]) {
  const { loaded, input } = travelWorld(trips);
  const rules = new RuleContext(register, 'preview');
  const evaluation = travelMargin.evaluate(travelMarginInput.parse(input), loaded, rules);
  return { evaluation, rules };
}

const TRAVEL_FACTS =
  'Agenție de turism înregistrată în scopuri de TVA (lunar), stabilită în România; în octombrie 2026 prestează, în nume propriu, serviciile unice de mai jos (cazare și transport cumpărate de la alte persoane impozabile, în Uniune), facturate călătorilor fără TVA înscrisă; costurile sunt facturi cu TVA de 21%, nededuse; cota standard 21%.';

/** Each trip's VAT on its own margin, a negative margin giving none: the alternative reading. */
function perTrip(trips: readonly Trip[]): CaseOutcome {
  let vat = 0n;
  const lines: string[] = [];
  for (const trip of trips) {
    const margin =
      trip.sales.reduce((sum, amount) => sum + bani(amount), 0n) -
      trip.costs.reduce((sum, cost) => sum + bani(cost.gross), 0n);
    const computed = marginVat(margin, '21');
    vat += computed.vat;
    lines.push(`${trip.reference}: marja ${lei(margin)} lei, TVA ${lei(computed.vat)} lei`);
  }
  return {
    summary: `Pe fiecare călătorie: TVA ${lei(vat)} lei (marja negativă a unei călătorii nu se compensează)`,
    lines,
  };
}

function travelCase(title: string, facts: string, trips: readonly Trip[]) {
  return {
    title,
    facts: `${TRAVEL_FACTS} ${facts}`,
    run: (register: ParameterRegister) => {
      const { evaluation, rules } = travelEvaluation(register, trips);
      const effect = evaluation.effect;
      const engine: CaseOutcome = {
        summary: effect
          ? `Propus: TVA pe marja perioadei ${lei(effect.taxEntries[0]!.taxBani)} lei, baza ${lei(effect.taxEntries[0]!.baseBani)} lei (rd. 9)`
          : blocked(evaluation),
        lines: [...issueLines(evaluation), ...parameterLines(register, rules)],
      };
      return { engine, alternative: perTrip(trips) };
    },
  };
}

export const travelMarginSpec: ReviewSpec = {
  key: 'ro.vat.margin.travel',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'Taxa colectată a agenției de turism se calculează pe perioada fiscală: din jurnalele de vânzări și cumpărări, suma plătită de călători pentru serviciile unice prestate în perioadă minus costurile lor cu TVA, iar din diferență, prin procedeul sutei mărite la cota standard în vigoare (21 × 100 / 121), taxa; marja negativă a unei călătorii se compensează cu celelalte ale perioadei, iar marja negativă a întregii perioade nu este rezolvată de text (caz neacoperit).',
    alternative:
      'Marja se calculează pentru fiecare serviciu unic (călătorie) în parte: o călătorie cu marjă negativă nu are taxă, dar nici nu reduce taxa celorlalte; taxa perioadei este suma taxelor pe călătorii.',
  },
  question:
    'Pentru o agenție de turism în regimul special (art. 311), marja se determină global, pe serviciile unice ale perioadei fiscale, cu compensarea marjelor negative, sau pe fiecare serviciu unic? Și ce se întâmplă cu o marjă negativă a întregii perioade?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.311(1)-(3)',
    'OPANAF3769/2015-A:anexa2.regim-special',
    'OPANAF3769/2015-A:anexa2.sect1.litI.pct.6',
    'ANAF/Cod-fiscal-consolidat:art.319(20)(k),(n),(o)',
    'ANAF/Cod-fiscal-consolidat:art.291(1)',
  ],
  cases: [
    travelCase(
      'O călătorie: 10.000,00 lei încasați, 7.580,00 lei costuri',
      'Pachetul CT-1: călătorii plătesc 10.000,00 lei; cazarea și transportul costă 7.580,00 lei cu TVA.',
      [{ reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] }],
    ),
    travelCase(
      'Două călătorii, una cu marjă negativă',
      'CT-1: 10.000,00 lei încasați, costuri 7.580,00 lei; CT-2: 3.000,00 lei încasați, costuri 3.605,00 lei (marjă −605,00 lei).',
      [
        { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] },
        { reference: 'CT-2', sales: ['3000.00'], costs: [{ gross: '3605.00' }] },
      ],
    ),
    travelCase(
      'Perioadă cu marjă negativă',
      'CT-3: 2.000,00 lei încasați, costuri 2.420,00 lei (marjă −420,00 lei), singura călătorie a lunii.',
      [{ reference: 'CT-3', sales: ['2000.00'], costs: [{ gross: '2420.00' }] }],
    ),
    travelCase(
      'O călătorie cu avans și rest de plată, două facturi de cost',
      'CT-4: avans 2.000,00 lei și restul de 4.050,00 lei (6.050,00 lei); transport 1.210,00 lei și cazare 3.630,00 lei, cu TVA.',
      [
        {
          reference: 'CT-4',
          sales: ['2000.00', '4050.00'],
          costs: [{ gross: '1210.00' }, { gross: '3630.00' }],
        },
      ],
    ),
  ],
  gaps: [
    'Normele (pct. 85 alin. (4) lit. d)) scriu procedeul sutei mărite pentru cotele de 20% și 19% („19 x 100 / 119 începând cu data de 1 ianuarie 2017”) și nu au fost actualizate pentru cota de 21% din 1 august 2025; motorul citește „la nivelul cotei standard de taxă” pentru cota în vigoare.',
    'Serviciile unice cu componente în afara Uniunii (art. 311 alin. (5), partea scutită ca intermediar) și opțiunea pentru regimul normal (alin. (10)–(11)) nu sunt acoperite: un calcul cu ele este refuzat.',
    'Data la care un serviciu unic intră în perioadă: motorul îl ia la data prestării (sfârșitul călătoriei), cu toate facturile lui, avansurile incluse, pentru că normele exclud avansurile ale căror costuri nu se cunosc; facturarea unui avans înaintea prestării (art. 282 alin. (2)) nu mută taxa.',
    'D394: motorul declară vânzările în regim special (LS) la valoarea facturată, pe client, și în secțiunea informatii încasările, costurile, marja exclusiv taxa (marja_ag) și taxa (tva_ag), cum cer instrucțiunile consolidate până la 17.09.2025 (OPANAF nr. 3.769/2015 anexa nr. 2: secțiunea a 2-a, „valorile totale înscrise în facturi, inclusiv valoarea marjei de profit și a TVA aferentă”, și secțiunea 1 lit. I pct. 6.1); lit. C pct. 7 vorbește totuși de „baza impozabilă” a acestor livrări.',
    'D406 (SAF-T): foaia de coduri ANAF nu are un cod pentru regimul marjei; motorul nu ghicește unul, iar închiderea obligațiilor raportează D406 neacoperit pentru lunile cu aceste operațiuni.',
  ],
};

// Second-hand goods, works of art, collectors' items and antiques (art. 312).

/** An item in the dealer's world: its purchase price and its price on the sale. */
export type Item = { cost: string; price: string; goods?: 'second_hand' | 'works_of_art' };

/** The books of a dealer registered for VAT, keeping only individual items (margin_goods), its
 * items bought on their own documents (on 371, tagged), sold together on one invoice of 15.10.2026. */
export function goodsWorld(
  items: readonly Item[],
  options: { regime?: 'margin' | 'normal'; sold?: boolean } = {},
): { loaded: Loaded; input: Record<string, unknown> } {
  const loaded = registeredCompany([
    { axis: 'activity.goods', value: 'margin_goods', effectiveFrom: '2026-01-01' as LocalDate },
  ]);
  const regime = options.regime ?? 'margin';
  const rows: ItemLines[] = [];
  items.forEach((value, index) => {
    const id = schemeIds.purchase(index + 1);
    put(
      loaded,
      id,
      invoiceKinds.purchase,
      schemeInvoice({
        number: `AF-${index + 1}`,
        issueDate: '2026-09-10',
        sale: false,
        partner: { name: 'Ion Popescu', taxId: '1800101400016' },
        lines: [value.cost],
        category: 'O',
      }),
      schemeIds.partner,
    );
    rows.push({
      item: marginItem(value.goods ?? 'second_hand', id),
      account: ITEM_ACCOUNT,
      openItem: null,
      debit: bani(value.cost),
      credit: options.sold ? bani(value.cost) : 0n,
      debitMinor: 0n,
      creditMinor: 0n,
    });
  });
  (loaded.itemLines as Map<string, readonly ItemLines[]>).set(ITEM_ACCOUNT, rows);
  const total = items.reduce((sum, value) => sum + bani(value.price), 0n);
  const kinds = new Set(items.map((value) => value.goods ?? 'second_hand'));
  put(
    loaded,
    schemeIds.sale(1),
    invoiceKinds.sale,
    regime === 'margin'
      ? schemeInvoice({
          number: 'SH-1',
          issueDate: '2026-10-15',
          sale: true,
          partner: { name: 'Client exemplu SRL', taxId: 'RO13548146' },
          lines: items.map((value) => value.price),
          reason: [...kinds].map((kind) => schemeMentions[kind]).join('; '),
        })
      : schemeInvoice({
          number: 'SH-1',
          issueDate: '2026-10-15',
          sale: true,
          partner: { name: 'Client exemplu SRL', taxId: 'RO13548146' },
          lines: items.map((value) => value.price),
          category: 'S',
          rate: '21',
          tax: money((total * 21n + 50n) / 100n),
        }),
    schemeIds.partner,
  );
  return {
    loaded,
    input: {
      documentId: schemeIds.sale(1),
      scheme: 'goods',
      regime,
      account: '707',
      costAccount: '607',
      items: items.map((value, index) => ({
        purchaseDocumentId: schemeIds.purchase(index + 1),
        price: value.price,
      })),
    },
  };
}

/** `margin.sale` (goods) in a dealer's world, against a register. */
export function goodsEvaluation(
  register: ParameterRegister,
  items: readonly Item[],
  options: { regime?: 'margin' | 'normal'; sold?: boolean } = {},
) {
  const { loaded, input } = goodsWorld(items, options);
  const rules = new RuleContext(register, 'preview');
  const evaluation = marginSale.evaluate(marginSaleInput.parse(input), loaded, rules);
  return { evaluation, rules };
}

const GOODS_FACTS =
  'Revânzător înregistrat în scopuri de TVA (lunar), care ține doar bunuri individuale în regimul marjei; bunurile de mai jos au fost cumpărate de la persoane fizice, cu autofactură, și se vând pe 15.10.2026 cu mențiunea „regimul marjei - bunuri second-hand”, fără TVA înscrisă; cota standard 21%.';

/** The global margin of the period (Directive 2006/112/EC art. 318): the alternative. */
function globalMargin(items: readonly Item[]): CaseOutcome {
  const margin = items.reduce((sum, value) => sum + bani(value.price) - bani(value.cost), 0n);
  const computed = marginVat(margin, '21');
  return {
    summary: `Marja globală a perioadei ${lei(margin)} lei: TVA ${lei(computed.vat)} lei`,
    lines: items.map(
      (value) => `Vânzare ${lei(bani(value.price))} lei, cumpărare ${lei(bani(value.cost))} lei`,
    ),
  };
}

function goodsCase(title: string, facts: string, items: readonly Item[]) {
  return {
    title,
    facts: `${GOODS_FACTS} ${facts}`,
    run: (register: ParameterRegister) => {
      const { evaluation, rules } = goodsEvaluation(register, items);
      const effect = evaluation.effect;
      const vat = effect?.taxEntries.reduce((sum, entry) => sum + entry.taxBani, 0n) ?? 0n;
      const engine: CaseOutcome = {
        summary: effect
          ? `Propus: TVA pe marja fiecărui bun ${lei(vat)} lei (${effect.taxEntries.map((entry) => `${entry.attributes.margin} → ${lei(entry.taxBani)}`).join('; ')})`
          : blocked(evaluation),
        lines: [...issueLines(evaluation), ...parameterLines(register, rules)],
      };
      return { engine, alternative: globalMargin(items) };
    },
  };
}

export const goodsMarginSpec: ReviewSpec = {
  key: 'ro.vat.margin.goods',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'Revânzătorul calculează taxa pe marja fiecărei livrări (prețul de vânzare minus prețul de cumpărare al bunului, ambele din documentele lui), prin procedeul sutei mărite la cota standard; o marjă negativă nu dă taxă și nu reduce taxa altor livrări; taxa perioadei este suma taxelor pe livrări (norme pct. 86 alin. (4)–(5)).',
    alternative:
      'Marja se poate determina global, pe perioadă (diferența dintre vânzările și cumpărările perioadei, ca la art. 318 din Directiva 2006/112/CE), marjele negative ale unor bunuri reducând taxa celorlalte.',
  },
  question:
    'Pentru revânzătorul în regimul marjei (art. 312), taxa se calculează pe marja fiecărei livrări, marja negativă rămânând fără efect, sau se admite o marjă globală a perioadei?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.312(5)-(12)',
    'OPANAF3769/2015-A:anexa2.regim-special',
    'OPANAF3769/2015-A:anexa2.sect1.litI.pct.6',
    'ANAF/Cod-fiscal-consolidat:art.319(20)(k),(n),(o)',
    'ANAF/Cod-fiscal-consolidat:art.291(1)',
  ],
  cases: [
    goodsCase(
      'Un bun cumpărat cu 1.000,00 lei, vândut cu 1.500,00 lei',
      'Un ceas cumpărat cu 1.000,00 lei și vândut cu 1.500,00 lei.',
      [{ cost: '1000.00', price: '1500.00' }],
    ),
    goodsCase(
      'Un bun vândut în pierdere',
      'O bicicletă cumpărată cu 2.000,00 lei și vândută cu 1.800,00 lei.',
      [{ cost: '2000.00', price: '1800.00' }],
    ),
    goodsCase(
      'Două bunuri pe aceeași factură, unul în pierdere',
      'Ceasul (1.000,00 → 1.500,00 lei) și bicicleta (2.000,00 → 1.800,00 lei) pe aceeași factură.',
      [
        { cost: '1000.00', price: '1500.00' },
        { cost: '2000.00', price: '1800.00' },
      ],
    ),
  ],
  gaps: [
    'Marja globală nu apare în textul român (art. 312 alin. (4) și normele pct. 86 alin. (4) cer baza pentru fiecare livrare); art. 318 din Directivă o lasă statelor ca opțiune. Motorul nu o oferă.',
    'Cota: normele cer registrul „pe fiecare cotă de TVA aplicabilă” (pct. 86 alin. (6) lit. c)), dar instrucțiunile D300 pun regimurile speciale doar la rândul 9 (cota de 21%); o marjă la cota redusă nu este acoperită.',
    'Opțiunea de la art. 312 alin. (3) (operele de artă, obiectele de colecție și antichitățile importate sau cumpărate de la autori și alte persoane impozabile), cu dreptul de deducere de la alin. (8)–(9), și vânzările prin licitație publică (alin. (15), pct. 86 alin. (8)–(10)) nu sunt acoperite.',
    'Fiecare bun este documentul lui de achiziție, pe 371, fără cantități: gestiunea stocurilor (G1), inventarul de la sfârșitul anului al bunurilor și fișierul de stocuri D406 nu există încă.',
    'D394: livrările în regim special (LS) se declară la prețul facturat, pe client, iar informatii cuprinde prețurile de vânzare și de cumpărare, marja ca diferență dintre ele (TVA inclusă, OPANAF nr. 3.769/2015 anexa nr. 2 secțiunea 1 lit. I pct. 6.2, spre deosebire de marja agenției de turism, exclusiv taxa) și taxa; cu un bun vândut în pierdere, marja declarată (diferența prețurilor perioadei) e mai mică decât suma marjelor taxate. Cumpărările de la persoane fizice se declară ca achiziții de tip N (factură, natura „alte bunuri”), iar de la revânzători ca AS. Autofactura emisă persoanei fizice (norme pct. 86 alin. (6) lit. d)) nu este declarată la secțiunea facturilor emise în numele furnizorilor (lit. I pct. 2.2.4): dacă îi aparține este o întrebare deschisă.',
  ],
};

// The agricultural flat rate (art. 315^1).

/** A buyer registered for VAT, a farmer's invoice of 12.10.2026 for products of `price` lei and
 * a compensation of `compensation` lei, and the farmer's register answer when `registeredFrom`. */
export function farmerWorld(options: {
  price: string;
  compensation: string;
  registeredFrom?: string | null;
  deduction?: 'full' | 'none';
}): { loaded: Loaded; input: Record<string, unknown> } {
  const loaded = registeredCompany();
  const body = schemeInvoice({
    number: 'AGR-7',
    issueDate: '2026-10-12',
    sale: false,
    partner: { name: 'Popescu Ion PFA', taxId: '41287658' },
    lines: [options.price, options.compensation],
    category: 'O',
    reason: 'VATEX-EU-O',
  });
  put(loaded, schemeIds.purchase(1), invoiceKinds.purchase, body, schemeIds.farmer);
  (loaded.parties as Map<string, PartyRecord>).set(schemeIds.farmer, {
    id: schemeIds.farmer,
    kind: 'ro_individual_enterprise',
    country: 'RO',
    taxId: '41287658',
    name: 'Popescu Ion PFA',
  });
  if (options.registeredFrom)
    (loaded.answers as Map<string, AnswerRecord>).set(schemeIds.question, {
      questionId: schemeIds.question,
      answerId: `${schemeIds.question}-1`,
      kind: 'farmer.register',
      subject: { kind: 'party', id: schemeIds.farmer },
      params: {},
      value: { registered: true, from: options.registeredFrom, evidenceId: schemeIds.evidence },
      evidenceId: schemeIds.evidence,
      answeredAt: '2026-10-13T08:00:00.000Z',
    });
  return {
    loaded,
    input: {
      documentId: schemeIds.purchase(1),
      parts: [{ account: '6028', amount: options.price }],
      deduction: options.deduction ?? 'full',
    },
  };
}

/** `invoices.flatRate` (a purchase) in a farmer's world, against a register. */
export function farmerEvaluation(
  register: ParameterRegister,
  options: Parameters<typeof farmerWorld>[0],
) {
  const { loaded, input } = farmerWorld(options);
  const rules = new RuleContext(register, 'preview');
  const evaluation = flatRateRecognition.evaluate(flatRateInput.parse(input), loaded, rules);
  return { evaluation, rules };
}

const FARMER_FACTS =
  'SRL înregistrat în scopuri de TVA (lunar) cumpără pe 12.10.2026 legume de la Popescu Ion PFA, agricultor în regimul special, cu factură fără TVA care înscrie mențiunea regimului, procentul și compensația în cotă forfetară; factura se plătește pe 20.11.2026.';

function farmerCase(title: string, facts: string, options: Parameters<typeof farmerWorld>[0]) {
  return {
    title,
    facts: `${FARMER_FACTS} ${facts}`,
    run: (register: ParameterRegister) => {
      const { evaluation, rules } = farmerEvaluation(register, options);
      const effect = evaluation.effect;
      const entry = effect?.taxEntries[0];
      const engine: CaseOutcome = {
        summary: effect
          ? `Propus: compensație ${lei(entry!.taxBani)} lei, dedusă ${lei(entry!.deductibleBani)} lei în octombrie 2026 (rd. 27 și 31)`
          : blocked(evaluation),
        lines: [...issueLines(evaluation), ...parameterLines(register, rules)],
      };
      const alternative: CaseOutcome = effect
        ? {
            summary: `Compensația de ${lei(entry!.taxBani)} lei se deduce abia în noiembrie 2026, la plată („compensația achitată”, art. 315^1 alin. (17)); în octombrie nimic`,
            lines: ['Rândul 27 al decontului pe octombrie 2026: 0 lei.'],
          }
        : { summary: engine.summary, lines: engine.lines };
      return { engine, alternative };
    },
  };
}

export const flatRateSpec: ReviewSpec = {
  key: 'ro.vat.flat_rate.agriculture',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Cumpărătorul înregistrat în scopuri de TVA deduce compensația în cotă forfetară (8% din prețul fără taxă, înscrisă pe factura agricultorului) în perioada livrării, ca pe TVA (art. 315^1 alin. (17): „în aceleași limite și condiții aplicabile pentru deducerea TVA”), dacă agricultorul era înscris în registrul ANAF la data livrării; o declară la rândurile 27 și 31.',
    alternative:
      'Compensația se deduce doar după ce a fost plătită agricultorului (textul spune „compensația în cotă forfetară achitată”): în perioada în care se face plata, nu în cea a livrării.',
  },
  question:
    'Compensația în cotă forfetară se deduce de cumpărător în perioada livrării, ca TVA, sau abia în perioada în care a fost plătită agricultorului („compensația achitată”, art. 315^1 alin. (17))?',
  context: [
    'ANAF/Cod-fiscal-consolidat:art.315^1(5)-(8)',
    'ANAF/Cod-fiscal-consolidat:art.297(4)',
    'OPANAF174/2026:rd.31',
    'OMFP1155/2016:anexa',
  ],
  cases: [
    farmerCase(
      'Legume de 10.000,00 lei, compensație 800,00 lei, agricultor înscris din 2025',
      'Factura: produse 10.000,00 lei, compensație 8%, 800,00 lei; total 10.800,00 lei. Extrasul din registru arată înscrierea din 01.03.2025.',
      { price: '10000.00', compensation: '800.00', registeredFrom: '2025-03-01' },
    ),
    farmerCase(
      'Agricultor înscris după data livrării',
      'Aceeași factură; extrasul arată înscrierea din 01.11.2026, după livrare.',
      { price: '10000.00', compensation: '800.00', registeredFrom: '2026-11-01' },
    ),
    farmerCase(
      'Compensație facturată la 9%',
      'Factura înscrie compensația de 900,00 lei (9%); agricultorul este înscris din 2025.',
      { price: '10000.00', compensation: '900.00', registeredFrom: '2025-03-01' },
    ),
  ],
  gaps: [
    'Registrul agricultorilor care aplică regimul special este public pe site-ul ANAF, dar fără un serviciu de interogare: înscrierea se dovedește cu extrasul, citat într-un răspuns (farmer.register).',
    'Unde se înscrie compensația pe factura agricultorului (o linie, o taxă suplimentară a documentului) nu este stabilit de ghidul ANAF al e-Facturii: motorul o citește ca diferența dintre totalul de plată și produse, comparată cu 8% (o diferență de un ban pe linie este admisă).',
    'D300: prețul produselor se înscrie la rândul 29 (achiziții „supuse unui regim special de taxă”), iar compensația doar la rândul 27, coloana TVA, și în rândul 31; dacă rândul 29 trebuie să cuprindă și achiziția de la agricultor este o citire a instrucțiunilor.',
    'D394: achiziția de la agricultor se declară ca achiziție de tip N (persoană neînregistrată), la prețul produselor, fără compensație; structura nu are un câmp pentru compensație.',
    'Partea agricultorului: impozitul pe venitul din activități agricole (art. 103–107: norme de venit, scutiri) și excluderea livrărilor agricole din cifra de afaceri a plafonului art. 310 (art. 315^1 alin. (4) lit. c)) nu sunt construite; închiderea obligațiilor raportează agricultorul ca neacoperit.',
  ],
};
