import type { ProfileFact } from '../../../kernel';
import { parseMoney } from '../../../money';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { invoiceDocumentSchema } from '../../../ubl/invoice-document';
import {
  determineVatPeriod,
  type Determination,
  type DeterminationContext,
  type Known,
  type YearFigures,
} from '../../determinations/determine';
import type { CapitalGoodsRule } from '../../nonpayers/parameters';
import { capitalGoodAdjustment, lateRegistrationExposure } from '../../nonpayers/regime';
import { crossBorderInput, crossBorderRecognition } from '../../treatments/cross-border';
import { invoiceKinds } from '../../treatments/invoices';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of the non-payers' module (src/ro/nonpayers) the texts leave open: the account a
 * non-payer owes the D301 VAT on, how the VAT of a late registration is computed and declared,
 * how the registration year's turnover is recalculated for the VAT period, and from when a
 * capital good's adjustment period runs. Each case runs the engine's code on a fixed company.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d7';
const SUPPLIER = '00000000-0000-4000-8000-0000000000c7';
const AUTHORITY = '00000000-0000-4000-8000-0000000000a7';
const bani = (text: string) => parseMoney(text, 'RON');
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

// ---------------------------------------------------------------------------------------------
// The account of the D301 VAT (art. 307 alin. (2), art. 324; OMFP nr. 1.802/2014, 4423)

function servicePurchase(country: string, taxId: string, net: string) {
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: 'ADS-1',
    issueDate: '2026-10-15',
    taxPointDate: null,
    currency: 'RON',
    supplier: { name: 'Furnizor din străinătate', taxId, country },
    customer: { name: 'Companie exemplu SRL', taxId: '18547290', country: 'RO' },
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017',
    lines: [{ id: '1', description: 'Servicii', net, vatCategory: 'AE', vatRate: '0' }],
    taxes: [{ base: net, tax: '0.00', category: 'AE', rate: '0', exemptionReason: null }],
    totals: {
      lineNet: net,
      net,
      tax: '0.00',
      gross: net,
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: net,
    },
  });
}

function specialPurchase(
  register: ParameterRegister,
  options: { country: string; taxId: string; net: string; code: 'special' | 'none' },
): CaseOutcome {
  const loaded = emptyLoaded([
    fact('vat.status', 'non_vat', '2020-01-01'),
    fact('vat.eu', options.code, '2020-01-01'),
  ]);
  const body = servicePurchase(options.country, options.taxId, options.net);
  (loaded.documents as Map<string, unknown>).set(DOCUMENT, {
    id: DOCUMENT,
    kind: invoiceKinds.purchase,
    schema: 'invoice',
    body,
    bodyHash: 'example',
    docDate: body.issueDate,
    partyId: SUPPLIER,
    currency: 'RON',
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
  const rules = rulesOf(register);
  const evaluation = crossBorderRecognition.evaluate(
    crossBorderInput.parse({
      documentId: DOCUMENT,
      account: '628',
      supply: 'services_general_rule',
      deduction: 'none',
      authorityId: AUTHORITY,
    }),
    loaded,
    rules,
  );
  const issues = evaluation.issues.map((issue) => `${issue.severity} ${issue.code}`);
  if (!evaluation.effect)
    return { summary: `Blocat: ${issues.join(', ')}`, lines: parameterLines(rules) };
  return {
    summary: `Propus: ${evaluation.effect.lines.map((line) => `${line.side === 'D' ? 'Dr' : 'Cr'} ${line.account} ${lei(line.bani)}`).join(' / ')}`,
    lines: [
      ...issues,
      ...evaluation.effect.taxEntries.map(
        (entry) =>
          `${entry.direction} ${entry.code}: bază ${lei(entry.baseBani)}, TVA ${lei(entry.taxBani)}`,
      ),
      ...parameterLines(rules),
    ],
  };
}

function payableCase(
  title: string,
  facts: string,
  options: Parameters<typeof specialPurchase>[1],
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: specialPurchase(register, options),
      // The alternative: the VAT on 4427 like a payer's reverse charge, settled into 4423.
      alternative: specialPurchase(
        withValue(register, 'ro.vat.special.payable_account', '4427'),
        options,
      ),
    }),
  };
}

export const specialPayableSpec: ReviewSpec = {
  key: 'ro.vat.special.payable_account',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Firma neînregistrată după art. 316 care datorează TVA pentru servicii cumpărate din străinătate (art. 307 alin. (2)) o înregistrează direct ca datorie față de buget, pe 4423, scadentă la termenul D301, iar taxa nedeductibilă intră în cheltuială; 4427/4426 nu se folosesc, firma nedepunând D300.',
    alternative:
      'Taxa se înregistrează pe 4427 ca la taxarea inversă a unui plătitor, apoi se închide în 4423 la sfârșitul lunii, odată cu D301.',
  },
  question:
    'Pe ce cont înregistrează o firmă neplătitoare de TVA taxa datorată prin decontul special (D301) pentru serviciile cumpărate de la prestatori nestabiliți în România: direct pe 4423 sau pe 4427, închis apoi în 4423?',
  context: [`${CODE}:art.317(1)`],
  cases: [
    payableCase(
      'Reclamă Meta din Irlanda, cu cod art. 317',
      'Factura de 1.000,00 lei (în lei, fără TVA) de la Meta Platforms Ireland, din 15.10.2026; firma are cod de TVA după art. 317.',
      { country: 'IE', taxId: 'IE9692928F', net: '1000.00', code: 'special' },
    ),
    payableCase(
      'Serviciu cloud din SUA',
      'Factura de 450,00 lei de la un prestator din SUA (fără cod de TVA european); firma nu are cod art. 317, care nu e cerut pentru servicii din afara Uniunii.',
      { country: 'US', taxId: '00-0000000', net: '450.00', code: 'none' },
    ),
    payableCase(
      'Servicii din Germania, fără cod art. 317',
      'Factura de 2.000,00 lei de la un prestator din Germania; firma nu și-a solicitat codul art. 317 (art. 317 alin. (1) lit. c)): taxa se datorează oricum.',
      { country: 'DE', taxId: 'DE123456789', net: '2000.00', code: 'none' },
    ),
  ],
  gaps: [
    'OMFP nr. 1.802/2014 nu descrie contabilitatea unei firme neplătitoare care datorează TVA prin decontul special; ambele citiri sunt practică, nu text.',
    'Taxa nedeductibilă se adaugă la cheltuiala serviciului (costul de achiziție cuprinde taxele nerecuperabile); 635 ar fi o altă citire, nefolosită de motor.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The VAT of a late registration (art. 310 alin. (6^1)–(6^3); norme pct. 36 lit. b) pct. 4)

function lateCase(
  title: string,
  facts: string,
  input: { revenue: string; abroad?: string; excluded?: string; purchases?: [string, string][] },
): ReviewCase {
  const run = (register: ParameterRegister, reading: 'inclusive' | 'added'): CaseOutcome => {
    const rules = rulesOf(register);
    const rule = rules.param<{ collected: string; deducted: string }>(
      'ro.vat.late_registration',
      'reporting_period_start',
      '2026-11-01' as LocalDate,
    );
    const rate = rules.param<string>(
      'ro.vat.rate',
      'vat_chargeability_date',
      '2026-10-05' as LocalDate,
      {
        category: 'S',
      },
    );
    const exposure = lateRegistrationExposure({
      from: '2026-10-05' as LocalDate,
      until: '2026-10-31' as LocalDate,
      revenueBani: bani(input.revenue),
      abroadBani: bani(input.abroad ?? '0'),
      excludedBani: bani(input.excluded ?? '0'),
      rate,
      limitedShare: '50',
      purchases: (input.purchases ?? []).map(([number, vat], index) => ({
        documentId: `p${index}`,
        number,
        taxPoint: '2026-10-20' as LocalDate,
        baseBani: (bani(vat) * 100n) / 21n,
        vatBani: bani(vat),
        deduction: 'full' as const,
      })),
    });
    const collected = exposure.collected[reading];
    return {
      summary: `TVA colectată ${lei(collected.vatBani)} lei (bază ${lei(collected.baseBani)}) pe rd. ${rule.collected.slice(1)}, dedusă ${lei(exposure.deductibleBani)} lei pe rd. 33: de plată ${lei(collected.vatBani - exposure.deductibleBani)} lei`,
      lines: [...exposure.lines, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register, 'inclusive'),
      alternative: run(register, 'added'),
    }),
  };
}

export const lateRegistrationSpec: ReviewSpec = {
  key: 'ro.vat.late_registration',
  kind: 'interpretation',
  act: CODE,
  minutes: 20,
  readings: {
    engine:
      'Firma care constată singură înregistrarea întârziată calculează TVA din prețul încasat (procedeul sutei mărite, 21 × 100 / 121), când declară că nu o poate recupera de la clienți (norme pct. 36 lit. b) pct. 4), scade TVA pe care ar fi dedus-o și înscrie colectata pe rd. 16 și deductibila pe rd. 33 ale primului decont după înregistrare (Dr 635 / Cr 4427, Dr 4426 / Cr 7588).',
    alternative:
      'TVA se adaugă prețului (cota de 21% aplicată contravalorii), ca la o livrare taxabilă obișnuită, chiar dacă clienții nu o plătesc.',
  },
  question:
    'Pentru vânzările făcute fără TVA între data depășirii plafonului și înregistrare (art. 310 alin. (6^2) lit. b)), taxa de plată se calculează din prețul încasat (21/121) când firma nu o poate recupera de la clienți, sau se adaugă prețului (21%)? Se înscrie pe rândurile 16 și 33 ale primului decont după înregistrare?',
  context: [`${CODE}:art.316(1)(b),(1^1)`, `${CODE}:norme.art.310.pct.84(2)-(3)`],
  cases: [
    lateCase(
      'Servicii facturate fără TVA după depășire',
      'Plafonul e depășit la 05.10.2026; până la 31.10.2026 firma facturează fără TVA servicii de 60.500,00 lei, fără achiziții cu TVA.',
      { revenue: '60500' },
    ),
    lateCase(
      'Cu achiziții deductibile',
      'Aceleași vânzări de 60.500,00 lei și două facturi de achiziție cu TVA de 1.050,00 lei și 420,00 lei, deductibile integral.',
      {
        revenue: '60500',
        purchases: [
          ['A-1', '1050'],
          ['A-2', '420'],
        ],
      },
    ),
    lateCase(
      'Cu servicii prestate în străinătate și ziua depășirii',
      'Venituri de 90.000,00 lei în interval, din care 15.000,00 lei servicii cu locul în alt stat membru și 4.500,00 lei facturate în ziua depășirii înaintea facturii care depășește plafonul, lăsate scutite.',
      { revenue: '90000', abroad: '15000', excluded: '4500' },
    ),
  ],
  gaps: [
    'Când clienții acceptă să plătească TVA peste preț, factura de corecție (art. 330) se înregistrează ca atare: motorul nu o produce încă (vat.lateRegistration refuză consideration: added).',
    'Decizia ANAF (art. 310 alin. (6^1)) se înregistrează în evidența obligațiilor față de buget (tax.decision), nu prin această regulă; suma negativă stabilită prin decizie (rd. 42) nu este încă scrisă în D300.',
    'Ajustarea stocurilor și a serviciilor neutilizate la data înregistrării (norme pct. 84 alin. (3) lit. a)) cere inventarierea și nu este acoperită.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The registration year's turnover, recalculated for a whole year (art. 322 alin. (4)–(5))

const known = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
function figures(year: number): YearFigures {
  const zero = known(0n);
  return {
    year,
    kept: true,
    turnover: zero,
    netTurnover: zero,
    totalRevenue: zero,
    vatTurnover: zero,
    exemptionTurnover: zero,
    totalAssets: zero,
    averageEmployees: known('0'),
    averageEmployeesD112: known('0'),
    euGoodsAcquisitions: known(false),
    eurRate: known({ rate: '5.0800', multiplier: 1, date: '2025-12-31' }),
  };
}
function periodOutcome(determination: Determination): CaseOutcome {
  return {
    summary:
      determination.status === 'proposed'
        ? `Propus: ${determination.value} de la ${determination.effectiveFrom}`
        : `Blocat: ${determination.status}`,
    lines: [...determination.lines, ...determination.versions.map((id) => `Parametru ${id}`)],
  };
}
function periodCase(
  title: string,
  facts: string,
  registration: string,
  supplies: [string, string][],
): ReviewCase {
  const run = (register: ParameterRegister) => {
    const context: DeterminationContext = {
      year: 2026,
      facts: [
        fact('vat.status', 'non_vat', '2020-01-01'),
        fact('vat.status', 'normal_vat', registration),
      ],
      previous: figures(2025),
      current: figures(2026),
      activity: {
        year: 2026,
        kept: true,
        quarterTurnover: [0n, 0n, 0n, 0n],
        days: supplies.map(([date, amount]) => ({
          date: date as LocalDate,
          exemption: bani(amount),
          vat: 0n,
        })),
      },
      contracts: [],
      micro: { known: false, reason: 'n/a', question: null },
      today: '2026-12-31' as LocalDate,
    };
    return periodOutcome(determineVatPeriod(context, rulesOf(register)));
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register),
      alternative: run(withValue(register, 'ro.vat.registration.annualized', 'months')),
    }),
  };
}

export const registrationAnnualizedSpec: ReviewSpec = {
  key: 'ro.vat.registration.annualized',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Cifra de afaceri obținută până la înregistrare se recalculează pentru un an întreg proporțional cu zilele de activitate (× 365 / zilele de la începutul anului sau al activității până în ziua dinaintea înregistrării).',
    alternative:
      'Se recalculează proporțional cu lunile calendaristice începute până la înregistrare (× 12 / lunile), luna înregistrării socotită întreagă.',
  },
  question:
    'La înregistrarea în scopuri de TVA în cursul anului (art. 322 alin. (4)), cifra de afaceri „recalculată în baza activității corespunzătoare unui an calendaristic întreg” se calculează pe zile sau pe luni de activitate?',
  context: [],
  cases: [
    periodCase(
      'Depășire în octombrie',
      'Firmă neplătitoare cu servicii de 200.000,00 lei la 10.03.2026 și 150.000,00 lei la 15.09.2026, care depășește plafonul la 05.10.2026 (100.000 € = 508.000,00 lei la cursul ipotetic 5,0800).',
      '2026-10-05',
      [
        ['2026-03-10', '200000'],
        ['2026-09-15', '150000'],
        ['2026-10-05', '50000'],
      ],
    ),
    periodCase(
      'Opțiune la începutul lunii',
      'Înregistrare prin opțiune la 02.08.2026, cu 300.000,00 lei din servicii până la 31.07.2026: pe 213 zile, ori pe 8 luni începute.',
      '2026-08-02',
      [['2026-07-31', '300000']],
    ),
    periodCase(
      'Depășire în iunie',
      'Servicii de 390.000,00 lei până la 29.05.2026 și depășirea plafonului la 01.06.2026.',
      '2026-06-01',
      [
        ['2026-05-29', '390000'],
        ['2026-06-01', '10000'],
      ],
    ),
  ],
  gaps: [
    'O înregistrare din oficiu are luna drept perioadă fiscală în anul înregistrării (norme pct. 103 alin. (1)): decizia o arată și se confirmă cu documentul.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The capital goods' adjustment period (art. 305 alin. (2)–(5))

function goodCase(
  title: string,
  facts: string,
  good: { invoiced: string; commissioned: string; vat: string; immovable: boolean },
  event: 'registration' | 'deregistration',
  date: string,
): ReviewCase {
  const run = (register: ParameterRegister, start: string): CaseOutcome => {
    const rules = rulesOf(register);
    const rule = rules.param<CapitalGoodsRule>(
      'ro.vat.capital_goods',
      'vat_chargeability_date',
      date as LocalDate,
    );
    const adjustment = capitalGoodAdjustment(
      {
        assetId: 'a1',
        number: 'MF-1',
        name: 'Bun de capital',
        immovable: good.immovable,
        acquiredOn: start as LocalDate,
        vatBani: bani(good.vat),
        deductedBani: event === 'deregistration' ? bani(good.vat) : 0n,
      },
      event,
      date as LocalDate,
      rule,
    );
    return {
      summary: `Ajustare ${lei(adjustment.bani)} lei (${adjustment.remaining} ani din ${adjustment.years})`,
      lines: [adjustment.line, ...parameterLines(rules)],
    };
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register, good.invoiced),
      alternative: run(register, good.commissioned),
    }),
  };
}

export const capitalGoodsSpec: ReviewSpec = {
  key: 'ro.vat.capital_goods',
  kind: 'interpretation',
  act: CODE,
  minutes: 15,
  readings: {
    engine:
      'Perioada de ajustare (5 ani, 20 pentru bunurile imobile: grupa 1 a catalogului sau contul 212) începe la 1 ianuarie a anului achiziției, data exigibilității facturii de achiziție; la trecerea între regimuri se ajustează o singură dată pentru anii rămași, inclusiv anul schimbării (art. 305 alin. (5) lit. a) și c)), pe rândul 34 al decontului.',
    alternative:
      'Perioada începe la 1 ianuarie a anului punerii în funcțiune a bunului, nu al facturii de achiziție.',
  },
  question:
    'Pentru ajustarea bunurilor de capital la anularea sau la obținerea înregistrării în scopuri de TVA, anul de început al perioadei de ajustare (art. 305 alin. (3) lit. a), „anul în care bunurile au fost achiziționate”) este anul facturii de achiziție sau al punerii în funcțiune?',
  context: [],
  cases: [
    goodCase(
      'Laptop cumpărat în decembrie, pus în funcțiune în ianuarie',
      'Laptop facturat la 20.12.2023 cu TVA dedusă de 2.100,00 lei, pus în funcțiune la 08.01.2024; înregistrarea în scopuri de TVA se anulează la 01.09.2026.',
      { invoiced: '2023-12-20', commissioned: '2024-01-08', vat: '2100', immovable: false },
      'deregistration',
      '2026-09-01',
    ),
    goodCase(
      'Clădire, anulare după opt ani',
      'Clădire cumpărată la 15.03.2018 cu TVA dedusă de 190.000,00 lei, pusă în funcțiune în același an; anularea înregistrării la 01.07.2026.',
      { invoiced: '2018-03-15', commissioned: '2018-04-10', vat: '190000', immovable: true },
      'deregistration',
      '2026-07-01',
    ),
    goodCase(
      'Echipament la înregistrare',
      'Echipament facturat la 28.12.2024 cu TVA nededusă de 4.200,00 lei (firma neplătitoare), pus în funcțiune la 10.01.2025; înregistrarea în scopuri de TVA la 05.10.2026.',
      { invoiced: '2024-12-28', commissioned: '2025-01-10', vat: '4200', immovable: false },
      'registration',
      '2026-10-05',
    ),
  ],
  gaps: [
    'Activele de dinainte de 2016 (art. 306) și ajustarea stocurilor, a serviciilor neutilizate și a avansurilor (art. 304) nu sunt calculate: vat.capitalGoods le refuză.',
  ],
};
