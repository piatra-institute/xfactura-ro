import type { Loaded, ProfileFact } from '../../../kernel';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema } from '../../../ubl/invoice-document';
import {
  calculateD398,
  type D398,
  type D398Correction,
  type D398Supply,
} from '../../declarations/d398';
import type { DeterminationContext, Known } from '../../determinations/determine';
import { determineVatDistance, type DistanceSale } from '../../oss/determine';
import type { OssDeclarations } from '../../oss/parameters';
import { euConsumerInput, euConsumerRecognition } from '../../oss/treatment';
import { invoiceKinds } from '../../treatments/invoices';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of the distance sales and the One Stop Shop (src/ro/oss) the texts leave open: where
 * D300 reports the Union scheme's sales, the account their VAT is owed on, from which sale the
 * place moves to the destination, and in which quarter's return a refund of an earlier quarter's
 * sale is declared. Each case runs the engine's code on a fixed company.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const DOCUMENT = '00000000-0000-4000-8000-0000000000f1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000f2';
const AUTHORITY = '00000000-0000-4000-8000-0000000000f3';
const fact = (axis: string, value: string, from: string): ProfileFact => ({
  axis,
  value,
  effectiveFrom: from as LocalDate,
});
const rulesOf = (register: ParameterRegister) => new RuleContext(register, 'preview');
const withValue = (register: ParameterRegister, key: string, value: unknown) =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const parameterLines = (rules: RuleContext) =>
  [...rules.used.keys()].map((id) => `Parametru ${id}`);
const registered = [
  fact('vat.status', 'normal_vat', '2020-01-01'),
  fact('vat.period', 'quarterly', '2026-01-01'),
  fact('vat.distance', 'destination', '2026-01-01'),
  fact('vat.oss', 'union', '2026-01-01'),
];

/** An issued invoice in euro to a consumer of `country`, at the state's `rate`. */
function consumerSale(country: string, net: string, rate: string, tax: string): Loaded {
  const body = invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: 'EB-100',
    issueDate: '2026-08-10',
    taxPointDate: null,
    currency: 'EUR',
    supplier: { name: 'Exemplu Digital SRL', taxId: 'RO18547290', country: 'RO' },
    customer: { name: 'Consumator', taxId: '0000000000000', country },
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017',
    lines: [{ id: '1', description: 'Curs online', net, vatCategory: 'S', vatRate: rate }],
    taxes: [{ base: net, tax, category: 'S', rate, exemptionReason: null }],
    totals: {
      lineNet: net,
      net,
      tax,
      gross: (Number(net) + Number(tax)).toFixed(2),
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: (Number(net) + Number(tax)).toFixed(2),
    },
  });
  const loaded = emptyLoaded(registered);
  (loaded.documents as Map<string, unknown>).set(DOCUMENT, {
    id: DOCUMENT,
    kind: invoiceKinds.sale,
    schema: 'invoice',
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: CUSTOMER,
    currency: 'EUR',
    number: body.number,
    evidenceId: null,
  });
  (loaded.parties as Map<string, unknown>).set(AUTHORITY, {
    id: AUTHORITY,
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '8000000000',
    name: 'ANAF',
  });
  (loaded.fxRates as Map<string, unknown>).set('EUR', [
    {
      id: 'bnr',
      source: 'BNR',
      currency: 'EUR',
      date: '2026-08-07',
      rate: '5.0700',
      multiplier: 1,
    },
  ]);
  return loaded;
}

function booked(
  register: ParameterRegister,
  sale: { country: string; net: string; rate: string; tax: string },
): CaseOutcome & { base: bigint } {
  const rules = rulesOf(register);
  const evaluation = euConsumerRecognition.evaluate(
    euConsumerInput.parse({
      documentId: DOCUMENT,
      account: '704',
      supply: 'electronic',
      authorityId: AUTHORITY,
      location: [
        { kind: 'billing_address', country: sale.country },
        { kind: 'ip', country: sale.country },
      ],
    }),
    consumerSale(sale.country, sale.net, sale.rate, sale.tax),
    rules,
  );
  const issues = evaluation.issues.map((issue) => `${issue.severity} ${issue.code}`);
  if (!evaluation.effect)
    return { summary: `Blocat: ${issues.join(', ')}`, lines: parameterLines(rules), base: 0n };
  return {
    summary: `Propus: ${evaluation.effect.lines.map((line) => `${line.side === 'D' ? 'Dr' : 'Cr'} ${line.account} ${lei(line.bani)}`).join(' / ')}`,
    lines: [
      ...evaluation.effect.taxEntries.map(
        (entry) =>
          `${entry.code} ${entry.attributes.country} ${entry.attributes.rate}%: bază ${lei(entry.baseBani)} lei, TVA ${lei(entry.taxBani)} lei (${entry.attributes.taxMinor} cenți)`,
      ),
      ...parameterLines(rules),
    ],
    base: evaluation.effect.taxEntries.reduce((sum, entry) => sum + entry.baseBani, 0n),
  };
}

// ---------------------------------------------------------------------------------------------
// Where D300 reports the Union scheme's sales (OPANAF nr. 174/2026 rd. 3; ANAF's SAF-T 310340)

function placementCase(
  title: string,
  facts: string,
  sale: { country: string; net: string; rate: string; tax: string },
): ReviewCase {
  const run = (register: ParameterRegister): CaseOutcome => {
    const outcome = booked(register, sale);
    const rules = rulesOf(register);
    const placement = rules.param<OssDeclarations>(
      'ro.vat.oss.declarations',
      'reporting_period_start',
      '2026-07-01' as LocalDate,
    ).d300;
    return {
      summary:
        placement === 'R3'
          ? `D300 rd. 3 (bază): ${lei(outcome.base)} lei; D398 cu TVA statului membru.`
          : 'D300: nimic; vânzarea se declară numai în D398.',
      lines: [...outcome.lines, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register),
      alternative: run(
        withValue(register, 'ro.vat.oss.declarations', {
          d300: 'R3',
          d394: 'none',
          d406: '310340',
        }),
      ),
    }),
  };
}

export const ossDeclarationsSpec: ReviewSpec = {
  key: 'ro.vat.oss.declarations',
  kind: 'interpretation',
  act: 'OPANAF174/2026',
  minutes: 10,
  readings: {
    engine:
      'Vânzările declarate în regimul special Uniune nu se înscriu în decontul 300: nomenclatorul SAF-T al ANAF (16.02.2026) leagă codul lor, 310340, numai de declarația 398, fără rând D300; nici în D394, care cuprinde operațiunile cu locul în România.',
    alternative:
      'Se înscriu, ca bază, la rândul 3 al decontului 300, a cărui instrucțiune cuprinde toate livrările și prestările fără locul în România după art. 275 și 278.',
  },
  question:
    'Se raportează în decontul 300 vânzările la distanță și serviciile electronice către consumatori din alte state membre, declarate în regimul special Uniune (D398)?',
  context: [`${CODE}:art.275(2)`, `${CODE}:art.278(5)(h)`, `${CODE}:art.315(7)-(10)`],
  cases: [
    placementCase(
      'Curs online vândut unui consumator din Germania',
      'Firmă înregistrată în OSS din 2026; factura de 100,00 EUR + TVA Germania 19% (19,00 EUR) din 10.08.2026, curs BNR 5,0700.',
      { country: 'DE', net: '100.00', rate: '19', tax: '19.00' },
    ),
    placementCase(
      'Abonament electronic în Franța',
      'Aceeași firmă; 1.000,00 EUR + TVA Franța 20% (200,00 EUR).',
      { country: 'FR', net: '1000.00', rate: '20', tax: '200.00' },
    ),
    placementCase(
      'Licență de software descărcată în Italia',
      'Aceeași firmă; 500,00 EUR + TVA Italia 22% (110,00 EUR).',
      { country: 'IT', net: '500.00', rate: '22', tax: '110.00' },
    ),
  ],
  gaps: [
    'Instrucțiunea rândului 3 (OPANAF nr. 174/2026) nu numește regimul special; nomenclatorul SAF-T, care leagă 310340 de D398, nu este un act normativ.',
    'Nu am găsit un ghid ANAF publicat despre rândul D300 al vânzărilor OSS.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The account the Union scheme's VAT is owed on (art. 315 alin. (13); OMFP nr. 1.802/2014)

function payableCase(
  title: string,
  facts: string,
  sale: { country: string; net: string; rate: string; tax: string },
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => {
      const outcome = ({ summary, lines }: CaseOutcome) => ({ summary, lines });
      return {
        engine: outcome(booked(register, sale)),
        alternative: outcome(
          booked(withValue(register, 'ro.vat.oss.payable_account', '4427'), sale),
        ),
      };
    },
  };
}

export const ossPayableSpec: ReviewSpec = {
  key: 'ro.vat.oss.payable_account',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'TVA statului membru de consum se înregistrează direct ca datorie față de ANAF pe 4423, în euro, scadentă la termenul D398; nu trece prin 4427, care se închide prin decontul 300 în TVA românească de plată.',
    alternative:
      'TVA se înregistrează pe un analitic al lui 4427 („TVA colectată OSS”), închis la sfârșitul trimestrului într-un analitic al lui 4423, separat de decontul 300.',
  },
  question:
    'Pe ce cont se înregistrează TVA datorată altor state membre prin regimul special Uniune (OSS): direct pe 4423 sau pe 4427 (analitic distinct) închis apoi în 4423?',
  context: [`${CODE}:art.315(6)-(6^1)`],
  cases: [
    payableCase(
      'Consumator din Germania, 19%',
      'Factura de 100,00 EUR + 19,00 EUR TVA Germania, curs BNR 5,0700.',
      { country: 'DE', net: '100.00', rate: '19', tax: '19.00' },
    ),
    payableCase('Consumator din Franța, 20%', 'Factura de 1.000,00 EUR + 200,00 EUR TVA Franța.', {
      country: 'FR',
      net: '1000.00',
      rate: '20',
      tax: '200.00',
    }),
    payableCase(
      'Consumator din Finlanda, 25,5%',
      'Factura de 200,00 EUR + 51,00 EUR TVA Finlanda.',
      { country: 'FI', net: '200.00', rate: '25.5', tax: '51.00' },
    ),
  ],
  gaps: [
    'OMFP nr. 1.802/2014 nu descrie TVA datorată altor state membre prin regimul special; ambele citiri sunt practică, nu text.',
    'Pe 4427, aplicația ar închide TVA prin decontul 300 (vat.settle) odată cu TVA românească: citirea alternativă cere o închidere separată, pe care motorul nu o face.',
  ],
};

// ---------------------------------------------------------------------------------------------
// From which sale the place moves to the destination (art. 278^1 alin. (2))

const figure = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
function crossing(register: ParameterRegister, sales: DistanceSale[], next: boolean): CaseOutcome {
  const rules = rulesOf(register);
  const context = {
    year: 2026,
    facts: [fact('vat.status', 'normal_vat', '2020-01-01')],
    previous: { year: 2025, kept: true, distanceTurnover: figure(0n) },
    current: { year: 2026, kept: true },
    activity: {
      year: 2026,
      kept: true,
      quarterTurnover: [0n, 0n, 0n, 0n],
      days: [],
      distance: sales,
    },
    contracts: [],
    micro: { known: false, reason: 'n/a', question: null },
    today: '2026-11-05' as LocalDate,
  } as unknown as DeterminationContext;
  const determination = determineVatDistance(context, rules);
  const change = determination.changes[0];
  // The alternative: the sale that exceeds stays in Romania; the next one moves.
  const from = !change
    ? null
    : next
      ? (sales.find((sale) => sale.date > change.effectiveFrom)?.date ?? 'următoarea vânzare')
      : change.effectiveFrom;
  return {
    summary: from ? `Locul la destinație de la ${from}.` : 'Locul rămâne în România tot anul.',
    lines: [...determination.lines, ...parameterLines(rules)],
  };
}
const distanceSale = (date: string, base: string): DistanceSale => ({
  date: date as LocalDate,
  documentId: `doc-${date}`,
  number: `F-${date}`,
  base: BigInt(Math.round(Number(base) * 100)),
  regime: 'origin',
  country: 'DE',
});
function crossingCase(title: string, facts: string, sales: DistanceSale[]): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: crossing(register, sales, false),
      alternative: crossing(register, sales, true),
    }),
  };
}

export const distanceThresholdSpec: ReviewSpec = {
  key: 'ro.vat.distance.threshold',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Pragul de 46.337 lei se cumulează pe bazele în lei ale vânzărilor la distanță și serviciilor TBE ale anului (oricare le e locul); vânzarea care îl depășește are deja locul la destinație („de la momentul depășirii”), cele anterioare rămân în România.',
    alternative:
      'Vânzarea care depășește pragul rămâne în România; locul la destinație se aplică vânzărilor următoare.',
  },
  question:
    'Vânzarea prin care se depășește în cursul anului pragul de 10.000 € (46.337 lei) al art. 278^1 are locul în România sau la destinație?',
  context: [`${CODE}:art.278^1(5)`, 'OPANAF174/2026:rd.17-18'],
  cases: [
    crossingCase(
      'Depășire în iulie',
      'Servicii electronice către consumatori din Germania: 20.000 lei în februarie, 20.000 lei în mai, 6.338 lei pe 3 iulie, 1.000 lei pe 20 iulie (baze fără TVA).',
      [
        distanceSale('2026-02-10', '20000'),
        distanceSale('2026-05-10', '20000'),
        distanceSale('2026-07-03', '6338'),
        distanceSale('2026-07-20', '1000'),
      ],
    ),
    crossingCase(
      'Exact la prag',
      'Vânzări de 46.337 lei în total până pe 30 iunie, apoi 100 lei pe 1 iulie.',
      [distanceSale('2026-06-30', '46337'), distanceSale('2026-07-01', '100')],
    ),
    crossingCase(
      'O singură vânzare mare',
      'O singură factură de 50.000 lei pe 15 martie, nicio altă vânzare.',
      [distanceSale('2026-03-15', '50000')],
    ),
  ],
  gaps: [
    'Regulamentul de punere în aplicare (UE) nr. 282/2011 (versiunea consolidată din 14.04.2025, în registru) nu detaliază momentul depășirii pragului de 10.000 €: o face doar pentru pragul de 100.000 € al probelor locului clientului (art. 24b al treilea paragraf: „începând din acel moment”); notele explicative ale Comisiei privind comerțul electronic nu sunt în registrul surselor.',
    'Cursul la care se cumulează vânzările în valută (al TVA, art. 290, cum le înregistrează motorul) nu este precizat de art. 278^1.',
  ],
};

// ---------------------------------------------------------------------------------------------
// A refund of an earlier quarter's sale (art. 315 alin. (11); ANAF's structure, CORRECTION)

function refundReturn(
  refund: { state: string; rate: string; taxable: bigint; vat: bigint },
  quarter: D398Supply[],
  asCorrection: boolean,
): CaseOutcome {
  const supplies = asCorrection
    ? quarter
    : quarter.map((item) =>
        item.state === refund.state && Number(item.rate) === Number(refund.rate)
          ? {
              ...item,
              taxableCents: item.taxableCents - refund.taxable,
              vatCents: item.vatCents - refund.vat,
            }
          : item,
      );
  const corrections: D398Correction[] = asCorrection
    ? [{ state: refund.state, year: 2026, month: 9, vatCents: -refund.vat }]
    : [];
  const model: D398 = {
    period: { year: 2026, month: 12 },
    vatId: '18547290',
    name: 'Exemplu Digital SRL',
    supplies,
    corrections,
  };
  const calculation = calculateD398(model);
  const negative = supplies.some((item) => item.vatCents <= 0n);
  const euro = (cents: bigint) => (Number(cents) / 100).toFixed(2);
  return {
    summary: negative
      ? `D398 T4: operațiuni negative în ${refund.state}, pe care structura ANAF nu le admite (taxable_amount > 0).`
      : `D398 T4: de plată ${euro(calculation.due)} €.`,
    lines: [
      ...supplies.map(
        (item) =>
          `${item.state} ${item.rate}%: ${euro(item.taxableCents)} € / TVA ${euro(item.vatCents)} €`,
      ),
      ...corrections.map((item) => `Corecție ${item.state} T3 2026: ${euro(item.vatCents)} €`),
    ],
  };
}
function refundCase(
  title: string,
  facts: string,
  refund: { state: string; rate: string; taxable: bigint; vat: bigint },
  quarter: D398Supply[],
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => {
      // The rule the cases follow: a correction within the register's years.
      rulesOf(register).param(
        'ro.vat.oss.return',
        'reporting_period_start',
        '2026-10-01' as LocalDate,
      );
      return {
        engine: refundReturn(refund, quarter, true),
        alternative: refundReturn(refund, quarter, false),
      };
    },
  };
}
const supply = (state: string, rate: string, taxable: number, vat: number): D398Supply => ({
  state,
  type: 'services',
  rateType: 'standard',
  rate,
  taxableCents: BigInt(taxable * 100),
  vatCents: BigInt(vat * 100),
});

export const ossReturnSpec: ReviewSpec = {
  key: 'ro.vat.oss.return',
  kind: 'interpretation',
  act: CODE,
  minutes: 15,
  readings: {
    engine:
      'O notă de credit pentru o vânzare dintr-un trimestru deja declarat se declară în declarația trimestrului ei ca o corecție a trimestrului vânzării (CORRECTION, negativă), nu ca reducere a operațiunilor trimestrului curent; o vânzare în altă monedă se convertește la cursul BCE din ultima zi a perioadei sau de la următoarea publicare.',
    alternative:
      'Nota de credit reduce operațiunile trimestrului în care se emite (SUPPLY), ca o ajustare a bazei la data ei (art. 287), iar corecțiile privesc numai erorile.',
  },
  question:
    'Cum se declară în declarația specială 398 nota de credit emisă în trimestrul IV pentru o vânzare OSS din trimestrul III, deja declarat: corecție a trimestrului III sau reducere a operațiunilor trimestrului IV?',
  context: [`${CODE}:art.315(7)-(10)`, 'ANAF/D398:structura', 'REG282/2011-A:art.61'],
  cases: [
    refundCase(
      'Rambursarea a jumătate dintr-un curs vândut în Franța',
      'T3: vânzare de 1.000 € + 200 € TVA Franța, declarată și plătită; în T4: notă de credit de 500 € + 100 €; în T4 nu mai sunt vânzări în Franța, ci o vânzare în Germania de 200 € + 38 €.',
      { state: 'FR', rate: '20', taxable: 50000n, vat: 10000n },
      [supply('DE', '19', 200, 38)],
    ),
    refundCase(
      'Rambursare parțială, cu vânzări în T4 în același stat',
      'T3: 1.000 € + 200 € în Franța; T4: vânzări în Franța de 2.000 € + 400 € și nota de credit de 500 € + 100 € pentru vânzarea din T3.',
      { state: 'FR', rate: '20', taxable: 50000n, vat: 10000n },
      [supply('FR', '20', 2000, 400)],
    ),
    refundCase(
      'Rambursare integrală în Italia',
      'T3: 500 € + 110 € în Italia; T4: nota de credit integrală, plus vânzări de 300 € + 66 € în Italia.',
      { state: 'IT', rate: '22', taxable: 50000n, vat: 11000n },
      [supply('IT', '22', 300, 66)],
    ),
  ],
  gaps: [
    'Articolul 61 din Regulamentul de punere în aplicare (UE) nr. 282/2011 (în registru) confirmă mecanismul: cifrele unei declarații depuse, din trimestrul III 2021 încolo, se modifică numai prin ajustări într-o declarație ulterioară, în trei ani de la termenul declarației inițiale; dacă o notă de credit este o astfel de modificare sau o reducere a trimestrului în care se emite nu spune; notele explicative ale Comisiei privind comerțul electronic (2020) nu sunt în registrul surselor.',
    'Textul român (art. 315 alin. (12)) spune „din ziua următoare”; motorul citește următoarea zi de publicare a BCE.',
  ],
};
