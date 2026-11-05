import { formatMoney, parseMoney } from '../../../money';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import {
  distribute,
  type AdvanceRule,
  type Distribution,
  type DistributionOrder,
} from '../../taxaccount/distribution';
import {
  taxTypeLabels,
  type Budget,
  type Category,
  type Obligation,
  type TaxAccounts,
  type TaxType,
} from '../../taxaccount/obligations';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of the tax account (T2): where the Codul de procedură fiscală (L207/2015, the
 * portal's consolidation of 08.08.2026), ANAF's methodology of the single account (OPANAF nr.
 * 1.613/2018) and OMFP nr. 1.802/2014 leave a choice the engine had to make. Every case runs the
 * engine's own distribution (`taxaccount/distribution.ts`) on a small world, under both readings,
 * against the register under review.
 */

const CPF = 'L207/2015';
const bani = (text: string) => parseMoney(text, 'RON');
const lei = (value: bigint) => `${formatMoney(value, 'RON')} lei`;

interface Owed {
  type: TaxType;
  period: string;
  owed: string;
  due: string;
  category?: Category;
}
const budgetOf: Record<TaxType, Budget> = {
  vat: 'state',
  profit: 'state',
  micro: 'state',
  salary_tax: 'state',
  dividend_tax: 'state',
  interest_tax: 'state',
  cas: 'social_insurance',
  cass: 'health_insurance',
  cam: 'state',
  rent_tax: 'state',
  ip_tax: 'state',
  nonresident_dividend_tax: 'state',
  nonresident_interest_tax: 'state',
  nonresident_royalty_tax: 'state',
  nonresident_commission_tax: 'state',
  nonresident_services_tax: 'state',
};
const withheld = new Set<TaxType>([
  'salary_tax',
  'cas',
  'cass',
  'dividend_tax',
  'interest_tax',
  'rent_tax',
  'ip_tax',
  'nonresident_dividend_tax',
  'nonresident_interest_tax',
  'nonresident_royalty_tax',
  'nonresident_commission_tax',
  'nonresident_services_tax',
]);
const obligation = (item: Owed, index: number): Obligation => ({
  id: `o${index + 1}`,
  account: '',
  type: item.type,
  period: item.period,
  budget: budgetOf[item.type],
  category: item.category ?? (withheld.has(item.type) ? 'withheld' : 'principal'),
  due: item.due as LocalDate,
  age: item.due as LocalDate,
  owed: bani(item.owed),
  designatable: false,
  separate: false,
  source: 'caz',
});

/** The rules in force on the payment's date, as the register under review gives them. */
function rulesAt(register: ParameterRegister, date: LocalDate) {
  const rules = new RuleContext(register, 'preview');
  return {
    order: rules.param<DistributionOrder>('ro.taxaccount.distribution', 'payment_date', date),
    advance: rules.param<AdvanceRule>('ro.taxaccount.advance', 'payment_date', date),
    accounts: rules.param<TaxAccounts>(
      'ro.taxaccount.accounts',
      'accounting_transaction_date',
      date,
    ),
  };
}

function shown(distribution: Distribution, world: { owed: Owed[] }): CaseOutcome {
  const lines = distribution.allocations.map((allocation) => {
    const item = world.owed[Number(allocation.obligation.id.slice(1)) - 1]!;
    return `${taxTypeLabels[item.type]} ${item.period}: ${lei(allocation.bani)}${allocation.stage === 'later' ? ` (la scadența ${allocation.on})` : ''}`;
  });
  if (distribution.undistributed > 0n)
    lines.push(`Nedistribuit: ${lei(distribution.undistributed)}`);
  return {
    summary: `Distribuit ${lei(distribution.allocations.reduce((sum, item) => sum + item.bani, 0n))}, nedistribuit ${lei(distribution.undistributed)}`,
    lines,
  };
}

function run(
  register: ParameterRegister,
  world: { paid: string; date: string; owed: Owed[] },
  change: (rules: ReturnType<typeof rulesAt>) => ReturnType<typeof rulesAt>,
): CaseOutcome {
  try {
    const rules = change(rulesAt(register, world.date as LocalDate));
    return shown(
      distribute(bani(world.paid), world.date as LocalDate, world.owed.map(obligation), rules),
      world,
    );
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

function distributionCase(
  title: string,
  facts: string,
  world: { paid: string; date: string; owed: Owed[] },
  alternative: (rules: ReturnType<typeof rulesAt>) => ReturnType<typeof rulesAt>,
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: run(register, world, (rules) => rules),
      alternative: run(register, world, alternative),
    }),
  };
}

const byObligation = (rules: ReturnType<typeof rulesAt>) => ({
  ...rules,
  order: { ...rules.order, withinCategory: 'by_obligation' as const },
});

export const distributionSpec: ReviewSpec = {
  key: 'ro.taxaccount.distribution',
  kind: 'interpretation',
  act: CPF,
  minutes: 15,
  readings: {
    engine:
      'În cadrul unei categorii pe care plata nu o acoperă, suma se împarte proporțional între tipurile de obligații (art. 163 alin. (5), pct. 6 din metodologie), iar în cadrul fiecărui tip se sting întâi obligațiile cele mai vechi (art. 165 alin. (1) lit. a) și alin. (3), pct. 7).',
    alternative:
      'În cadrul categoriei neacoperite, suma se împarte proporțional între toate obligațiile datorate, fiecare perioadă separat, indiferent de vechime.',
  },
  question:
    'Când o plată în contul unic nu acoperă o categorie (de exemplu impozitele cu reținere la sursă ale bugetului de stat pe două luni), proporționalitatea art. 163 alin. (5) se aplică între tipurile de obligații, cu stingerea în ordinea vechimii în cadrul tipului (art. 165), sau între toate obligațiile, fiecare perioadă separat?',
  context: [`${CPF}:art.163(7)`, 'OPANAF551/2021:anexa'],
  cases: [
    distributionCase(
      'Două luni de impozit pe salarii și impozit pe dividende, plată parțială',
      'La 25.11.2026 societatea datorează bugetului de stat impozit pe salarii de 1.000 lei pentru septembrie (scadent 25.10) și 1.000 lei pentru octombrie (scadent 25.11), și impozit pe dividende de 2.000 lei (scadent 25.11); plătește în contul unic 2.000 lei.',
      {
        paid: '2000.00',
        date: '2026-11-25',
        owed: [
          { type: 'salary_tax', period: '2026-09', owed: '1000.00', due: '2026-10-26' },
          { type: 'salary_tax', period: '2026-10', owed: '1000.00', due: '2026-11-25' },
          { type: 'dividend_tax', period: '2026-10', owed: '2000.00', due: '2026-11-25' },
        ],
      },
      byObligation,
    ),
    distributionCase(
      'Trei bugete, plată sub total',
      'La 25.11.2026 societatea datorează impozit pe salarii 600 lei, CAS 1.500 lei, CASS 600 lei și impozit pe profit 1.300 lei; plătește 2.000 lei.',
      {
        paid: '2000.00',
        date: '2026-11-25',
        owed: [
          { type: 'salary_tax', period: '2026-10', owed: '600.00', due: '2026-11-25' },
          { type: 'cas', period: '2026-10', owed: '1500.00', due: '2026-11-25' },
          { type: 'cass', period: '2026-10', owed: '600.00', due: '2026-11-25' },
          { type: 'profit', period: '2026-Q3', owed: '1300.00', due: '2026-10-26' },
        ],
      },
      byObligation,
    ),
    distributionCase(
      'Plata acoperă tot',
      'La 25.11.2026 societatea datorează impozit pe salarii 600 lei și CAS 1.500 lei și plătește 2.500 lei.',
      {
        paid: '2500.00',
        date: '2026-11-25',
        owed: [
          { type: 'salary_tax', period: '2026-10', owed: '600.00', due: '2026-11-25' },
          { type: 'cas', period: '2026-10', owed: '1500.00', due: '2026-11-25' },
        ],
      },
      byObligation,
    ),
  ],
  gaps: [
    'Ordinea pentru debitorii cu înlesniri la plată și în insolvență (art. 163 alin. (10), art. 165 alin. (4)–(6), cap. II–III din metodologie) nu este acoperită: tratamentul o refuză.',
    'Partea de CAS și CASS suportată de angajator în numele salariatului (minimul pentru timp parțial) este ținută pe același cont și tratată ca reținută la sursă.',
  ],
};

const undistributedReading = (rules: ReturnType<typeof rulesAt>) => ({
  ...rules,
  advance: { beyondDue: 'undistributed' as const },
});

export const advanceSpec: ReviewSpec = {
  key: 'ro.taxaccount.advance',
  kind: 'interpretation',
  act: 'OPANAF1613/2018',
  minutes: 15,
  readings: {
    engine:
      'O plată în contul unic făcută înaintea scadenței stinge obligațiile declarate și înregistrate cu scadența ulterioară, la scadența fiecăreia, în aceeași ordine de distribuire (pct. 7–9.1 din metodologie: sumele rămase sting obligațiile înregistrate ulterior); înregistrarea contabilă se face la data plății.',
    alternative:
      'Plata rămâne nedistribuită (creanță asupra bugetului) până la scadență, când o distribuire separată o trece pe obligații; obligațiile cu scadențe viitoare se sting doar la cererea debitorului (art. 165 alin. (1) lit. b)).',
  },
  question:
    'O plată în contul unic făcută înainte de scadența unor obligații deja declarate se înregistrează direct pe acele obligații (cum le va stinge ANAF la scadență) sau rămâne ca plată nedistribuită până la scadență?',
  context: [`${CPF}:art.165(1),(3)`, 'OPANAF1613/2018:pct.4-7'],
  cases: [
    distributionCase(
      'Plată pe 20 a lunii, scadența pe 25',
      'Societatea a declarat impozitul pe salarii (2.000 lei) și CAS (3.000 lei) pentru octombrie, scadente la 25.11.2026, și plătește 5.000 lei la 20.11.2026.',
      {
        paid: '5000.00',
        date: '2026-11-20',
        owed: [
          { type: 'salary_tax', period: '2026-10', owed: '2000.00', due: '2026-11-25' },
          { type: 'cas', period: '2026-10', owed: '3000.00', due: '2026-11-25' },
        ],
      },
      undistributedReading,
    ),
    distributionCase(
      'O obligație restantă și una viitoare',
      'Impozitul pe profit al trimestrului III (1.000 lei) era scadent la 26.10.2026 și neplătit; impozitul pe salarii pentru noiembrie (800 lei) este scadent la 28.12.2026; plata de 1.500 lei se face la 01.12.2026.',
      {
        paid: '1500.00',
        date: '2026-12-01',
        owed: [
          { type: 'profit', period: '2026-Q3', owed: '1000.00', due: '2026-10-26' },
          { type: 'salary_tax', period: '2026-11', owed: '800.00', due: '2026-12-28' },
        ],
      },
      undistributedReading,
    ),
    distributionCase(
      'Plată înaintea oricărei obligații',
      'Societatea plătește 1.000 lei la 10.11.2026; nu are încă nicio obligație înregistrată față de buget.',
      { paid: '1000.00', date: '2026-11-10', owed: [] },
      undistributedReading,
    ),
  ],
  gaps: [
    'Metodologia (pct. 8.1–10.1) trece sumele rămase nedistribuite la sfârșitul lunii în conturile în curs de distribuire ale bugetelor, după ponderi bugetare, și le compensează în luna următoare; registrele nu urmăresc aceste conturi intermediare: rezultatul final (obligațiile stinse) este cel comparat cu fișa pe plătitor.',
  ],
};

/** The lines of a small world under the accounts given: interest of a decision, and a payment
 * that no obligation takes. */
function accountsOutcome(
  register: ParameterRegister,
  change: (accounts: TaxAccounts) => TaxAccounts & { interestExpense?: string },
  world: { interest: string; penalty: string; prepaid: string },
): CaseOutcome {
  try {
    const accounts = change(rulesAt(register, '2026-11-10' as LocalDate).accounts);
    const interestExpense = accounts.interestExpense ?? accounts.accessoriesExpense;
    return {
      summary: `Dobânzi pe ${interestExpense}, penalități pe ${accounts.accessoriesExpense}, plata nedistribuită pe ${accounts.undistributed}`,
      lines: [
        `D ${interestExpense} / C ${accounts.accessories}: ${world.interest} lei (dobânzi)`,
        `D ${accounts.accessoriesExpense} / C ${accounts.accessories}: ${world.penalty} lei (penalități de întârziere)`,
        `D ${accounts.undistributed} / C 5121: ${world.prepaid} lei (plată nedistribuită)`,
      ],
    };
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

const accountsCase = (
  title: string,
  facts: string,
  world: { interest: string; penalty: string; prepaid: string },
): ReviewCase => ({
  title,
  facts,
  run: (register) => ({
    engine: accountsOutcome(register, (accounts) => accounts, world),
    alternative: accountsOutcome(
      register,
      (accounts) => ({ ...accounts, interestExpense: '666', undistributed: '473' }),
      world,
    ),
  }),
});

export const accountsSpec: ReviewSpec = {
  key: 'ro.taxaccount.accounts',
  kind: 'interpretation',
  act: 'OMFP1802/2014',
  minutes: 10,
  readings: {
    engine:
      'Dobânzile și penalitățile de întârziere datorate bugetului se înregistrează ca penalități (Dr 6581 / Cr 4481, funcțiunea conturilor 658 și 448), iar plata în contul unic încă nedistribuită ca sumă cuvenită de la buget (Dr 4482).',
    alternative:
      'Dobânzile de întârziere sunt cheltuieli cu dobânzile (666), iar plata nedistribuită este o operațiune în curs de clarificare (473, clarificată în trei luni, pct. 352).',
  },
  question:
    'Pe ce conturi se înregistrează dobânzile de întârziere stabilite prin decizie (6581 sau 666) și o plată în contul unic pe care ANAF nu a distribuit-o încă (4482 sau 473)?',
  context: ['OMFP1802/2014:pct.352', `${CPF}:art.173(1),(4)-(5)`],
  cases: [
    accountsCase(
      'O decizie de accesorii',
      'Decizia referitoare la obligațiile de plată accesorii comunicată la 10.11.2026 stabilește dobânzi de 120 lei și penalități de întârziere de 60 lei.',
      { interest: '120,00', penalty: '60,00', prepaid: '0,00' },
    ),
    accountsCase(
      'O plată înaintea declarării',
      'Societatea plătește 1.000 lei în contul unic la 10.11.2026, înainte de a depune declarația; ANAF nu o distribuie.',
      { interest: '0,00', penalty: '0,00', prepaid: '1.000,00' },
    ),
    accountsCase(
      'Amândouă',
      'Dobânzi de 35 lei, penalități de 17 lei, și o plată de 500 lei încă nedistribuită.',
      { interest: '35,00', penalty: '17,00', prepaid: '500,00' },
    ),
  ],
  gaps: [
    'Accesoriile contribuțiilor sociale (BASS, FNUASS) se înregistrează tot pe 4481, cu obligația principală indicată pe rând; reglementările nu dau un cont distinct al bugetelor de asigurări.',
  ],
};
