import type { ProfileFact } from '../../../kernel';
import type { MicroConditionsAnswer } from '../../../questions/kinds';
import { RuleContext, type ParameterRegister } from '../../../rules';
import type { LocalDate } from '../../../time';
import {
  average,
  categoryOf,
  determineIncomeTax,
  determinePayrollPeriod,
  determineSizeCategory,
  determineVatThreshold,
  monthlyHeadcount,
  type Contract,
  type Determination,
  type DeterminationContext,
  type Known,
  type SizeCategory,
  type YearFigures,
} from '../../determinations/determine';
import type { SizeThresholds } from '../../determinations/parameters';
import type { CaseOutcome, ReviewCase, ReviewSpec } from '../types';

/*
 * Readings of the yearly determinations the texts leave open (src/ro/determinations): the
 * linked individual enterprise's norm during the year (Codul fiscal art. 52 alin. (5^2)), the
 * average number of employees of the quarterly D112 (art. 147 alin. (6)), the two-year rule of
 * the size category (OMFP nr. 1.802/2014 pct. 12–13) and the turnover of the small-enterprise
 * threshold (art. 310 alin. (2)). Each case runs the engine's determination on a fixed company.
 */

const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';
const RATE_NOTE =
  'Cursul EUR de la 31.12.2025 este luat, ipotetic, 5,0800 lei (100.000 € = 508.000,00 lei).';
const books = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
const fact = (axis: string, value: string, from: string): ProfileFact => ({
  axis,
  value,
  effectiveFrom: from as LocalDate,
});
const bani = (lei: string) => BigInt(Math.round(Number(lei) * 100));

function figures(year: number, overrides: Partial<YearFigures> = {}): YearFigures {
  return {
    year,
    kept: true,
    turnover: books(bani('300000')),
    netTurnover: books(bani('300000')),
    totalRevenue: books(bani('300000')),
    vatTurnover: books(bani('300000')),
    exemptionTurnover: books(bani('300000')),
    totalAssets: books(bani('200000')),
    averageEmployees: books('2.00'),
    averageEmployeesD112: books('2.00'),
    euGoodsAcquisitions: books(false),
    eurRate: books({ rate: '5.0800', multiplier: 1, date: '2025-12-31' }),
    ...overrides,
  };
}
const conditions = (linked: MicroConditionsAnswer['linked'] = []): MicroConditionsAnswer => ({
  stateOwned: false,
  dissolution: false,
  excludedActivity: false,
  shareholders: 'only_micro',
  statementsOnTime: 'yes',
  mandate: false,
  established: null,
  lateStatementsFrom: null,
  linked,
  evidenceIds: [EVIDENCE],
});
const employee: Contract = {
  employeeId: 'e1',
  start: '2024-01-01' as LocalDate,
  end: null,
  dailyHours: 8,
};
function company(overrides: Partial<DeterminationContext>): DeterminationContext {
  return {
    year: 2026,
    facts: [
      fact('entity.form', 'srl', '2020-01-01'),
      fact('vat.status', 'non_vat', '2020-01-01'),
      fact('income_tax', 'micro', '2025-01-01'),
    ],
    previous: figures(2025),
    current: figures(2026),
    activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: [] },
    contracts: [employee],
    micro: books(conditions()),
    today: '2027-03-01' as LocalDate,
    ...overrides,
  };
}

/** A determination as a reviewer reads it: what it proposes, and how. */
function outcome(determination: Determination): CaseOutcome {
  const summary =
    determination.status === 'proposed'
      ? `Propus: ${determination.axis} = ${determination.value}${determination.changes.map((change) => `, ${change.value} din ${change.effectiveFrom}`).join('')}`
      : determination.status === 'unsupported'
        ? `Neacoperit: ${determination.unsupported?.trigger ?? determination.axis}`
        : determination.status === 'rule_gap'
          ? 'Blocat: RULE_GAP'
          : determination.status === 'needs_evidence'
            ? 'Blocat: NEEDS_EVIDENCE'
            : 'Nu se aplică';
  return {
    summary,
    lines: [...determination.lines, ...determination.versions.map((id) => `Parametru ${id}`)],
  };
}
const rulesOf = (register: ParameterRegister) => new RuleContext(register, 'preview');

// ---------------------------------------------------------------------------------------------
// The linked individual enterprise on a norm (art. 52 alin. (5^2))

function normaCase(
  title: string,
  facts: string,
  quarters: [string, string, string, string],
): ReviewCase {
  const quarterTurnover = quarters.map(bani) as unknown as [bigint, bigint, bigint, bigint];
  const run = (register: ParameterRegister, linked: MicroConditionsAnswer['linked']) =>
    outcome(
      determineIncomeTax(
        company({
          micro: books(conditions(linked)),
          activity: { year: 2026, kept: true, quarterTurnover, days: [] },
        }),
        rulesOf(register),
      ),
    );
  return {
    title,
    facts: `Microîntreprindere din 2025; un asociat cu peste 25% are și o PFA impozitată pe normă, cu norma anuală de 40.000,00 lei în 2025 și în 2026. ${facts} ${RATE_NOTE}`,
    run: (register) => ({
      // The engine: a quarter of the yearly norm for each quarter elapsed.
      engine: run(register, [
        {
          name: 'PFA asociat',
          relation: 'd',
          basis: 'norma',
          previousYear: '40000.00',
          currentYear: { throughQuarter: 4, amount: '40000.00' },
        },
      ]),
      // The alternative: one quarter of the norm, whatever the quarter.
      alternative: run(register, [
        {
          name: 'PFA asociat',
          relation: 'd',
          basis: 'turnover',
          previousYear: '40000.00',
          currentYear: { throughQuarter: 4, amount: '10000.00' },
        },
      ]),
    }),
  };
}

export const microLinkedSpec: ReviewSpec = {
  key: 'ro.micro.linked',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'În cursul anului, la veniturile cumulate de la începutul anului ale microîntreprinderii se adaugă, pentru fiecare trimestru scurs, o pătrime din norma anuală de venit a PFA, II sau IF legate impozitate pe normă (până la trimestrul al patrulea, întreaga normă), ca o cifră de afaceri cumulată.',
    alternative:
      'Se adaugă o singură pătrime din norma anuală, oricare ar fi trimestrul în care se verifică limita.',
  },
  question:
    'La verificarea limitei de 100.000 euro în cursul anului (art. 52 alin. (5^2)), „o pătrime din norma anuală de venit” a întreprinderii legate se adaugă o dată pentru fiecare trimestru scurs de la începutul anului, sau o singură dată?',
  context: ['ANAF/Cod-fiscal-consolidat:art.52(1),(5)'],
  cases: [
    normaCase('Primul trimestru', 'Venituri proprii: 100.000,00 lei în trimestrul I, nimic după.', [
      '100000',
      '0',
      '0',
      '0',
    ]),
    normaCase(
      'Al treilea trimestru, aproape de limită',
      'Venituri proprii: 160.000,00 lei în fiecare dintre trimestrele I–III (480.000,00 lei cumulat).',
      ['160000', '160000', '160000', '0'],
    ),
    normaCase(
      'Al doilea trimestru, departe de limită',
      'Venituri proprii: 150.000,00 lei în trimestrele I și II.',
      ['150000', '150000', '0', '0'],
    ),
    normaCase(
      'Limita depășită numai cu veniturile proprii',
      'Venituri proprii: 300.000,00 lei în trimestrul I și 250.000,00 lei în trimestrul II.',
      ['300000', '250000', '0', '0'],
    ),
  ],
  gaps: [
    'Cursul EUR din cazuri (5,0800 lei) este ipotetic; cursul BNR de la 31.12.2025 nu este în .sources/.',
    'Deținerile (directe sau indirecte, peste 25%) și dreptul de a numi administratorul nu sunt calculate de motor: proprietarul răspunde la întrebarea micro.conditions, cu certificatul constatator și registrul asociaților; tot el dă cifra de afaceri a celorlalte întreprinderi legate, cumulată pe trimestre.',
    'Pentru condiția de intrare (art. 47 alin. (1^1) lit. d)), motorul adaugă norma anuală întreagă a anului precedent. Dacă o persoană juridică care deține ambele societăți (lit. c)) își adaugă propriile venituri se citește din text și este aplicat prin răspunsul proprietarului.',
    'Litera f) a art. 47 alin. (1) a fost abrogată prin OUG nr. 156/2024 art. LXIV pct. 3; că era ponderea veniturilor din consultanță și management se citește din art. 54 alin. (3), textul literei înainte de abrogare nu este în .sources/. Motorul nu verifică ponderea pentru 2026.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The average number of employees of the quarterly D112 (art. 147 alin. (6))

function headcountCase(title: string, facts: string, contracts: Contract[]): ReviewCase {
  const counts = monthlyHeadcount(contracts, 2025);
  const months = counts.filter((count) => count > 0);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const run = (register: ParameterRegister, mean: string) =>
    outcome(
      determinePayrollPeriod(
        company({
          facts: [
            fact('entity.form', 'srl', '2020-01-01'),
            fact('income_tax', 'micro', '2026-01-01'),
          ],
          previous: figures(2025, { averageEmployeesD112: books(mean) }),
          contracts: [...contracts, employee],
        }),
        rulesOf(register),
      ),
    );
  return {
    title,
    facts: `Microîntreprindere în 2026, cu salariați. ${facts} Numărul lunar de salariați în 2025: ${counts.join(', ')}.`,
    run: (register) => ({
      engine: run(register, average(total, months.length)),
      alternative: run(register, average(total, 12)),
    }),
  };
}
const contract = (id: string, start: string, end: string | null = null): Contract => ({
  employeeId: id,
  start: start as LocalDate,
  end: end as LocalDate | null,
  dailyHours: 8,
});

export const payrollQuarterlySpec: ReviewSpec = {
  key: 'ro.payroll.quarterly',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 20,
  readings: {
    engine:
      'Numărul mediu de salariați al anului anterior este media aritmetică a numărului de salariați din declarațiile 112 depuse, adică din lunile cu salariați; „până la 3 salariați exclusiv” înseamnă o medie sub 3. Un an fără nicio declarație are media zero.',
    alternative:
      'Media se calculează pe toate cele 12 luni ale anului anterior, lunile fără salariați numărând cu zero.',
  },
  question:
    'Pentru D112 trimestrială (art. 80 alin. (2) lit. b)–c), art. 147 alin. (6)), numărul mediu de salariați se împarte la numărul lunilor pentru care s-a depus D112, sau la 12?',
  context: [],
  cases: [
    headcountCase('Doi salariați tot anul', 'Doi salariați cu normă întreagă tot anul 2025.', [
      contract('a', '2024-01-01'),
      contract('b', '2024-01-01'),
    ]),
    headcountCase(
      'Patru salariați jumătate de an',
      'Patru salariați din 01.07.2025, niciunul înainte.',
      [
        contract('a', '2025-07-01'),
        contract('b', '2025-07-01'),
        contract('c', '2025-07-01'),
        contract('d', '2025-07-01'),
      ],
    ),
    headcountCase('Trei salariați tot anul', 'Trei salariați tot anul 2025.', [
      contract('a', '2024-01-01'),
      contract('b', '2024-01-01'),
      contract('c', '2024-01-01'),
    ]),
    headcountCase(
      'Cinci salariați angajați în decembrie',
      'Cinci salariați angajați la 01.12.2025.',
      [
        contract('a', '2025-12-01'),
        contract('b', '2025-12-01'),
        contract('c', '2025-12-01'),
        contract('d', '2025-12-01'),
        contract('e', '2025-12-01'),
      ],
    ),
  ],
  gaps: [
    'Numărul de salariați al unei luni este numărul celor cu un contract de muncă în acea lună, din registre; D112 numără asigurații declarați, ceea ce poate include și alte persoane (de pildă administratorul cu contract de mandat). Contractele suspendate nu sunt modelate.',
    'Veniturile totale ale anului anterior (art. 147 alin. (7)) sunt veniturile din clasa 7, transformate în euro la cursul BNR de la 31 decembrie al anului anterior: textul nu spune cursul.',
    'Opțiunea pentru D112 lunară (art. 147 alin. (8)) nu se vede în registre: persoana care confirmă determinarea o declară, cu documentul depus.',
    'O persoană juridică înființată în cursul anului (art. 147 alin. (10)) se încadrează după estimarea din declarația de înregistrare: motorul o întreabă.',
  ],
};

// ---------------------------------------------------------------------------------------------
// The two-year rule of the size category (OMFP nr. 1.802/2014 pct. 12–13)

type Size = { assets: string; turnover: string; employees: string };
function sizeCase(
  title: string,
  facts: string,
  previous: SizeCategory,
  before: Size,
  now: Size,
): ReviewCase {
  const year = (value: Size, at: number) =>
    figures(at, {
      totalAssets: books(bani(value.assets)),
      netTurnover: books(bani(value.turnover)),
      averageEmployees: books(value.employees),
    });
  const indicators = (value: Size) => ({
    assets: bani(value.assets),
    turnover: bani(value.turnover),
    employees: value.employees,
  });
  return {
    title,
    facts: `Categoria înregistrată pentru 2025: ${previous}. ${facts}`,
    run: (register) => {
      const engine = determineSizeCategory(
        company({
          facts: [
            fact('entity.form', 'srl', '2020-01-01'),
            fact('size.category', previous, '2025-01-01'),
          ],
          previous: year(before, 2025),
          current: year(now, 2026),
        }),
        rulesOf(register),
      );
      // The alternative: when both years are beyond the category, the current year's own.
      const resolved = register.resolve<SizeThresholds>('ro.size.thresholds', {
        axis: 'fiscal_year_start',
        date: '2026-01-01' as LocalDate,
        mode: 'preview',
      });
      if (!resolved.ok)
        return { engine: outcome(engine), alternative: { summary: 'Blocat: RULE_GAP', lines: [] } };
      const order = ['micro', 'small', 'medium_large'];
      const [a, b] = [
        categoryOf(indicators(before), resolved.value),
        categoryOf(indicators(now), resolved.value),
      ];
      const up =
        order.indexOf(a) > order.indexOf(previous) && order.indexOf(b) > order.indexOf(previous);
      const down =
        order.indexOf(a) < order.indexOf(previous) && order.indexOf(b) < order.indexOf(previous);
      const category = up || down ? b : previous;
      return {
        engine: outcome(engine),
        alternative:
          category === 'medium_large'
            ? { summary: 'Neacoperit: SIZE_MEDIUM_LARGE', lines: [`2025: ${a}; 2026: ${b}.`] }
            : {
                summary: `Propus: size.category = ${category}`,
                lines: [`2025: ${a}; 2026: ${b}.`],
              },
      };
    },
  };
}
const micro: Size = { assets: '1000000', turnover: '2000000', employees: '4.00' };
const small: Size = { assets: '3000000', turnover: '5000000', employees: '12.00' };
const large: Size = { assets: '30000000', turnover: '60000000', employees: '60.00' };

export const sizeThresholdsSpec: ReviewSpec = {
  key: 'ro.size.thresholds',
  kind: 'interpretation',
  act: 'OMF2036/2025',
  minutes: 25,
  readings: {
    engine:
      'Entitatea își schimbă categoria numai când atât exercițiul precedent, cât și cel curent depășesc (sau nu mai depășesc) două dintre cele trei criterii ale categoriei ei, ambii ani judecați după pragurile anului curent; ea trece atunci în categoria cea mai apropiată dintre cele două (cea mai mică la creștere, cea mai mare la scădere).',
    alternative:
      'Când ambii ani depășesc criteriile categoriei, entitatea trece direct în categoria dată de indicatorii exercițiului curent.',
  },
  question:
    'O microentitate care depășește criteriile microentităților în ambii ani, dar pe cele ale entităților mici numai în exercițiul curent, devine entitate mică (motorul) sau entitate mijlocie ori mare (după indicatorii anului curent)?',
  context: [],
  cases: [
    sizeCase(
      'Un singur an peste criterii',
      'În 2025 depășește criteriile microentităților, în 2026 nu.',
      'micro',
      small,
      micro,
    ),
    sizeCase(
      'Doi ani peste criteriile microentităților',
      'În 2025 și 2026 depășește criteriile microentităților, nu și pe ale entităților mici.',
      'micro',
      small,
      small,
    ),
    sizeCase(
      'Al doilea an mult peste',
      'În 2025 depășește criteriile microentităților; în 2026 și pe ale entităților mici.',
      'micro',
      small,
      large,
    ),
    sizeCase(
      'Doi ani sub criterii',
      'Entitate mică; în 2025 și 2026 nu mai depășește criteriile microentităților.',
      'small',
      micro,
      micro,
    ),
  ],
  gaps: [
    'Pragurile în lei sunt cele pe care OMF nr. 2.036/2025 le citează din pct. 9 al OMFP nr. 1.802/2014 cu modificările ulterioare, pentru exercițiul 2025; actul care a trecut pct. 9 în lei nu este în .sources/ (copia ANAF a OMFP nr. 1.802/2014 are încă pragurile în euro), iar aplicarea lor pentru 2026 presupune că pct. 9 nu s-a schimbat.',
    'Numărul mediu de salariați este media numărului lunar de salariați pe cele 12 luni ale exercițiului, din contractele de muncă din registre; metoda din datele informative (F30) nu este citită.',
    'Totalul activelor este suma rândurilor A–C ale bilanțului prescurtat (pct. 15), citite din soldurile de la 31 decembrie cu formulele S1005; un cont pe care formularul îl împarte între un rând de activ și unul de datorie, fără analitic, face totalul necunoscut și se întreabă.',
    'O entitate nou-înființată poate alege pentru primul exercițiu (OMF nr. 2.036/2025 pct. 2.5): motorul întreabă categoria.',
  ],
};

// ---------------------------------------------------------------------------------------------
// When a supply counts towards the small-enterprise threshold (art. 310 alin. (2) and (6))

type Supply = { booked: string; supplied: string; amount: string };
function exemptionCase(title: string, facts: string, supplies: Supply[]): ReviewCase {
  const run = (register: ParameterRegister, date: (supply: Supply) => string) =>
    outcome(
      determineVatThreshold(
        company({
          activity: {
            year: 2026,
            kept: true,
            quarterTurnover: [0n, 0n, 0n, 0n],
            days: supplies
              .filter((supply) => date(supply).startsWith('2026'))
              .sort((a, b) => date(a).localeCompare(date(b)))
              .map((supply) => ({
                date: date(supply) as LocalDate,
                exemption: bani(supply.amount),
                vat: 0n,
              })),
          },
        }),
        rulesOf(register),
      ),
    );
  return {
    title,
    facts: `Firmă neînregistrată în scopuri de TVA în 2026, cu servicii prestate în România. ${facts}`,
    run: (register) => ({
      // The engine: on the day the revenue is booked (70x), from the invoice.
      engine: run(register, (supply) => supply.booked),
      // The alternative: on the day of the supply, whenever it is invoiced.
      alternative: run(register, (supply) => supply.supplied),
    }),
  };
}

export const vatExemptionSpec: ReviewSpec = {
  key: 'ro.vat.exemption.threshold',
  kind: 'interpretation',
  act: 'ANAF/Cod-fiscal-consolidat',
  minutes: 15,
  readings: {
    engine:
      'Cifra de afaceri a regimului de scutire se cumulează din veniturile înregistrate în conturile 70x (net de 709), în ziua înregistrării lor (de regulă data facturii), fără livrările cu locul în străinătate și fără vânzarea activelor fixe și necorporale (7583, exclusă de alin. (2)); plafonul este depășit în ziua înregistrării care îl depășește.',
    alternative:
      'O livrare sau o prestare intră în cifra de afaceri a anului și la data la care are loc (faptul generator, art. 281), chiar dacă este facturată și înregistrată mai târziu.',
  },
  question:
    'Pentru plafonul de 395.000 lei (art. 310 alin. (2) și (6)), o prestare efectuată în decembrie și facturată în ianuarie intră în cifra de afaceri a anului în care a fost efectuată sau a celui în care a fost facturată și înregistrată?',
  context: ['ANAF/Cod-fiscal-consolidat:art.310(4)-(5)'],
  cases: [
    exemptionCase(
      'Servicii sub plafon',
      'Servicii de 300.000,00 lei, facturate în luna prestării.',
      [{ booked: '2026-06-30', supplied: '2026-06-30', amount: '300000' }],
    ),
    exemptionCase(
      'O prestare din decembrie facturată în ianuarie',
      'Servicii de 380.000,00 lei facturate în 2026 și o prestare de 30.000,00 lei încheiată la 20.12.2026, facturată la 10.01.2027.',
      [
        { booked: '2026-11-30', supplied: '2026-11-30', amount: '380000' },
        { booked: '2027-01-10', supplied: '2026-12-20', amount: '30000' },
      ],
    ),
    exemptionCase(
      'Servicii peste plafon',
      'Servicii de 400.000,00 lei, facturate în luna prestării.',
      [{ booked: '2026-10-05', supplied: '2026-10-05', amount: '400000' }],
    ),
  ],
  gaps: [
    'Data de la care plafonul este 395.000 lei (înainte 300.000 lei) nu se citește din textul consolidat ANAF, care arată doar forma în vigoare; actul care l-a modificat nu este în .sources/. Versiunea începe la 01.01.2026; anii anteriori sunt RULE_GAP.',
    'Veniturile din 70x sunt măsura livrărilor unei firme neplătitoare: facturile ei nu au înregistrări de TVA. Un venit din 708 care nu este o livrare (o refacturare de cheltuieli, de pildă) intră în cifră.',
    'Operațiunile scutite fără drept de deducere de la art. 292 alin. (2) lit. a), b), e) și f), care intră în cifra de afaceri dacă nu sunt accesorii, nu sunt categorii tratate de motor.',
    'Depășirea în cursul anului face înregistrarea obligatorie (art. 316 alin. (1) lit. b)): motorul propune vat.status plătitor de la ziua depășirii (alin. (1^1) lit. b)) și calculează TVA datorată pentru înregistrarea întârziată (vat.registration, vat.lateRegistration).',
    'O firmă nou-înființată în cursul anului cumulează de la prima zi a primului exercițiu financiar, cu plafonul întreg (art. 310 alin. (5)).',
  ],
};
