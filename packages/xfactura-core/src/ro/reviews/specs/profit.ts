import type { AccountTurnover } from '../../../kernel';
import { parseMoney } from '../../../money';
import { RuleContext, RuleGapError, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import { computeBridge, type BridgeOptions } from '../../profit/bridge';
import { recoverLosses, type LossVintage } from '../../profit/losses';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of the profit tax (Codul fiscal title II, snapshot ANAF/Cod-fiscal-consolidat): where
 * the text, its methodological norms and the quarterly system leave a choice the engine had to
 * make. Every case runs the engine's own bridge (`profit/bridge.ts`) or loss recovery
 * (`profit/losses.ts`) on a small world, under both readings, against the register under review.
 */

const CF = 'ANAF/Cod-fiscal-consolidat';
const bani = (text: string) => parseMoney(text, 'RON');
const row = (account: string, debit: string, credit = '0'): AccountTurnover => ({
  account,
  debit: bani(debit),
  credit: bani(credit),
});

interface BridgeWorld {
  /** `2026-Q1` … or `2026`. */
  period: string;
  rows: AccountTurnover[];
  capital?: string;
  reserve?: string;
  /** Classifications by account. */
  natures?: Record<string, string>;
}

/** The bridge's tax and the rows a case shows, under one reading. */
function bridgeOutcome(
  register: ParameterRegister,
  world: BridgeWorld,
  options: Partial<BridgeOptions>,
  show: readonly string[],
): CaseOutcome {
  const rules = new RuleContext(register, 'preview');
  const year = Number(world.period.slice(0, 4));
  const quarter = world.period.length > 4 ? Number(world.period.slice(6)) : null;
  const end = (
    quarter === null
      ? `${year}-12-31`
      : [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`][quarter - 1]
  ) as LocalDate;
  try {
    const result = computeBridge(
      {
        label: world.period,
        year,
        start: `${year}-01-01` as LocalDate,
        end,
        microExitQuarter: null,
      },
      {
        rows: world.rows,
        capital: world.capital ? bani(world.capital) : 0n,
        reserve: world.reserve ? bani(world.reserve) : 0n,
        microFx: null,
        assets: [],
        losses: [],
        classification: (account) =>
          world.natures?.[account]
            ? {
                answer: { nature: world.natures[account] as never, evidenceIds: ['e'] },
                answerId: `a-${account}`,
              }
            : null,
        vehicle: () => null,
      },
      {
        determinations: [],
        legalReserve: false,
        declared: 0n,
        annual: quarter === null,
        ...options,
      },
      rules,
    );
    const blocks = result.issues.filter((issue) => issue.severity === 'block');
    if (blocks.length)
      return { summary: 'Blocat', lines: blocks.map((issue) => `${issue.code}: ${issue.message}`) };
    return {
      summary: `Calculat: profit impozabil ${result.rows.P40} lei, impozit ${result.rows.P48} lei`,
      lines: show.map((name) => `rd. ${name}: ${result.rows[name as 'P1']} lei`),
    };
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

function bridgeCase(
  title: string,
  facts: string,
  world: BridgeWorld,
  engine: Partial<BridgeOptions>,
  alternative: Partial<BridgeOptions>,
  show: readonly string[],
): ReviewCase {
  return {
    title,
    facts,
    run: (register) => ({
      engine: bridgeOutcome(register, world, engine, show),
      alternative: bridgeOutcome(register, world, alternative, show),
    }),
  };
}

export const legalReserveSpec: ReviewSpec = {
  key: 'ro.profit.legal_reserve',
  kind: 'interpretation',
  act: CF,
  minutes: 15,
  readings: {
    engine:
      'Societatea care constituie rezerva legală o deduce la fiecare calcul trimestrial, cumulat de la începutul anului, în limita a 5% din profitul contabil cu impozitul pe profit adăugat și până la o cincime din capitalul social (normele, pct. 19 alin. (1)), înainte ca rezerva să fie înregistrată în 1061 la sfârșitul exercițiului.',
    alternative:
      'Rezerva legală se deduce doar în calculul anual, după ce este constituită la sfârșitul exercițiului; calculele trimestriale nu o deduc.',
  },
  question:
    'Se deduce rezerva legală la calculul trimestrial al impozitului pe profit, cumulat de la începutul anului, înainte de a fi înregistrată la sfârșitul exercițiului (normele, titlul II pct. 19 alin. (1)), sau doar la calculul anual?',
  context: [`${CF}:art.19(1)`],
  cases: [
    bridgeCase(
      'Trimestrul I, sub plafon',
      'SRL cu capital social de 200.000 lei, fără rezervă legală; în trimestrul I 2026 venituri de 80.000 lei și cheltuieli de 30.000 lei; societatea constituie rezerva legală.',
      {
        period: '2026-Q1',
        rows: [row('704', '0', '80000.00'), row('628', '30000.00')],
        capital: '200000.00',
      },
      { legalReserve: true },
      { legalReserve: true, reserveAt: 'annual_only' },
      ['P13', 'P40'],
    ),
    bridgeCase(
      'Trimestrul III, la plafonul de o cincime din capital',
      'Capital social 10.000 lei, rezervă legală existentă 1.500 lei; cumulat la 30.09.2026 venituri de 120.000 lei și cheltuieli de 40.000 lei.',
      {
        period: '2026-Q3',
        rows: [row('704', '0', '120000.00'), row('628', '40000.00')],
        capital: '10000.00',
        reserve: '1500.00',
      },
      { legalReserve: true },
      { legalReserve: true, reserveAt: 'annual_only' },
      ['P13', 'P40'],
    ),
    bridgeCase(
      'Anul: aceeași rezervă în ambele lecturi',
      'Capital social 200.000 lei; în 2026 venituri de 300.000 lei și cheltuieli de 180.000 lei.',
      {
        period: '2026',
        rows: [row('704', '0', '300000.00'), row('628', '180000.00')],
        capital: '200000.00',
      },
      { legalReserve: true },
      { legalReserve: true, reserveAt: 'annual_only' },
      ['P13', 'P40'],
    ),
    bridgeCase(
      'Trimestrul II cu pierdere contabilă',
      'Capital social 200.000 lei; cumulat la 30.06.2026 venituri de 20.000 lei și cheltuieli de 25.000 lei.',
      {
        period: '2026-Q2',
        rows: [row('704', '0', '20000.00'), row('628', '25000.00')],
        capital: '200000.00',
      },
      { legalReserve: true },
      { legalReserve: true, reserveAt: 'annual_only' },
      ['P13', 'P40a'],
    ),
  ],
  gaps: [
    'Rezerva legală se înregistrează după închiderea conturilor de rezultat (year.legalReserve); motorul deduce, în calculul anual, rezerva pe care societatea declară că o constituie (legalReserve), iar înregistrarea ei ulterioară nu este comparată automat cu suma dedusă.',
  ],
};

export const socialLimitSpec: ReviewSpec = {
  key: 'ro.profit.social_limit',
  kind: 'interpretation',
  act: CF,
  minutes: 12,
  readings: {
    engine:
      'Limita de 5% a cheltuielilor sociale se aplică asupra cheltuielilor cu salariile personalului din contul 641, fără tichete, beneficii în natură și participarea la profit.',
    alternative:
      'Limita se aplică asupra cheltuielilor cu salariile și a celor asimilate (641, plus beneficiile și tichetele din 642 și participarea la profit din 644).',
  },
  question:
    'Asupra căror cheltuieli se aplică limita de 5% a cheltuielilor sociale („valoarea cheltuielilor cu salariile personalului, potrivit Codului muncii”, art. 25 alin. (3) lit. b)): doar salariile (641) sau și beneficiile, tichetele și participarea la profit (642, 644)?',
  context: [`${CF}:art.25(2)`],
  cases: [
    bridgeCase(
      'Doar salarii',
      'Salarii (641) de 100.000 lei, cadouri pentru salariați (cheltuieli sociale, 6458) de 6.000 lei, venituri de 300.000 lei.',
      {
        period: '2026',
        rows: [row('704', '0', '300000.00'), row('641', '100000.00'), row('6458', '6000.00')],
        natures: { '6458': 'social' },
      },
      {},
      { socialBase: 'salaries_benefits' },
      ['P33', 'P40'],
    ),
    bridgeCase(
      'Salarii și tichete de masă',
      'Salarii (641) de 100.000 lei, tichete de masă (6422) de 20.000 lei, cheltuieli sociale (6458) de 6.000 lei, venituri de 300.000 lei.',
      {
        period: '2026',
        rows: [
          row('704', '0', '300000.00'),
          row('641', '100000.00'),
          row('6422', '20000.00'),
          row('6458', '6000.00'),
        ],
        natures: { '6458': 'social', '6422': 'deductible' },
      },
      {},
      { socialBase: 'salaries_benefits' },
      ['P33', 'P40'],
    ),
    bridgeCase(
      'Salarii și participarea la profit',
      'Salarii (641) de 50.000 lei, participarea salariaților la profit (644) de 10.000 lei, cheltuieli sociale (6458) de 3.000 lei, venituri de 200.000 lei.',
      {
        period: '2026',
        rows: [
          row('704', '0', '200000.00'),
          row('641', '50000.00'),
          row('644', '10000.00'),
          row('6458', '3000.00'),
        ],
        natures: { '6458': 'social' },
      },
      {},
      { socialBase: 'salaries_benefits' },
      ['P33', 'P40'],
    ),
  ],
  gaps: [
    'Contul cheltuielilor sociale nu este dat de planul de conturi: o persoană îl clasifică (profit.account, social). Contul 6458 ține și contribuțiile suportate în numele salariaților după politica policy.payroll.employer_share, de aceea se clasifică analitic.',
  ],
};

export const sponsorshipSpec: ReviewSpec = {
  key: 'ro.profit.sponsorship',
  kind: 'interpretation',
  act: CF,
  minutes: 15,
  readings: {
    engine:
      'În sistemul trimestrial, sponsorizarea se scade din impozitul pe profit la fiecare trimestru, cumulat de la începutul anului, în limita minimă dintre 0,75% din cifra de afaceri cumulată și 20% din impozitul cumulat; calculul anual o definitivează.',
    alternative:
      'Sponsorizarea se scade din impozitul pe profit doar în calculul anual (declarația 101); trimestrele plătesc impozitul fără ea.',
  },
  question:
    'Contribuabilul în sistemul trimestrial (art. 41 alin. (1)) scade sponsorizarea din impozitul pe profit al fiecărui trimestru, cumulat, în limitele art. 25 alin. (4) lit. i), sau doar din impozitul anual?',
  context: [`${CF}:art.41(1)`],
  cases: [
    bridgeCase(
      'Trimestrul II cu sponsorizare',
      'Cumulat la 30.06.2026: cifră de afaceri (704) 400.000 lei, cheltuieli 300.000 lei, sponsorizare (6582) de 3.000 lei cu contract și beneficiar înscris în registru.',
      {
        period: '2026-Q2',
        rows: [row('704', '0', '400000.00'), row('628', '297000.00'), row('6582', '3000.00')],
        natures: { '6582': 'sponsorship' },
      },
      {},
      { sponsorshipAt: 'annual_only' },
      ['P27', 'P41', 'P43'],
    ),
    bridgeCase(
      'Trimestrul I, limita de 20% din impozit',
      'Cumulat la 31.03.2026: cifră de afaceri 1.000.000 lei, cheltuieli 990.000 lei, din care sponsorizare 5.000 lei.',
      {
        period: '2026-Q1',
        rows: [row('704', '0', '1000000.00'), row('628', '985000.00'), row('6582', '5000.00')],
        natures: { '6582': 'sponsorship' },
      },
      {},
      { sponsorshipAt: 'annual_only' },
      ['P41', 'P43', 'P48'],
    ),
    bridgeCase(
      'Anul: aceeași sumă în ambele lecturi',
      'În 2026: cifră de afaceri 200.000 lei, cheltuieli 102.000 lei, din care sponsorizare 2.000 lei (FP-05).',
      {
        period: '2026',
        rows: [row('704', '0', '200000.00'), row('628', '100000.00'), row('6582', '2000.00')],
        natures: { '6582': 'sponsorship' },
      },
      {},
      { sponsorshipAt: 'annual_only' },
      ['P41', 'P43', 'P48'],
    ),
  ],
  gaps: [
    'Suma nescăzută nu se reportează: art. 25 alin. (4) lit. i), în forma citită, nu mai prevede reportarea; rd. 43.2 (sume reportate din perioada precedentă, art. II alin. (2) din Legea nr. 322/2021) nu este acoperit.',
    'Declarația informativă privind beneficiarii (D107, art. 42 alin. (3)) nu este întocmită: închiderea obligațiilor o semnalează ca neacoperită.',
  ],
};

/** The recovery of some vintages in a year, under one reading of the years they keep. */
function lossOutcome(
  register: ParameterRegister,
  world: { vintages: LossVintage[]; year: number; profit: bigint },
  profitYears?: number[],
): CaseOutcome {
  try {
    const result = recoverLosses(
      world.vintages,
      world.year,
      world.profit,
      new RuleContext(register, 'preview'),
      profitYears ? { profitYears } : {},
    );
    return {
      summary: `Calculat: pierdere recuperată ${result.recovered} lei din ${result.available} lei`,
      lines: [
        ...result.used.map((item) => `Pierderea din ${item.year}: ${item.amount} lei recuperați`),
        ...result.expired.map(
          (item) => `Pierderea din ${item.year}: expirată (${item.remaining} lei)`,
        ),
      ],
    };
  } catch (error) {
    if (error instanceof RuleGapError)
      return { summary: 'Blocat: RULE_GAP', lines: [error.message] };
    throw error;
  }
}

const lossCase = (
  title: string,
  facts: string,
  world: { vintages: LossVintage[]; year: number; profit: bigint },
  profitYears: number[],
): ReviewCase => ({
  title,
  facts,
  run: (register) => ({
    engine: lossOutcome(register, world),
    alternative: lossOutcome(register, world, profitYears),
  }),
});

export const lossCarryforwardSpec: ReviewSpec = {
  key: 'ro.profit.loss_carryforward',
  kind: 'interpretation',
  act: CF,
  minutes: 20,
  readings: {
    engine:
      'Anii în care o pierdere se recuperează (5 pentru pierderile din 2024, restul celor 7 pentru cele dinainte) sunt ani calendaristici consecutivi după anul pierderii, inclusiv cei în care societatea a fost microîntreprindere; revenind la impozitul pe profit, recuperează ce a rămas în acești ani.',
    alternative:
      'Anii în care societatea a plătit impozit pe veniturile microîntreprinderilor nu se socotesc: termenul curge doar în anii cu impozit pe profit (art. 31 alin. (5), „de la data la care au revenit”).',
  },
  question:
    'Pentru o pierdere fiscală a unei societăți care devine apoi microîntreprindere și revine la impozitul pe profit (art. 31 alin. (5)), anii de microîntreprindere intră în cei 5 (sau 7) ani consecutivi de recuperare?',
  context: [`${CF}:art.31(5)`],
  cases: [
    lossCase(
      'Pierdere din 2021, microîntreprindere în 2022–2025',
      'Pierdere fiscală de 40.000 lei în 2021; microîntreprindere din 2022 până în 2025; din 2026 plătitoare de impozit pe profit, cu profit impozabil de 50.000 lei înainte de recuperare.',
      { vintages: [{ year: 2021, amount: 40000n, remaining: 40000n }], year: 2026, profit: 50000n },
      [2026],
    ),
    lossCase(
      'Pierdere din 2018, microîntreprindere în 2019–2024',
      'Pierdere fiscală de 30.000 lei în 2018; microîntreprindere din 2019 până în 2024; impozit pe profit din 2025; în 2026 profit impozabil de 100.000 lei înainte de recuperare.',
      {
        vintages: [{ year: 2018, amount: 30000n, remaining: 30000n }],
        year: 2026,
        profit: 100000n,
      },
      [2025, 2026],
    ),
    lossCase(
      'Pierdere din 2024, microîntreprindere în 2025–2028',
      'Pierdere fiscală de 20.000 lei în 2024; microîntreprindere din 2025 până în 2028; impozit pe profit din 2029; în 2030 profit impozabil de 60.000 lei înainte de recuperare.',
      { vintages: [{ year: 2024, amount: 20000n, remaining: 20000n }], year: 2030, profit: 60000n },
      [2029, 2030],
    ),
    lossCase(
      'Fără ani de microîntreprindere',
      'Pierdere fiscală de 10.000 lei în 2024, plătitoare de impozit pe profit în toți anii; în 2026 profit impozabil de 8.000 lei.',
      { vintages: [{ year: 2024, amount: 10000n, remaining: 10000n }], year: 2026, profit: 8000n },
      [2025, 2026],
    ),
  ],
  gaps: [
    'Pierderile anilor dinaintea registrelor se declară de o persoană (profit.losses), cu declarațiile 101 depuse; motorul nu le reconstituie.',
  ],
};
