import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate, Month } from '../../../time';
import { voucherExcess } from '../../payroll/benefits';
import { calculatePay, type PayInput } from '../../payroll/calculate';
import { regesDeadline, type RegesField } from '../../payroll/reges';
import { garnish, type GarnishmentOrder } from '../../payroll/garnishment';
import { sickIndemnity, type SickCertificate, type SickCodeRule } from '../../payroll/sick-leave';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';
import { lei } from './world';

/*
 * Readings for the payroll extras (W1): the administrator's mandate, garnishments, the correction
 * of a month for a retroactive change and the medical-leave codes. Every outcome is computed by
 * the engine's own functions against the register under review.
 */

const rules = (register: ParameterRegister) => new RuleContext(register, 'preview');
const blocked = (error: unknown): CaseOutcome => {
  if (!(error instanceof RuleGapError)) throw error;
  return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
};
const october = '2026-10' as Month;

/** One month's pay, as the payroll computes it. */
function payOf(register: ParameterRegister, input: Partial<PayInput>) {
  const { result, issues } = calculatePay(
    {
      month: october,
      baseSalary: 300_000n,
      dailyHours: 8,
      mainJob: true,
      workingDays: 22,
      activeDays: 22,
      items: [{ kind: 'salary', amount: 300_000n, label: 'Remunerație' }],
      dependents: 0,
      under26: false,
      childrenInSchool: 0,
      unionDues: 0n,
      minimumExemption: null,
      ...input,
    },
    rules(register),
  );
  if (!result)
    return { summary: `Blocat: ${issues.map((issue) => issue.code).join(', ')}`, lines: [] };
  return {
    summary: `Impozit ${lei(result.tax)} lei, deducere personală ${lei(result.deduction.total)} lei, net ${lei(result.net)} lei`,
    lines: [
      `CAS ${lei(result.cas)} lei, CASS ${lei(result.cass)} lei, baza impozitului ${lei(result.taxBase)} lei`,
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The personal deduction on a mandate's remuneration (art. 77–78)

function mandateCase(
  title: string,
  facts: string,
  remuneration: bigint,
  declared: boolean,
  dependents = 0,
): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      const input = {
        mandate: true,
        baseSalary: remuneration,
        items: [{ kind: 'salary' as const, amount: remuneration, label: 'Remunerație' }],
        dependents,
      };
      try {
        return {
          engine: payOf(register, { ...input, mainJob: declared }),
          // A mandate's remuneration is never at the main job: art. 78 alin. (2) lit. b).
          alternative: payOf(register, { ...input, mainJob: false }),
        };
      } catch (error) {
        return { engine: blocked(error), alternative: blocked(error) };
      }
    },
  };
}

export const mandateDeductionSpec: ReviewSpec = {
  key: 'ro.payroll.mandate.deduction',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Administratorul cu contract de mandat, fără contract de muncă, primește deducerea personală (și se impune după art. 78 alin. (2) lit. a)) când declară funcția de bază la societate: normele, pct. 14 alin. (9) lit. a), definesc funcția de bază și prin „alte documente specifice, potrivit legii”.',
    alternative:
      'Funcția de bază este doar a unui contract individual de muncă sau raport de serviciu: remunerația din mandat se impune întotdeauna după art. 78 alin. (2) lit. b), fără deducere personală.',
  },
  question:
    'Art. 77 alin. (1) și art. 78 alin. (2): un administrator remunerat numai prin contract de mandat (art. 76 alin. (2) lit. o)) poate declara funcția de bază la societate și primi deducerea personală, sau remunerația lui se impune întotdeauna ca venit în afara funcției de bază?',
  context: ['ANAF/Cod-fiscal-consolidat:art.76(2)(o)'],
  cases: [
    mandateCase(
      'Mandat de 3.000 lei, funcția de bază declarată',
      'Administratorul are numai contractul de mandat, cu remunerația de 3.000 lei pe lună, și declară acolo funcția de bază; fără persoane în întreținere.',
      300_000n,
      true,
    ),
    mandateCase(
      'Mandat de 4.325 lei, două persoane în întreținere',
      'Remunerația este salariul minim, 4.325 lei; administratorul declară funcția de bază la societate și are două persoane în întreținere.',
      432_500n,
      true,
      2,
    ),
    mandateCase(
      'Mandat de 9.000 lei',
      'Remunerația de 9.000 lei depășește salariul minim cu peste 2.000 lei: deducerea de bază nu se acordă în nicio citire.',
      900_000n,
      true,
    ),
    mandateCase(
      'Mandat fără declarație',
      'Administratorul nu declară funcția de bază la societate (o are la alt angajator).',
      300_000n,
      false,
    ),
  ],
  gaps: [
    'Pentru D112, administratorul este tipul 6 de asigurat, asigurat pentru concedii medicale (CAM se datorează pe remunerație, art. 220^4 alin. (1) lit. d)) și neasigurat pentru șomaj, fără ore lucrate; Legea nr. 76/2002 și OUG nr. 158/2005, care stabilesc asigurarea, nu sunt în registrul de surse.',
    'Concediul de odihnă și concediul medical ale administratorului cu mandat nu sunt calculate de aplicație.',
    'Condiția salariatului microîntreprinderii (art. 51 alin. (4) lit. b)) rămâne răspunsul proprietarului la micro.conditions; registrele nu o deduc din contractul de mandat.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The limits of a garnishment (Codul de procedură civilă art. 729, Codul muncii art. 169)

type Stated = { id: string; kind: GarnishmentOrder['kind']; share: [number, number] };

function garnishmentCase(title: string, facts: string, net: bigint, orders: Stated[]): ReviewCase {
  const outcome = (withheld: { orderId: string; amount: bigint }[]) => {
    const total = withheld.reduce((sum, item) => sum + item.amount, 0n);
    return {
      summary: `Reținut ${lei(total)} lei din ${lei(net)} lei`,
      lines: withheld.map((item) => `Poprirea ${item.orderId}: ${lei(item.amount)} lei`),
    };
  };
  const full = (order: Stated): GarnishmentOrder => ({
    id: order.id,
    kind: order.kind,
    receivedOn: '2026-09-01',
    monthly: { share: order.share },
    remaining: 10_000_000n,
  });
  return {
    title,
    facts,
    run(register) {
      const context = { minimumNet: 0n, protectedIndemnities: false };
      try {
        const engine = garnish(october, net, orders.map(full), context, rules(register));
        // Each creditor of another debt up to a third on its own, all together up to half.
        let left = (net / 2n / 100n) * 100n;
        const alternative = orders.map((order) => {
          const own = garnish(october, net, [full(order)], context, rules(register)).withheld[0];
          const amount = own ? (own.amount < left ? own.amount : left) : 0n;
          left -= amount;
          return { orderId: order.id, amount };
        });
        return { engine: outcome(engine.withheld), alternative: outcome(alternative) };
      } catch (error) {
        return { engine: blocked(error), alternative: blocked(error) };
      }
    },
  };
}

export const garnishmentLimitsSpec: ReviewSpec = {
  key: 'ro.garnishment.limits',
  kind: 'interpretation',
  act: 'L134/2010-A',
  minutes: 20,
  readings: {
    engine:
      'Limita de o treime din venitul lunar net privește toate datoriile, altele decât întreținerea, împreună: mai mulți creditori de alte datorii iau cel mult o treime în total, toate popririle împreună cel mult jumătate, în ordinea art. 169 alin. (3) din Codul muncii.',
    alternative:
      'Fiecare poprire pentru alte datorii poate lua câte o treime din venitul net, în limita totală de jumătate pentru mai multe urmăriri (art. 729 alin. (2)).',
  },
  question:
    'Codul de procedură civilă art. 729 alin. (1)–(2): când un salariat are două popriri pentru alte datorii decât întreținerea, angajatorul reține cel mult o treime din venitul net pentru amândouă, sau câte o treime pentru fiecare, până la jumătate în total?',
  context: [],
  cases: [
    garnishmentCase(
      'O singură poprire pentru o datorie comercială',
      'Venit net 4.680 lei; o poprire de la un executor pentru o datorie comercială, o treime din venitul net.',
      468_000n,
      [{ id: 'A', kind: 'other', share: [1, 3] }],
    ),
    garnishmentCase(
      'Două popriri pentru alte datorii',
      'Venit net 4.680 lei; două popriri ale unor creditori diferiți, fiecare cerând o treime din venitul net.',
      468_000n,
      [
        { id: 'A', kind: 'other', share: [1, 3] },
        { id: 'B', kind: 'other', share: [1, 3] },
      ],
    ),
    garnishmentCase(
      'Pensie de întreținere și o datorie către stat',
      'Venit net 4.680 lei; pensie de întreținere de o pătrime și o poprire a ANAF de o treime.',
      468_000n,
      [
        { id: 'A', kind: 'maintenance', share: [1, 4] },
        { id: 'B', kind: 'state', share: [1, 3] },
      ],
    ),
  ],
  gaps: [
    'Textul citit este forma consolidată a Codului de procedură civilă din 14.12.2025 (portalul legislativ): art. 729 are aceleași limite ca art. 728 din forma din 2013 citită anterior.',
    'Sub salariul minim net pe economie se urmărește doar partea peste jumătatea lui (art. 729 alin. (3), confirmat în textul în vigoare). Codul nu definește salariul minim net și nu spune dacă limitele de o treime și jumătate se aplică întregului venit net sau doar acestei părți: aplicația refuză luna (GARNISHMENT_LOW_INCOME); salariul minim net îl calculează ca netul unui contract cu normă întreagă la salariul minim, la funcția de bază, fără persoane în întreținere, o citire de confirmat.',
    'Indemnizațiile de asigurări sociale de sănătate se urmăresc separat (alin. (4)–(7)): o lună cu concediu medical și poprire este refuzată.',
  ],
};

// ---------------------------------------------------------------------------------------------
// A posted month corrected for a retroactive change of the contract (art. 76 alin. (1), 78 alin.
// (3), 146 alin. (9^1))

function retroactiveCase(title: string, facts: string, base: bigint, raise: bigint): ReviewCase {
  return {
    title,
    facts,
    run(register) {
      try {
        const context = rules(register);
        const month = (salary: bigint) =>
          calculatePay(
            {
              month: october,
              baseSalary: salary,
              dailyHours: 8,
              mainJob: true,
              workingDays: 22,
              activeDays: 22,
              items: [{ kind: 'salary', amount: salary, label: 'Salariu' }],
              dependents: 0,
              under26: false,
              childrenInSchool: 0,
              unionDues: 0n,
              minimumExemption: null,
            },
            context,
          ).result!;
        const before = month(base);
        const after = month(base + raise);
        const difference = (value: (pay: typeof before) => bigint) => value(after) - value(before);
        // The alternative: the difference taxed at payment outside the main job (art. 78 alin.
        // (3)), on the difference less its own contributions, at 10%, rounded as the payroll does.
        const contributions = difference((pay) => pay.cas + pay.cass);
        const outside = calculatePay(
          {
            month: october,
            baseSalary: raise,
            dailyHours: 8,
            mainJob: false,
            workingDays: 22,
            activeDays: 22,
            items: [{ kind: 'salary', amount: raise, label: 'Diferență' }],
            dependents: 0,
            under26: false,
            childrenInSchool: 0,
            unionDues: 0n,
            minimumExemption: null,
            // Outside the main job and without the employment contract's minimum.
            mandate: true,
          },
          context,
        ).result!;
        return {
          engine: {
            summary: `Luna recalculată: impozit în plus ${lei(difference((pay) => pay.tax))} lei, contribuții în plus ${lei(contributions)} lei; D112 rectificativă`,
            lines: [
              `Deducerea personală: ${lei(before.deduction.total)} → ${lei(after.deduction.total)} lei`,
            ],
          },
          alternative: {
            summary: `Impozit la plată, în afara funcției de bază: ${lei(outside.tax)} lei; contribuții ${lei(contributions)} lei`,
            lines: [],
          },
        };
      } catch (error) {
        return { engine: blocked(error), alternative: blocked(error) };
      }
    },
  };
}

export const retroactiveCorrectionSpec: ReviewSpec = {
  key: 'ro.payroll.correction.retroactive',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'Un act adițional semnat după închiderea lunii, cu efect pentru acea lună, se tratează ca o corecție a lunii: luna se recalculează cu deducerea personală, diferențele se înregistrează, iar D112 a lunii se rectifică integral (OPANAF nr. 605/2026 anexa nr. 6 cap. II pct. 2).',
    alternative:
      'Diferențele de salariu pentru perioade anterioare, stabilite după închiderea lunii, se impun la data plății ca venituri în afara funcției de bază (art. 78 alin. (3)), iar contribuțiile se defalcă pe lunile la care se referă (art. 146 alin. (9^1)).',
  },
  question:
    'Când angajatorul majorează retroactiv salariul unei luni deja închise (act adițional ulterior), diferența se tratează ca o corecție a lunii (recalculare și D112 rectificativă), sau ca venit al lunii plății, impozitat în afara funcției de bază potrivit art. 78 alin. (3)?',
  context: ['ANAF/Cod-fiscal-consolidat:art.76(1)'],
  cases: [
    retroactiveCase(
      'Majorare de 500 lei pentru octombrie',
      'Salariul de octombrie, 5.000 lei, este majorat cu 500 lei printr-un act adițional semnat în decembrie, cu efect din 1 octombrie.',
      500_000n,
      50_000n,
    ),
    retroactiveCase(
      'Majorare de 1.500 lei, peste plafonul deducerii',
      'Salariul de 5.500 lei este majorat cu 1.500 lei retroactiv: venitul brut trece de salariul minim plus 2.000 lei și deducerea personală se pierde.',
      550_000n,
      150_000n,
    ),
    retroactiveCase(
      'Majorare a salariului minim',
      'Salariul de 4.400 lei este majorat cu 200 lei retroactiv.',
      440_000n,
      20_000n,
    ),
  ],
  gaps: [
    'Sumele stabilite prin lege sau prin hotărâre judecătorească pentru perioade anterioare (art. 146 alin. (9)–(9^1), D112 cu tip_rec 2) sunt refuzate de aplicație (CORRECTION_LEGAL).',
    'O eroare de calcul găsită după depunere se corectează ca recalculare a lunii în ambele citiri; doar modificarea retroactivă a drepturilor este în discuție.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The day an isolation certificate loses (OUG nr. 91/2025 art. II, the D112 structure)

/** The register with code 51 reduced by a day, as art. II alin. (4)–(5) read alone would have it. */
function isolationReduced(register: ParameterRegister) {
  return register.withVersions(
    register.versions.map((version) => {
      if (version.key !== 'ro.sick.codes') return version;
      const codes = version.value as Record<string, SickCodeRule>;
      return codes['51']
        ? { ...version, value: { ...codes, '51': { ...codes['51'], reduced: true } } }
        : version;
    }),
  );
}

function isolationCase(
  title: string,
  facts: string,
  code: string,
  from: string,
  to: string,
  extra: Partial<SickCertificate> = {},
): ReviewCase {
  // 6 × 4,325 lei over 126 days of stage: 205.95 lei a day.
  const base = { income: 6n * 432_500n, days: 126 };
  const certificate: SickCertificate = {
    series: 'CCMAM',
    number: '1',
    code,
    issued: from as SickCertificate['issued'],
    from: from as SickCertificate['from'],
    to: to as SickCertificate['to'],
    continuation: false,
    hospitalized: false,
    ...extra,
  };
  const outcome = (register: ParameterRegister): CaseOutcome => {
    try {
      const { result, issues } = sickIndemnity(
        certificate,
        base,
        { reduced: false, employerDays: 0 },
        rules(register),
      );
      if (!result)
        return { summary: `Blocat: ${issues.map((issue) => issue.code).join(', ')}`, lines: [] };
      return {
        summary: `FNUASS ${lei(result.fund)} lei, angajator ${lei(result.employer)} lei`,
        lines: [
          `Zile lucrătoare: ${result.days}, neplătite ${result.unpaidDays}, din FNUASS ${result.fundDays}; procent ${result.percent}%`,
        ],
      };
    } catch (error) {
      return blocked(error);
    }
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: outcome(register),
      alternative: outcome(isolationReduced(register)),
    }),
  };
}

export const sickCodesSpec: ReviewSpec = {
  key: 'ro.sick.codes',
  kind: 'interpretation',
  act: 'OUG158/2005-A',
  minutes: 15,
  readings: {
    engine:
      'Indemnizația pentru boala infectocontagioasă cu izolare (cod 51) nu se diminuează cu o zi: structura D112 a ANAF o enumeră printre excepțiile OUG nr. 91/2025 și ale Legii nr. 64/2026, iar FNUASS o suportă integral din prima zi (art. 12 lit. B lit. c) și art. 20 alin. (3) din OUG nr. 158/2005).',
    alternative:
      'Indemnizația pentru izolare se diminuează cu o zi, ca orice indemnizație care nu este la art. II alin. (4)–(5) din OUG nr. 91/2025 (maternitate, îngrijirea pacientului oncologic, risc maternal, programe naționale, spitalizare): FNUASS o suportă de a doua zi (alin. (1) lit. b) pct. (ii)).',
  },
  question:
    'OUG nr. 91/2025 art. II alin. (4)–(5), cu modificările Legii nr. 64/2026, nu exceptează de la diminuarea cu o zi certificatele pentru boli infectocontagioase cu izolare (cod 51); alin. (1) lit. a) le scoate doar din zilele suportate de angajator. Structura D112 le enumeră totuși printre excepții. Se plătește prima zi lucrătoare a unui certificat de izolare?',
  context: ['OUG158/2005-A:art.20(3)', 'OUG158/2005-A:art.12'],
  cases: [
    isolationCase(
      'Izolare de 5 zile lucrătoare, episod nou',
      'Certificat cu codul 51 din 5 până în 9 octombrie 2026, primul al episodului, fără internare; baza: 25.950 lei pe 126 de zile de stagiu.',
      '51',
      '2026-10-05',
      '2026-10-09',
    ),
    isolationCase(
      'Izolare de 10 zile lucrătoare',
      'Certificat cu codul 51 din 5 până în 16 octombrie 2026, primul al episodului.',
      '51',
      '2026-10-05',
      '2026-10-16',
    ),
    isolationCase(
      'Izolare în spital',
      'Certificat cu codul 51 din 5 până în 9 octombrie 2026, eliberat pentru un pacient internat (art. II alin. (5)).',
      '51',
      '2026-10-05',
      '2026-10-09',
      { hospitalized: true },
    ),
    isolationCase(
      'Carantină (cod 07), pentru comparație',
      'Certificat cu codul 07 din 5 până în 9 octombrie 2026: carantina nu este la art. II alin. (4)–(5), deci se diminuează în ambele citiri.',
      '07',
      '2026-10-05',
      '2026-10-09',
    ),
  ],
  gaps: [
    'Normele de aplicare a OUG nr. 158/2005 modificate în 2026 (Ordinul nr. 506/1.030/2026), care stabilesc modalitatea diminuării (art. II alin. (3)), nu sunt în registrul de surse.',
    'Carantina instituită la întoarcerea dintr-o deplasare în interes personal într-o zonă cu epidemie se suportă din FNUASS doar 5 zile (art. 22 alin. (1^1)): aplicația nu cunoaște motivul carantinei.',
    'Codul 92 (supravegherea copilului în carantină sau izolare, 100% din FNUASS, art. 30 alin. (2)) nu este calculat: impozitarea și baza CASS ale indemnizației nu sunt în registru.',
  ],
};

// ---------------------------------------------------------------------------------------------
// Vouchers above the limits of Legea nr. 165/2018 (art. 76 alin. (3) lit. h), art. 142 lit. r))

function voucherCase(
  title: string,
  facts: string,
  month: Month,
  salary: bigint,
  vouchers: { meal: bigint; holiday: bigint },
  daysWorked: number,
  holidayEarlier = 0n,
): ReviewCase {
  const pay = (register: ParameterRegister, items: PayInput['items']) => {
    const { result, issues } = calculatePay(
      {
        month,
        baseSalary: salary,
        dailyHours: 8,
        mainJob: true,
        workingDays: 22,
        activeDays: 22,
        items,
        dependents: 0,
        under26: false,
        childrenInSchool: 0,
        unionDues: 0n,
        minimumExemption: null,
      },
      rules(register),
    );
    if (!result)
      return { summary: `Blocat: ${issues.map((issue) => issue.code).join(', ')}`, lines: [] };
    return {
      summary: `CAS ${lei(result.cas)} lei, CASS ${lei(result.cass)} lei, impozit ${lei(result.tax)} lei, CAM ${lei(result.cam)} lei`,
      lines: [`Net ${lei(result.net)} lei; avantaje în natură ${lei(result.inKind)} lei`],
    };
  };
  const stated = [
    { kind: 'salary' as const, amount: salary, label: 'Salariu' },
    ...(vouchers.meal
      ? [{ kind: 'meal_vouchers' as const, amount: vouchers.meal, label: 'Tichete de masă' }]
      : []),
    ...(vouchers.holiday
      ? [
          {
            kind: 'holiday_vouchers' as const,
            amount: vouchers.holiday,
            label: 'Vouchere de vacanță',
          },
        ]
      : []),
  ];
  return {
    title,
    facts,
    run(register) {
      try {
        const split = voucherExcess(
          month,
          vouchers,
          { daysWorked, holidayEarlier, minimumWage: 432_500n },
          rules(register),
        );
        if (split.issues.length) {
          const stopped = {
            summary: `Blocat: ${split.issues.map((issue) => issue.code).join(', ')}`,
            lines: [],
          };
          return { engine: stopped, alternative: stopped };
        }
        const excess = split.excess.reduce(
          (total, item) => total + item.taxable.reduce((sum, part) => sum + part.amount, 0n),
          0n,
        );
        return {
          engine: pay(register, [
            { kind: 'salary', amount: salary, label: 'Salariu' },
            ...(split.meal
              ? [{ kind: 'meal_vouchers' as const, amount: split.meal, label: 'Tichete de masă' }]
              : []),
            ...(split.holiday
              ? [
                  {
                    kind: 'holiday_vouchers' as const,
                    amount: split.holiday,
                    label: 'Vouchere de vacanță',
                  },
                ]
              : []),
            ...(excess
              ? [{ kind: 'benefit' as const, amount: excess, label: 'Peste limita legii' }]
              : []),
          ]),
          // The excess taxed as the vouchers themselves: tax and CASS, outside CAS and CAM.
          alternative: pay(register, stated),
        };
      } catch (error) {
        return { engine: blocked(error), alternative: blocked(error) };
      }
    },
  };
}

export const voucherLimitsSpec: ReviewSpec = {
  key: 'ro.payroll.voucher.limits',
  kind: 'interpretation',
  act: 'L165/2018-A',
  minutes: 15,
  readings: {
    engine:
      'Ce depășește 45 de lei pe tichet de masă și zi lucrată sau 6 salarii minime pe an la voucherele de vacanță nu este bilet de valoare acordat „potrivit legii” (art. 76 alin. (3) lit. h), art. 142 lit. r)): este un avantaj (art. 76 alin. (2) lit. s)), în toate bazele, inclusiv CAS și CAM, declarat în E3_44.',
    alternative:
      'Excedentul rămâne bilet de valoare: venit din salarii pentru impozit și în baza CASS, dar în afara bazelor CAS și CAM, ca tichetele și voucherele în limitele legii.',
  },
  question:
    'Legea nr. 165/2018 limitează tichetul de masă la 45 de lei, cel mult unul pe zi lucrată (art. 12 alin. (2), art. 14), și voucherele de vacanță la 6 salarii minime pe an (art. 24 alin. (3)). Ce depășește aceste limite intră în toate bazele, ca un avantaj, sau se impozitează ca biletele de valoare (impozit și CASS, fără CAS și CAM)?',
  context: ['ANAF/Cod-fiscal-consolidat:art.142(r)', 'ANAF/Cod-fiscal-consolidat:art.76(2)(s)'],
  cases: [
    voucherCase(
      'Tichete de 50 de lei, 22 de zile lucrate',
      'Septembrie 2026: salariu 8.000 lei, tichete de masă de 50 lei pentru fiecare din cele 22 de zile lucrate (1.100 lei): 990 lei în limita legii, 110 lei peste ea.',
      '2026-09' as Month,
      800_000n,
      { meal: 110_000n, holiday: 0n },
      22,
    ),
    voucherCase(
      'Tichete de 45 de lei și pentru zilele de concediu',
      'Septembrie 2026: salariu 8.000 lei, 22 de tichete de 45 lei (990 lei), dar 2 din cele 22 de zile au fost concediu de odihnă: 20 de zile lucrate, 90 de lei peste limită.',
      '2026-09' as Month,
      800_000n,
      { meal: 99_000n, holiday: 0n },
      20,
    ),
    voucherCase(
      'Vouchere de vacanță peste plafonul anual',
      'Octombrie 2026: salariu 30.000 lei, vouchere de vacanță de 27.000 lei, primele din an; plafonul este 6 × 4.325 = 25.950 lei.',
      '2026-10' as Month,
      3_000_000n,
      { meal: 0n, holiday: 2_700_000n },
      22,
    ),
    voucherCase(
      'Tichete în limita legii',
      'Septembrie 2026: salariu 8.000 lei, 22 de tichete de 45 lei pentru 22 de zile lucrate.',
      '2026-09' as Month,
      800_000n,
      { meal: 99_000n, holiday: 0n },
      22,
    ),
  ],
  gaps: [
    'Din octombrie 2026 valoarea de 45 de lei poate fi indexată prin ordinul comun al art. 32, care nu este în registrul de surse: un tichet peste 45 de lei pe zi lucrată oprește linia (VOUCHER_INDEXATION) până la confirmarea valorii.',
    'Plafonul voucherelor de vacanță se calculează cu salariul minim al lunii în care se acordă; legea nu spune ce salariu minim se ia când acesta se schimbă în cursul anului (4.050 lei până în iunie 2026, 4.325 lei din iulie).',
    'Zilele lucrate sunt zilele active ale contractului fără zilele de concediu de odihnă; cele două tranșe ale art. 24 alin. (4) nu sunt verificate, iar plafonul anual se urmărește pe contract, nu pe salariatul cu mai multe contracte la același angajator.',
  ],
};

// ---------------------------------------------------------------------------------------------
// When the 20 working days of a salary change start (HG nr. 295/2025 art. 5 alin. (4))

function regesCase(
  title: string,
  facts: string,
  effective: string,
  agreed: string,
  changed: RegesField[],
): ReviewCase {
  const outcome = (deadline: LocalDate | null, blocked: string | null): CaseOutcome =>
    deadline
      ? { summary: `Termen REGES-ONLINE: ${deadline}`, lines: [] }
      : { summary: 'Blocat: fără termen', lines: blocked ? [blocked] : [] };
  return {
    title,
    facts,
    run(register) {
      try {
        const engine = regesDeadline('change', effective as LocalDate, changed, rules(register));
        // The salary's term counted from the addendum; the other changes keep the day before
        // they take effect.
        const salary = changed.includes('salary')
          ? regesDeadline('change', agreed as LocalDate, ['salary'], rules(register)).deadline
          : null;
        const others = changed.filter((field) => field !== 'salary');
        const rest = others.length
          ? regesDeadline('change', effective as LocalDate, others, rules(register)).deadline
          : null;
        const alternative = [salary, rest]
          .filter((day): day is LocalDate => day !== null)
          .sort()[0];
        return {
          engine: outcome(engine.deadline, engine.blocked),
          alternative: outcome(alternative ?? null, null),
        };
      } catch (error) {
        return { engine: blocked(error), alternative: blocked(error) };
      }
    },
  };
}

export const regesChangeSpec: ReviewSpec = {
  key: 'ro.deadline.reges.change',
  kind: 'interpretation',
  act: 'HG295/2025-A',
  minutes: 10,
  readings: {
    engine:
      'Termenul de 20 de zile lucrătoare al modificării salariului (art. 5 alin. (4)) curge de la data de la care se aplică noul salariu, data versiunii contractului; o majorare retroactivă este transmisă cu întârziere chiar de la încheierea actului adițional.',
    alternative:
      'Modificarea se „produce” la data actului adițional care o stabilește: termenul curge de la încheierea lui, chiar dacă salariul se aplică de la o dată anterioară sau ulterioară.',
  },
  question:
    'HG nr. 295/2025 art. 5 alin. (4): salariul modificat se transmite în REGES-ONLINE în 20 de zile lucrătoare „de la data producerii modificării”. Pentru un act adițional încheiat la o dată și aplicabil de la alta, termenul curge de la data de la care se aplică noul salariu sau de la data încheierii actului adițional?',
  context: [],
  cases: [
    regesCase(
      'Majorare de la 1 noiembrie, act adițional din 20 octombrie',
      'Salariul crește de la 1 noiembrie 2026; actul adițional s-a încheiat la 20 octombrie 2026.',
      '2026-11-01',
      '2026-10-20',
      ['salary'],
    ),
    regesCase(
      'Majorare retroactivă',
      'Actul adițional încheiat la 10 decembrie 2026 majorează salariul de la 1 octombrie 2026.',
      '2026-10-01',
      '2026-12-10',
      ['salary'],
    ),
    regesCase(
      'Salariul și timpul de muncă, de la 1 decembrie',
      'De la 1 decembrie 2026 norma scade la 6 ore și salariul odată cu ea; actul adițional s-a încheiat la 20 noiembrie 2026: timpul de muncă se transmite cel târziu în ziua anterioară (alin. (3)).',
      '2026-12-01',
      '2026-11-20',
      ['salary', 'hours'],
    ),
    regesCase(
      'Act adițional în ziua în care se aplică',
      'Salariul crește de la 2 noiembrie 2026, prin actul adițional încheiat în aceeași zi.',
      '2026-11-02',
      '2026-11-02',
      ['salary'],
    ),
  ],
  gaps: [
    'O modificare dispusă prin hotărâre judecătorească se transmite în 10 zile lucrătoare de la luarea la cunoștință (art. 5 alin. (3)–(4)): aplicația nu știe când o modificare vine dintr-o hotărâre.',
    'Încetarea se transmite cel târziu la data încetării sau la data luării la cunoștință a evenimentului care a determinat-o (art. 5 alin. (1) lit. f)): aplicația folosește data încetării din contract.',
    'Suspendările (lit. p)), transferurile și detașările (lit. l)–o)) și modificările datelor de identificare (lit. a)–c)) nu sunt urmărite de aplicație; o dată a începerii activității schimbată este o corecție (alin. (8)), fără termen calculat.',
    'REGES-ONLINE nu este o declarație fiscală: cheia nu are o declarație al cărei termen să o claseze în coada revizuirilor.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The base of a work accident continued into a later month (Legea nr. 346/2002 art. 19, 33)

function accidentCase(
  title: string,
  facts: string,
  from: string,
  to: string,
  /** The monthly average of the 6 months before the risk, and of the 6 before this month. */
  averages: { risk: bigint; month: bigint },
  monthDays: number,
  continuation: boolean,
  employerDays = 0,
): ReviewCase {
  const certificate: SickCertificate = {
    series: 'CCMAM',
    number: '2',
    code: '03',
    issued: from as SickCertificate['issued'],
    from: from as SickCertificate['from'],
    to: to as SickCertificate['to'],
    continuation,
    hospitalized: false,
  };
  const outcome = (register: ParameterRegister, average: bigint): CaseOutcome => {
    try {
      const { result, issues } = sickIndemnity(
        certificate,
        { income: average, days: monthDays },
        { reduced: false, employerDays },
        rules(register),
      );
      if (!result)
        return { summary: `Blocat: ${issues.map((issue) => issue.code).join(', ')}`, lines: [] };
      return {
        summary: `Angajator ${lei(result.employer)} lei, bugetul asigurărilor sociale ${lei(result.fund)} lei`,
        lines: [`Media zilnică ${lei(result.dailyAverage)} lei, ${result.days} zile lucrătoare`],
      };
    } catch (error) {
      return blocked(error);
    }
  };
  return {
    title,
    facts,
    run: (register) => ({
      engine: outcome(register, averages.risk),
      alternative: outcome(register, averages.month),
    }),
  };
}

export const sickAccidentSpec: ReviewSpec = {
  key: 'ro.sick.accident',
  kind: 'interpretation',
  act: 'L346/2002-A',
  minutes: 15,
  readings: {
    engine:
      'Indemnizația unui accident de muncă se calculează din media veniturilor brute ale celor 6 luni anterioare manifestării riscului (art. 33 alin. (1)), păstrată pentru tot episodul, împărțită la zilele lucrătoare ale fiecărei luni de concediu (art. 19 alin. (4)).',
    alternative:
      'Baza se recalculează pentru fiecare lună de concediu, din cele 6 luni anterioare lunii pentru care se acordă concediul (art. 19 alin. (1)), și pentru continuările din lunile următoare.',
  },
  question:
    'Legea nr. 346/2002: art. 19 alin. (1) ia media veniturilor din „ultimele 6 luni anterioare lunii pentru care se acordă concediul medical”, art. 33 alin. (1) din „ultimele 6 luni anterioare manifestării riscului”. Pentru un concediu după un accident de muncă care continuă în luna următoare, baza rămâne cea de la începutul episodului sau se recalculează lunar?',
  context: ['L346/2002-A:art.19', 'L346/2002-A:art.33'],
  cases: [
    accidentCase(
      'Primul certificat, în luna accidentului',
      'Accident de muncă confirmat; certificat din 5 până în 16 octombrie 2026 (10 zile lucrătoare); media lunară a celor 6 luni anterioare este 6.000 lei în ambele citiri.',
      '2026-10-05',
      '2026-10-16',
      { risk: 600_000n, month: 600_000n },
      22,
      false,
    ),
    accidentCase(
      'Continuare în noiembrie, după o majorare din septembrie',
      'Certificatul continuă din 1 până în 13 noiembrie 2026 (9 zile lucrătoare, 20 în lună); salariul a crescut de la 6.000 la 7.500 lei din septembrie: media lunilor dinaintea accidentului este 6.000 lei, a celor dinaintea lui noiembrie 6.500 lei.',
      '2026-11-02',
      '2026-11-13',
      { risk: 600_000n, month: 650_000n },
      20,
      true,
      3,
    ),
    accidentCase(
      'Continuare în decembrie, fără schimbări de salariu',
      'Certificatul continuă din 1 până în 11 decembrie 2026 (8 zile lucrătoare, 21 în lună), salariul fiind același de un an: media este 6.000 lei în ambele citiri.',
      '2026-12-01',
      '2026-12-11',
      { risk: 600_000n, month: 600_000n },
      21,
      true,
      3,
    ),
  ],
  gaps: [
    'Un accident neconfirmat de casa teritorială de pensii este refuzat (SICK_ACCIDENT_UNCONFIRMED): structura D112 îl declară în secțiunea D cu codurile 02–04, iar art. 33 alin. (4)–(5) recuperează ulterior sumele plătite și diferențele, fără ca textele din registru să spună cum se plătește până la confirmare.',
    'Primele 3 zile ale angajatorului (art. 34) sunt numărate ca zile lucrătoare, ca la OUG nr. 158/2005; textul spune „zile de incapacitate”.',
    'Indemnizația suportată de angajator nu intră în baza CAS, cum calculează D112 baza B4_7 (B3_7 cuprinde doar indemnizațiile OUG nr. 158/2005); partea din bugetul asigurărilor sociale este scutită (art. 141 lit. a), normele pct. 41). Partea angajatorului intră în baza CAM, iar a bugetului nu (art. 220^5).',
    'Arsurile grave ale art. 36^1 (100%) nu sunt recunoscute de aplicație; urgența medico-chirurgicală (100%, art. 33 alin. (3)) este dată de codul de urgență al certificatului. Veniturile bazei sunt venitul brut al lunilor postate (cu tichete și avantaje), fără veniturile de la alți angajatori.',
  ],
};
