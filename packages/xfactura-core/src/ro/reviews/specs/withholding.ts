import type { AnswerRecord, Evaluation, Loaded, OpenItemState, PartyRecord } from '../../../kernel';
import { divRound, parseMoney, parseScaled } from '../../../money';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import {
  certificateCovers,
  nonresidentWithholding,
  payeeTag,
  payeeWithholding,
  type PayeeKind,
} from '../../treatments/withholding';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { emptyLoaded, lei } from './world';

/*
 * Readings of withholding (O1) where the Codul fiscal (ANAF's consolidation, updated through
 * Legea nr. 204/2026) leaves a choice the engine had to make. Every case runs the engine's own
 * treatments (`treatments/withholding.ts`) on a small world, against the register under review.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const AUTHORITY = '00000000-0000-4000-8000-0000000000a1';
const PERSON = '00000000-0000-4000-8000-0000000000b1';
const FOREIGN = '00000000-0000-4000-8000-0000000000b2';
const ITEM = '00000000-0000-4000-8000-0000000000f1';
const ENTRY = '00000000-0000-4000-8000-0000000000e1';
const CONTRACT = '00000000-0000-4000-8000-0000000000d1';
const CERTIFICATE = '00000000-0000-4000-8000-0000000000d2';
const TREATY = '00000000-0000-4000-8000-0000000000d3';
const ron = (text: string) => parseMoney(text, 'RON');

const party = (id: string, kind: string, country: string, name: string): PartyRecord => ({
  id,
  kind,
  country,
  taxId: null,
  name,
});

/** A payable of `gross` lei to the party, on an account, opened by a treatment with a tag. */
function payable(
  partyId: string,
  account: string,
  gross: bigint,
  origin?: { treatmentId: string; tag: string | null },
): OpenItemState {
  return {
    id: ITEM,
    kind: 'payable',
    controlAccount: account,
    partyId,
    currency: 'RON',
    normalSide: 'C',
    mayReverse: false,
    balanceBani: -gross,
    balanceMinor: -gross,
    documentId: null,
    dueDate: null,
    originEntryId: ENTRY,
    movements: 1,
    ...(origin
      ? {
          origin: {
            treatmentId: origin.treatmentId,
            subject: 'caz',
            date: '2026-01-31' as LocalDate,
            tag: origin.tag,
          },
        }
      : {}),
  };
}

function world(parties: PartyRecord[], item: OpenItemState, answers: AnswerRecord[] = []): Loaded {
  const loaded = emptyLoaded([]);
  return {
    ...loaded,
    parties: new Map(
      [party(AUTHORITY, 'ro_public_institution', 'RO', 'ANAF'), ...parties].map((item) => [
        item.id,
        item,
      ]),
    ),
    openItems: new Map([[item.id, item]]),
    answers: new Map(answers.map((answer) => [answer.questionId, answer])),
  };
}

/** What a treatment's evaluation shows a reviewer: its tax and lines, or why it is refused. */
function shown(evaluation: Evaluation): CaseOutcome {
  const blocks = evaluation.issues.filter((issue) => issue.severity === 'block');
  if (!evaluation.effect)
    return {
      summary: `Blocat: ${blocks.map((issue) => issue.code).join(', ')}`,
      lines: blocks.map((issue) => issue.message),
    };
  const details = evaluation.effect.explanation.details as {
    withholding?: { tax: string; base: string; rate: string };
  };
  const tax = BigInt(details.withholding?.tax ?? '0');
  return {
    summary: `Impozit ${lei(tax)} lei (cota ${details.withholding?.rate}% din ${lei(BigInt(details.withholding?.base ?? '0'))} lei)`,
    lines: [
      evaluation.effect.explanation.summary,
      ...evaluation.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ],
  };
}

const guarded = (run: () => CaseOutcome): CaseOutcome => {
  try {
    return run();
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
};

type RoyaltyFacts = {
  contributionsByContract: boolean;
  realSystem: boolean;
  collectiveShare: boolean;
};

/** The engine's evaluation of a payment of rent or intellectual property. */
const payeeEvaluation = (
  register: ParameterRegister,
  kind: PayeeKind,
  gross: string,
  date: string,
  royalties?: RoyaltyFacts,
) =>
  payeeWithholding.evaluate(
    {
      openItem: ITEM,
      date: date as LocalDate,
      gross,
      authorityId: AUTHORITY,
      ...(royalties ? { royalties } : {}),
    },
    world(
      [party(PERSON, 'ro_individual', 'RO', 'Popescu Ana')],
      payable(PERSON, '462', ron(gross), { treatmentId: 'payees.recognize', tag: payeeTag(kind) }),
    ),
    new RuleContext(register, 'preview'),
  );

/** The engine's withholding at a payment of rent or intellectual property. */
function payeeTax(
  register: ParameterRegister,
  kind: PayeeKind,
  gross: string,
  date: string,
  royalties?: RoyaltyFacts,
): CaseOutcome {
  return guarded(() => shown(payeeEvaluation(register, kind, gross, date, royalties)));
}

// ─── Rent: the tax of each payment, rounded at the payment ───────────────────────────────

/** The alternative: each payment's tax kept in bani, the month's total rounded once. */
function monthlyRounding(
  register: ParameterRegister,
  payments: readonly string[],
  date: string,
): CaseOutcome {
  return guarded(() => {
    const rules = new RuleContext(register, 'preview');
    const rate = rules.param<string>('ro.rent.tax_rate', 'payment_date', date as LocalDate);
    const expense = rules.param<string>('ro.rent.expense_rate', 'payment_date', date as LocalDate);
    let exact = 0n;
    const lines: string[] = [];
    for (const gross of payments) {
      const bani = ron(gross);
      const net = bani - divRound(bani * parseScaled(expense, 4), 1_000_000n, 'halfAwayFromZero');
      const tax = divRound(net * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
      exact += tax;
      lines.push(`Plata de ${lei(bani)} lei: venit net ${lei(net)} lei, impozit ${lei(tax)} lei.`);
    }
    const total = divRound(exact, 100n, 'halfAwayFromZero') * 100n;
    return { summary: `Impozit ${lei(total)} lei pentru lună`, lines };
  });
}

/** The engine: every payment's tax in whole lei, the month's the sum. */
function perPayment(
  register: ParameterRegister,
  payments: readonly string[],
  date: string,
): CaseOutcome {
  return guarded(() => {
    let total = 0n;
    const lines: string[] = [];
    for (const gross of payments) {
      const evaluation = payeeEvaluation(register, 'rent', gross, date);
      if (!evaluation.effect) return shown(evaluation);
      const details = evaluation.effect.explanation.details as { withholding: { tax: string } };
      total += BigInt(details.withholding.tax);
      lines.push(evaluation.effect.explanation.summary);
    }
    return { summary: `Impozit ${lei(total)} lei pentru lună`, lines };
  });
}

function rentCase(
  title: string,
  facts: string,
  payments: string[],
  date = '2026-03-10',
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: perPayment(register, payments, date),
      alternative: monthlyRounding(register, payments, date),
    }),
  };
}

export const rentRateSpec: ReviewSpec = {
  key: 'ro.rent.tax_rate',
  kind: 'interpretation',
  act: CODE,
  minutes: 12,
  readings: {
    engine:
      'La fiecare plată, venitul net este venitul brut minus 20% (art. 84^1 alin. (3)), la ban, iar impozitul de 10% din venitul net (alin. (5)) se rotunjește la leu pentru acea plată (OUG nr. 59/2005); D100 (628) declară suma impozitelor plăților lunii, D205 (tip 29) venitul net și impozitul anului; chiria se înregistrează 612 = 462, reținerea 462 = 446.',
    alternative:
      'Impozitul fiecărei plăți se calculează în lei și bani, iar suma lunii se rotunjește o singură dată la leu, în D100.',
  },
  question:
    'Se rotunjește la leu impozitul fiecărei plăți de chirie (cum îl reține plătitorul), sau doar totalul lunii declarat în D100? Și este corectă înregistrarea chiriei în 612 = 462 („creditori diverși”) pentru o persoană fizică, cu reținerea 462 = 446?',
  context: [
    `${CODE}:art.84^1(8)-(9)`,
    'ANAF/D100:nomenclator.withholding',
    'ANAF/D205:tip_venit.29',
  ],
  cases: [
    rentCase(
      'O chirie lunară rotundă',
      'Un SRL închiriază biroul de la asociatul său, persoană fizică rezidentă, cu 2.500,00 lei pe lună, plătiți la 10 martie 2026.',
      ['2500.00'],
    ),
    rentCase(
      'O chirie cu bani',
      'Chiria lunară este 1.234,56 lei, plătită o dată în martie 2026.',
      ['1234.56'],
    ),
    rentCase(
      'Trei plăți în aceeași lună',
      'Chiria se plătește în trei tranșe în martie 2026: 833,33, 833,33 și 833,34 lei.',
      ['833.33', '833.33', '833.34'],
    ),
    rentCase(
      'O plată din 2025, înaintea versiunii din registru',
      'Chiria din decembrie 2025, de 2.000,00 lei, plătită la 20 decembrie 2025. Registrul are cotele doar din 2026.',
      ['2000.00'],
      '2025-12-20',
    ),
  ],
  gaps: [
    'Data de aplicare a art. 84^1 (veniturile anului 2024, prin OUG nr. 115/2023) este citită în notele de consolidare ale portalului legislativ (forma din 2025), nu în actul de modificare; versiunea din registru începe la 01.01.2026, iar plățile mai vechi sunt RULE_GAP.',
    'Chiria în valută (alin. (2): cursul BNR din ziua precedentă plății), chiria plătită în natură și garanția reținută (alin. (8)), proprietarii nerezidenți (art. 223 alin. (2) lit. g)) nu sunt suportate.',
    'Contribuția de asigurări sociale de sănătate pe veniturile din chirii este a proprietarului (declarația unică); aplicația doar o semnalează.',
  ],
};

// ─── Intellectual property: the author's option for the real system ────────────────────────

const ipCase = (title: string, facts: string, gross: string): ReviewCase => ({
  title,
  facts,
  run: (register) => ({
    engine: payeeTax(register, 'royalties', gross, '2026-04-15', {
      contributionsByContract: false,
      realSystem: true,
      collectiveShare: false,
    }),
    alternative: payeeTax(register, 'royalties', gross, '2026-04-15', {
      contributionsByContract: false,
      realSystem: false,
      collectiveShare: false,
    }),
  }),
});

export const ipRateSpec: ReviewSpec = {
  key: 'ro.ip.tax_rate',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Plătitorul persoană juridică reține 10% din venitul net (venitul brut minus 40%, art. 72 alin. (2), (4)), impozit final, declarat în D112 (art. 132 alin. (2)); când autorul a optat pentru sistemul real (art. 73), dacă plătitorul mai reține nu rezultă din text, iar aplicația refuză (IP_REAL_SYSTEM).',
    alternative:
      'Opțiunea autorului pentru sistemul real (art. 73) nu schimbă obligația plătitorului: acesta reține tot 10% din venitul brut minus 40%, iar autorul regularizează prin declarația unică.',
  },
  question:
    'Când autorul a optat pentru determinarea venitului net în sistem real (art. 73), plătitorul persoană juridică mai reține impozitul de la art. 72 alin. (4), și cu ce bază?',
  context: [`${CODE}:art.73`, `${CODE}:art.151(5)-(8)`, `${CODE}:art.132(2)-exceptii`],
  cases: [
    ipCase(
      'Un drept de autor plătit o dată',
      'Un SRL plătește unui autor persoană fizică 10.000,00 lei pentru cesiunea drepturilor asupra unui text, la 15 aprilie 2026; autorul a optat pentru sistemul real.',
      '10000.00',
    ),
    ipCase('O sumă cu bani', 'Plata este de 3.333,33 lei, aceeași opțiune a autorului.', '3333.33'),
    ipCase(
      'O remunerație mică',
      'Plata este de 250,00 lei, aceeași opțiune a autorului.',
      '250.00',
    ),
  ],
  gaps: [
    'D112 pentru veniturile din drepturi de proprietate intelectuală (impozitul, și CAS și CASS când contractul o prevede) nu este scris de aplicație: obligația apare ca nesuportată în închiderea obligațiilor.',
    'Moștenitorii, dreptul de suită și copia privată (art. 72 alin. (3)) nu sunt suportate.',
  ],
};

// ─── Non-residents: an individual's 10% and the certificate ────────────────────────────────

const payeeAnswer = (income: string, beneficiary: 'company' | 'individual'): AnswerRecord => ({
  questionId: '00000000-0000-4000-8000-000000000101',
  answerId: '00000000-0000-4000-8000-000000000201',
  kind: 'nonresident.payee',
  subject: { kind: 'party', id: FOREIGN },
  params: {},
  value: {
    income,
    beneficiary,
    contractEvidenceId: CONTRACT,
    reason: 'Contractul de licență acordă dreptul de a reproduce și distribui programul.',
  },
  evidenceId: CONTRACT,
  answeredAt: '2026-01-05T08:00:00.000Z',
});
const certificateAnswer = (
  income: string,
  rate: string,
  presentedOn: string,
  year: number,
): AnswerRecord => ({
  questionId: '00000000-0000-4000-8000-000000000102',
  answerId: '00000000-0000-4000-8000-000000000202',
  kind: 'nonresident.certificate',
  subject: { kind: 'party', id: FOREIGN },
  params: { income },
  value: {
    certificateEvidenceId: CERTIFICATE,
    state: 'DE',
    year,
    presentedOn,
    income,
    treatyEvidenceId: TREATY,
    article: 'art. 12 alin. (2)',
    rate,
  },
  evidenceId: CERTIFICATE,
  answeredAt: '2026-01-06T08:00:00.000Z',
});

function nonresidentTax(
  register: ParameterRegister,
  options: {
    gross: string;
    date: string;
    beneficiary: 'company' | 'individual';
    certificate?: { rate: string; presentedOn: string; year: number };
  },
): CaseOutcome {
  return guarded(() =>
    shown(
      nonresidentWithholding.evaluate(
        {
          openItem: ITEM,
          date: options.date as LocalDate,
          gross: options.gross,
          authorityId: AUTHORITY,
          noExchangeOfInformation: false,
          borneBy: 'beneficiary',
        },
        world(
          [
            party(
              FOREIGN,
              'eu_taxable',
              'DE',
              options.beneficiary === 'company' ? 'Software GmbH' : 'Hans Müller',
            ),
          ],
          payable(FOREIGN, '401', ron(options.gross)),
          [
            payeeAnswer('royalties', options.beneficiary),
            ...(options.certificate
              ? [
                  certificateAnswer(
                    'royalties',
                    options.certificate.rate,
                    options.certificate.presentedOn,
                    options.certificate.year,
                  ),
                ]
              : []),
          ],
        ),
        new RuleContext(register, 'preview'),
      ),
    ),
  );
}

/** The alternative: an individual's residence in an EU state is shown without a certificate,
 * so lit. c^1)'s 10% applies to the gross. */
function individualWithoutCertificate(register: ParameterRegister, gross: string, date: string) {
  return guarded(() => {
    const rate = new RuleContext(register, 'preview').param<string>(
      'ro.nonresident.tax_rate',
      'payment_date',
      date as LocalDate,
      { income: 'royalties', beneficiary: 'individual_treaty' },
    );
    const tax =
      divRound(ron(gross) * parseScaled(rate, 4), 100_000_000n, 'halfAwayFromZero') * 100n;
    return {
      summary: `Impozit ${lei(tax)} lei (cota ${rate}% din ${lei(ron(gross))} lei)`,
      lines: [
        'Rezidența într-un stat membru UE, dovedită altfel decât prin certificat (contract, act de identitate).',
      ],
    };
  });
}

export const nonresidentRateSpec: ReviewSpec = {
  key: 'ro.nonresident.tax_rate',
  kind: 'interpretation',
  act: CODE,
  minutes: 15,
  readings: {
    engine:
      'Pe venitul brut, 16% (art. 224 alin. (4) lit. d)), iar 10% pentru o persoană fizică rezidentă într-un stat UE sau cu convenție (lit. c^1)) doar când rezidența e dovedită prin certificatul de rezidență fiscală (art. 230 alin. (2)); cota mai mică a convenției, cu certificatul valabil și articolul convenției, prevalează (alin. (1)). O licență de software e redevență doar după răspunsul unei persoane despre contract (art. 7 pct. 36).',
    alternative:
      'Cota de 10% a lit. c^1) este o cotă din Codul fiscal, nu din convenție: se aplică persoanei fizice rezidente în UE sau într-un stat cu convenție și fără certificat, rezidența putând fi dovedită și altfel.',
  },
  question:
    'Cota de 10% de la art. 224 alin. (4) lit. c^1) pentru persoanele fizice rezidente în UE sau într-un stat cu convenție cere certificatul de rezidență fiscală (art. 230 alin. (2)), sau rezidența se poate dovedi și altfel?',
  context: [
    `${CODE}:art.7.pct.36`,
    `${CODE}:norme.art.223.pct.2`,
    `${CODE}:art.224(4)(c^1)`,
    `${CODE}:art.229(1)`,
  ],
  cases: [
    {
      title: 'Redevență plătită unei persoane fizice din Germania, fără certificat',
      facts:
        'Un SRL plătește 10.000,00 lei unui programator persoană fizică rezident în Germania pentru licența de a reproduce și distribui un program, la 20 martie 2026; certificatul de rezidență nu a fost prezentat.',
      run: (register) => ({
        engine: nonresidentTax(register, {
          gross: '10000.00',
          date: '2026-03-20',
          beneficiary: 'individual',
        }),
        alternative: individualWithoutCertificate(register, '10000.00', '2026-03-20'),
      }),
    },
    {
      title: 'Aceeași redevență, cu certificat și convenția (5%)',
      facts:
        'Certificatul de rezidență pentru 2026 a fost prezentat la 10 martie 2026; convenția România–Germania, art. 12 alin. (2), dă 5% pentru redevențe (cota din răspuns, de verificat în textul convenției).',
      run: (register) => ({
        engine: nonresidentTax(register, {
          gross: '10000.00',
          date: '2026-03-20',
          beneficiary: 'individual',
          certificate: { rate: '5', presentedOn: '2026-03-10', year: 2026 },
        }),
        alternative: nonresidentTax(register, {
          gross: '10000.00',
          date: '2026-03-20',
          beneficiary: 'individual',
          certificate: { rate: '5', presentedOn: '2026-03-10', year: 2026 },
        }),
      }),
    },
    {
      title: 'Licență de software de la o societate din Germania, fără certificat',
      facts:
        'Un SRL plătește 4.000,00 lei unei societăți din Germania pentru o licență de software care îi dă dreptul de a reproduce programul, la 20 martie 2026, fără certificat.',
      run: (register) => ({
        engine: nonresidentTax(register, {
          gross: '4000.00',
          date: '2026-03-20',
          beneficiary: 'company',
        }),
        alternative: nonresidentTax(register, {
          gross: '4000.00',
          date: '2026-03-20',
          beneficiary: 'company',
        }),
      }),
    },
  ],
  gaps: [
    'Cotele convențiilor nu sunt în registru: fiecare vine dintr-un răspuns (nonresident.certificate) cu certificatul și textul convenției; aplicația nu are o listă a convențiilor și nu verifică articolul.',
    'Scutirile din directivele UE (art. 229 alin. (1) lit. c) și g)), impozitul suportat de plătitor (metoda sutei mărite), cota de 50% (lit. c)) și sumele în valută nu sunt suportate; serviciile cu cota unei convenții nu au cod în D207.',
    'Dacă o licență de tip SaaS (acces la un program găzduit) este redevență sau serviciu nu decide aplicația: răspunsul despre fiecare furnizor, cu contractul.',
  ],
};

// ─── The certificate's validity ─────────────────────────────────────────────────────────────

function covers(
  register: ParameterRegister,
  certificate: { presentedOn: string; year: number },
  date: string,
  alternative: boolean,
): CaseOutcome {
  return guarded(() => {
    const days = new RuleContext(register, 'preview').param<number>(
      'ro.nonresident.certificate_days',
      'payment_date',
      date as LocalDate,
    );
    const valid = alternative
      ? certificate.presentedOn <= date
      : certificateCovers(certificate, date as LocalDate, days);
    return {
      summary: valid ? 'Certificatul acoperă plata' : 'Certificatul nu acoperă plata',
      lines: [
        `Prezentat la ${certificate.presentedOn}, atestă ${certificate.year}; plata la ${date}${alternative ? '' : `; ${days} zile din anul următor`}.`,
      ],
    };
  });
}

const certificateCase = (
  title: string,
  facts: string,
  certificate: { presentedOn: string; year: number },
  date: string,
): ReviewCase => ({
  title,
  facts,
  run: (register) => ({
    engine: covers(register, certificate, date, false),
    alternative: covers(register, certificate, date, true),
  }),
});

export const certificateDaysSpec: ReviewSpec = {
  key: 'ro.nonresident.certificate_days',
  kind: 'interpretation',
  act: CODE,
  minutes: 8,
  readings: {
    engine:
      'Certificatul prezentat într-un an, care atestă rezidența pe acel an, acoperă plățile de după prezentare din acel an și pe cele din primele 60 de zile calendaristice ale anului următor (art. 230 alin. (2)); altfel se aplică cota din Codul fiscal.',
    alternative:
      'Certificatul prezentat acoperă orice plată ulterioară până la prezentarea altuia, dacă rezidența nu se schimbă.',
  },
  question:
    'Până când acoperă plățile un certificat de rezidență fiscală prezentat în cursul unui an: doar anul prezentării și primele 60 de zile ale anului următor, sau până la schimbarea condițiilor de rezidență?',
  context: [],
  cases: [
    certificateCase(
      'Plată în februarie a anului următor',
      'Certificat pentru 2026, prezentat la 1 martie 2026; plata redevenței la 15 februarie 2027.',
      { presentedOn: '2026-03-01', year: 2026 },
      '2027-02-15',
    ),
    certificateCase(
      'Plată în martie a anului următor',
      'Același certificat; plata la 10 martie 2027, după primele 60 de zile.',
      { presentedOn: '2026-03-01', year: 2026 },
      '2027-03-10',
    ),
    certificateCase(
      'Plată înaintea prezentării',
      'Certificat pentru 2026 prezentat la 1 martie 2026; plata la 1 februarie 2026.',
      { presentedOn: '2026-03-01', year: 2026 },
      '2026-02-01',
    ),
  ],
  gaps: [
    'Regularizarea impozitului reținut la cota din Codul fiscal când certificatul se prezintă ulterior, în termenul de prescripție (art. 230 alin. (2)), nu este suportată.',
  ],
};

// ─── Interim dividends: the rate at the interim decision ───────────────────────────────────

function dividendRate(register: ParameterRegister, date: string): CaseOutcome {
  return guarded(() => {
    const rate = new RuleContext(register, 'preview').param<string>(
      'ro.dividend.tax_rate',
      'distribution_decision_date',
      date as LocalDate,
      { beneficiary: 'individual' },
    );
    return { summary: `Cota ${rate}%`, lines: [`Cota dividendelor distribuite la ${date}.`] };
  });
}

const interimCase = (
  title: string,
  facts: string,
  interim: string,
  annual: string,
): ReviewCase => ({
  title,
  facts,
  run: (register) => ({
    engine: dividendRate(register, interim),
    alternative: dividendRate(register, annual),
  }),
});

export const dividendRateSpec: ReviewSpec = {
  key: 'ro.dividend.tax_rate',
  kind: 'interpretation',
  act: CODE,
  minutes: 10,
  readings: {
    engine:
      'Dividendele interimare (463 = 456, OMFP nr. 3.067/2018) se impozitează la plată cu cota în vigoare la data hotărârii de distribuire interimară, fără recalculare la regularizarea pe seama dividendelor anuale (457 = 463), cum prevede art. VII alin. (2) din Legea nr. 141/2025 pentru cele din 2025.',
    alternative:
      'Dividendele interimare se impozitează definitiv cu cota de la data repartizării anuale, care le regularizează: diferența de cotă se reține sau se restituie la regularizare.',
  },
  question:
    'Cota impozitului pe dividendele interimare este cea de la data hotărârii de distribuire interimară, fără recalculare la regularizare, sau cea de la data repartizării anuale care le regularizează?',
  context: [
    `${CODE}:art.97(7)-interimare`,
    'L82/1991:art.19(3)-(3^2)',
    'OMFP3067/2018:pct.423^1-423^2',
  ],
  cases: [
    interimCase(
      'Dividende interimare în 2026, regularizate în același an',
      'Situații interimare la 30 iunie 2026; hotărârea de distribuire la 15 august 2026; repartizarea anuală la 30 decembrie 2026 (ipotetic).',
      '2026-08-15',
      '2026-12-30',
    ),
    interimCase(
      'Dividende interimare în 2026, regularizate în 2027',
      'Hotărârea de distribuire interimară la 15 octombrie 2026; situațiile anuale pe 2026 aprobate și dividendele repartizate la 30 aprilie 2027. Registrul nu are cote pentru 2027.',
      '2026-10-15',
      '2027-04-30',
    ),
    interimCase(
      'Dividende interimare în 2025, regularizate în 2026',
      'Hotărârea de distribuire interimară la 15 septembrie 2025; repartizarea anuală la 30 aprilie 2026. Registrul nu are cota din 2025 (10%, art. VII alin. (2) din Legea nr. 141/2025).',
      '2025-09-15',
      '2026-04-30',
    ),
  ],
  gaps: [
    'Cota de 10% pentru dividendele interimare din 2025 (Legea nr. 141/2025 art. VII alin. (2)) nu este în registru: plățile lor sunt RULE_GAP.',
    'Dividendele interimare mai mari decât cele anuale, restituite în 60 de zile, și impozitul reținut pe ele nu sunt suportate (INTERIM_EXCESS).',
  ],
};
