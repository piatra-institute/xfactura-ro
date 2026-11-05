import { DomainError } from '../../errors';
import { element, serializeXml, type XmlNode } from '../../xml/write';
import { isValidCnp, isValidIban } from '../identifiers';

/**
 * The Declarația unică (formular 212, "Declarație unică privind impozitul pe venit și
 * contribuțiile sociale datorate de persoanele fizice") of the holder of a PFA or an II: one
 * source of independent income (categ_venit 1016) in the real system (det_ven_net 1), carried on
 * individually (forma_org 1), by a resident; the CAS and CASS on it, the tax of Section 4, the
 * summary of Section 7 and, in Chapter II, the option to pay CASS in the filing year (art. 180).
 * Each format is pinned to the income year it declares:
 *
 * - Income of 2024, filed in 2025 (an_r 2025): ANAF's structure D212_A1.0.3, namespace v11, of
 *   01.08.2025 (OPANAF nr. 1929/2025, structura_D212_2025_v1.0.3_01082025.pdf, SHA-256
 *   b01d056e…). ANAF's validator J13.0.1 (D212Validator_01082025.zip, 58abef98…) checks it. That
 *   validator enforces the XSD (names, types, the CAEN Rev. 2 list, the CNP's control digit) and
 *   a few rules (R1, R4, R7, R8, R10, the option's total), not the structure's arithmetic, and it
 *   accepts any an_r from 2025 in namespace v11; the controls of `checkD212` are therefore the
 *   gate for the amounts.
 * - Income of 2025, filed in 2026 (an_r 2026, OPANAF nr. 2.736/2025): ANAF publishes no
 *   structure, XSD or Java validator for it; it is filed through ANAF's web form (anaf.ro/
 *   declaratii/duf, V-1.8.10 / 15.05.2026). This structure is the XML that form writes, read from
 *   its public JavaScript (bundle 0q0aa-_tiydwh.js, SHA-256 e93cef76…): attribute names, order,
 *   which zeros it writes, the 4-decimal weights. There is no official validator: the oracle is
 *   the web form itself (the same data typed in gives the same XML) and ANAF's server-side check
 *   when the form generates the PDF. The constants it uses (4.050 lei, 60 wages, 25%, 10%) agree
 *   with the instructions of OPANAF nr. 2.736/2025.
 *
 * The sources of independent income are declared one subsection each (instructions cap. IV): in
 * the real system (`activity`, `activities`: cap11), individually or as a member of an association
 * without legal personality (forma_org 2: a family enterprise's member, who declares only the net
 * income or loss distributed to them, art. 122 alin. (4), as the only source); or on a norm
 * (`norm`, `norms`: cap12). CAS and CASS count them together (art. 148 alin. (3), art. 170 alin.
 * (1)); Section 4 sums the recalculated net incomes. In the web form, Section 3.2.2 carries the
 * CASS on rent and investments the person declares (`cassOther`).
 *
 * Not written, refused by the checks instead of guessed: other categories' own subsections (rent,
 * investments with their tax), a change of form in the year, non-residents, income withheld at
 * source, CAS withheld by a payer, the disability exemption (exempt days), a local gastronomic
 * point, the bonus of Section 8 (it depends on payment by a date the budget law sets) and
 * dependants.
 *
 * The amounts are the fiscal register's, in whole lei (N(15)); the writer derives only the rows
 * the form derives (net income, Section 4's taxable income, the weights, Section 7). The CNP is
 * written into the XML and nowhere else: no check message repeats it.
 */

/** The constants a structure's controls use, as the structure (not the rule register) states
 * them: a computed amount that disagrees with them is reported, never corrected. */
export type D212Controls = {
  /** The minimum wage of Chapter I's bases and thresholds. */
  minimumWage: number;
  casPercent: number;
  cassPercent: number;
  taxPercent: number;
  /** CAS: the income bands and least bases, in minimum wages. */
  casWages: readonly [number, number];
  /** CASS on independent income: the least base and the cap, in minimum wages. */
  cassWages: { minimum: number; maximum: number };
  /** The share of the year's net income carried losses may offset. */
  lossPercent: number;
  /** Chapter II: the option's base and CASS. */
  option: { base: number; due: number };
  /** Section 3.2.2: the bands of the CASS on other income (art. 170 alin. (3)), in minimum
   * wages; null when the structure is not written for it here. */
  cassOtherWages: readonly number[] | null;
};

export type D212Structure = {
  /** The income year Chapter I declares. */
  year: number;
  /** an_r: the year it is filed in. */
  anR: number;
  namespace: string;
  structure: string;
  /** ANAF's validator for it; null when ANAF publishes none. */
  validator: string | null;
  controls: D212Controls;
};

const namespace = 'mfp:anaf:dgti:d212:declaratie:v11';

const structures: Readonly<Record<number, D212Structure>> = {
  // cas_baza >= 12*3300 / 24*3300, baza_cass_datorat_ai <= 198000, baza_optiune = 24300.
  2024: {
    year: 2024,
    anR: 2025,
    namespace,
    structure: 'D212_A1.0.3, 01.08.2025',
    validator: 'D212Validator J13.0.1',
    controls: {
      minimumWage: 3300,
      casPercent: 25,
      cassPercent: 10,
      taxPercent: 10,
      casWages: [12, 24],
      cassWages: { minimum: 6, maximum: 60 },
      lossPercent: 70,
      option: { base: 24_300, due: 2430 },
      cassOtherWages: null,
    },
  },
  // Number("4050") throughout the form; 6, 12, 24 and 60 wages; 70% of the net income.
  2025: {
    year: 2025,
    anR: 2026,
    namespace,
    structure: 'formularul web V-1.8.10 / 15.05.2026',
    validator: null,
    controls: {
      minimumWage: 4050,
      casPercent: 25,
      cassPercent: 10,
      taxPercent: 10,
      casWages: [12, 24],
      cassWages: { minimum: 6, maximum: 60 },
      lossPercent: 70,
      option: { base: 24_300, due: 2430 },
      // nn(): 6*r, 12*r, 24*r at r = 4050.
      cassOtherWages: [6, 12, 24],
    },
  },
};

/** The income years with a pinned structure. */
export const d212IncomeYears = Object.keys(structures).map(Number);

/** The structure for an income year, or null when none is pinned. */
export function d212Format(year: number): D212Structure | null {
  return structures[year] ?? null;
}

export type D212Taxpayer = {
  /** cif: the holder's CNP. */
  cnp: string;
  lastName: string;
  /** The initial of the father's first name. */
  initial?: string;
  firstName: string;
  /** adresa_c: the fiscal domicile. */
  address: string;
  phone?: string;
  email?: string;
  /** cont_bancar: the IBAN for refunds. */
  iban?: string;
};

/** Chapter I, Section 1, Subsection 1: the activity and its net income. Dates are YYYY-MM-DD. */
export type D212Activity = {
  caen: string;
  /** descriere_sediu_bun: where the activity is carried on. */
  seat: string;
  /** nr_doc_autoriz, data_doc_autoriz */
  authorization: { number: string; date: string };
  /** data_incep, data_sf: only when the activity started or ended in the year. */
  startedOn?: string;
  endedOn?: string;
  /** data_suspendare (2026 structure): the suspension, when it started in the year. */
  suspendedOn?: string;
  /** venit_brut, chelt_deduc: the fiscal register's totals; absent for a member of an
   * association, who declares only what was distributed to them. */
  gross?: number;
  deductible?: number;
  /** A member of an association without legal personality (forma_org 2), such as a family
   * enterprise's: the association contract as registered with the fiscal body (rd. 7), and the
   * net income or loss distributed to the member (rd. 3 and rd. 4; Codul fiscal art. 122 alin.
   * (4), art. 125 alin. (5)). */
  association?: { number: string; date: string; net: number; loss: number };
  /** pierdere_precedenta: losses of earlier years open to offset this year. */
  carriedLosses: number;
  /** pierdere_compensata */
  offsetLoss: number;
};

/** The criteria of the norms' correction coefficients (norme pct. 8 alin. (7)), as the web form
 * codes them: 01 vadul comercial … 13 alte criterii. */
export const normCriteria = [
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
] as const;
export type NormCriterion = (typeof normCriteria)[number];

/** Chapter I, Section 1, Subsection 2: one place of an activity whose net income is a norm
 * (Codul fiscal art. 69). Dates are YYYY-MM-DD. */
export type D212Norm = {
  /** norma_forma_org 2: a member of an association, each on their own norm (art. 69 alin. (3),
   * art. 125 alin. (10)); 1 individually. */
  association: boolean;
  caen: string;
  /** norma_descriere_sediu_bun (2024 structure); the web form takes the place from ANAF's
   * nomenclators of counties, localities and streets, whose codes are not public. */
  seat: string;
  authorization: { number: string; date: string };
  startedOn?: string;
  endedOn?: string;
  suspendedOn?: string;
  /** Days of activity in the year when less than all of it (art. 69 alin. (5)). */
  activeDays?: number;
  /** norma_zile_intrerupere (web form): days of temporary interruption in the year. */
  interruptedDays?: number;
  /** rd. 7 real_norma_venit: the norm the DGRFP published for the activity and place. */
  norm: number;
  /** The highest increasing and reducing coefficients, in percent, and the criterion each comes
   * from (instructions: "coeficientul de majorare și/sau coeficientul de reducere cel mai mare"). */
  increase?: { percent: string; criterion: NormCriterion };
  reduction?: { percent: string; criterion: NormCriterion };
  /** rd. 8 real_ajustare: the norm adjusted by the coefficients (the norm when there is none). */
  adjusted: number;
  /** rd. 9 real_venit_net_anual: the adjusted norm reduced to the days of activity; rd. 9.1, the
   * taxable income, is the same without exempt days. */
  net: number;
  /** real_impozit, norma_impozit: 10% of rd. 9.1 (art. 69^2). */
  tax: number;
};

export type D212 = {
  /** The income year. */
  year: number;
  /** A rectifying return: the chapters it rectifies, each written in full. */
  rectifies?: { income: boolean; option: boolean };
  taxpayer: D212Taxpayer;
  /** The source in the real system (cap11), and */
  activity?: D212Activity;
  /** the source on a norm (cap12); */
  norm?: D212Norm;
  /** with several sources, the others: one subsection for each (instructions cap. IV, pct. 3.4:
   * "câte o subsecțiune pentru fiecare categorie de venit și pentru fiecare sursă"). */
  activities?: D212Activity[];
  norms?: D212Norm[];
  /** Section 3.2.2 (the web form's only): CASS on the income of art. 155 alin. (1) lit. c)–h)
   * the person declares from outside the books, as declared: rent (row 1.3) and investments,
   * dividends included (row 1.4); the base of the band reached and the CASS a payer withheld. */
  cassOther?: { rent: number; investment: number; base: number; due: number; withheld: number };
  /** The holder's situation for CAS (art. 150): exempt as a pensioner or in an own system. */
  casStatus: 'liable' | 'pensioner' | 'own_system';
  /** Section 3.1; null when no CAS is due. */
  cas: { base: number; due: number } | null;
  /** One of art. 174 alin. (7)–(8)'s exceptions lets the CASS base fall below the minimum. */
  cassException: boolean;
  /** Section 3.2.1; null when no CASS is due (a loss or a zero net income). `minimumDifference`
   * is the part of `due` owed only to reach the minimum base (art. 174 alin. (6)). */
  cass: { base: number; due: number; minimumDifference: number } | null;
  /** Section 4 as the fiscal register computed it: the real system's tax (0 on a norm, whose tax
   * is the norm's own). */
  tax: { deductibleCas: number; deductibleCass: number; due: number };
  /** Chapter II: the option to pay CASS in the filing year, after a loss (B) or a zero net
   * income (C) in the income year. */
  cassOption?: { situation: 'B' | 'C'; base: number; due: number };
};

export type D212Check = {
  code: string;
  /** error: the structure forbids it or the amounts disagree with its controls; warning: the
   * form accepts it, and someone should look (a rounding conflict, a character the structure
   * lists as not allowed but ANAF's validator accepts). */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const maxAmount = 999_999_999_999_999;
const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxAmount;

function isDate(date: string | undefined): date is string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

/** YYYY-MM-DD as zz.ll.aaaa. */
const formDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** amount × percent / 100 rounded half up, as the structures write it (math.round), and whether
 * the exact value is half a leu: there the Code's rounding (art. 66: up to 50 bani dropped)
 * gives one leu less. */
function percentOf(amount: number, percent: number) {
  const hundredths = BigInt(amount) * BigInt(percent);
  const whole = hundredths / 100n;
  const rest = hundredths % 100n;
  return { value: Number(rest >= 50n ? whole + 1n : whole), half: rest === 50n };
}

/** A weight rd.1/rd.2 in hundred-thousandths: to 5 decimals (2025), or to 4 printed with 5
 * (the web form's `Math.round(1e4*r/n)/1e4` then `toFixed(5)`). */
function weight(part: number, total: number, decimals: 4 | 5) {
  const scale = 10n ** BigInt(decimals);
  const scaled = (BigInt(part) * scale * 2n + BigInt(total)) / (2n * BigInt(total));
  return scaled * 10n ** BigInt(5 - decimals);
}
const weightText = (weight: bigint) =>
  `${weight / 100_000n}.${String(weight % 100_000n).padStart(5, '0')}`;
/** weight × amount, rounded half up to the leu. */
const weighted = (weight: bigint, amount: number) =>
  Number((weight * BigInt(amount) * 2n + 100_000n) / 200_000n);

/** The rows of the declaration the form derives from the register's amounts. */
export type D212Calculation = {
  structure: D212Structure;
  /** The cumulated net income of the CAS and CASS (the activities' rd.3 and the norms' rd. 9),
   * the activities' losses (rd.4) and recalculated incomes (rd.7), summed. */
  net: number;
  loss: number;
  recalculated: number;
  /** Each activity's rd.3, rd.4 and rd.7, in the order of `activitiesOf`. */
  activities: { net: number; loss: number; recalculated: number }[];
  /** The CAS band: 0 below the first threshold, 1 between, 2 at or above the second. */
  casBand: 0 | 1 | 2;
  /** Section 4 and its subsections; null when the net income is zero. Rows 2 and 3 are the
   * weighted contributions of 4.1 and 4.2 in the web form; in D212_A1.0.3 the register's, which
   * art. 118 alin. (2^4) caps at the recalculated income (rd.1 >= rd.2 + rd.3). */
  section4: {
    recalculated: number;
    deductibleCas: number | null;
    deductibleCass: number | null;
    taxable: number;
    tax: number;
    cas: {
      net: number;
      total: number;
      weight: bigint | null;
      due: number | null;
      deductible: number | null;
    };
    cass: {
      net: number;
      total: number;
      weight: bigint;
      due: number;
      computed: number | null;
      deductible: number | null;
    };
  } | null;
  /** Section 3.2.2: the declared total, its band and its differences. */
  cassOther: { total: number; band: number; plus: number; minus: number } | null;
  /** Section 7: what the return establishes, what is payable and what is refunded. */
  totals: { tax: number; cas: number; cass: number; payable: number; refund: number };
  /** totalPlata_A: the sum of the CNP's digits. */
  controlSum: number;
};

const yearMessage = (year: number) =>
  `Declarația unică pentru veniturile anului ${year} nu are o structură fixată: sunt fixate cele pentru ${d212IncomeYears.join(' și ')}.`;

/** The sources declared: the single fields first, then the lists, each with its path. */
export function activitiesOf(model: D212) {
  return [
    ...(model.activity ? [{ item: model.activity, path: 'activity' }] : []),
    ...(model.activities ?? []).map((item, index) => ({ item, path: `activities.${index}` })),
  ];
}
export function normsOf(model: D212) {
  return [
    ...(model.norm ? [{ item: model.norm, path: 'norm' }] : []),
    ...(model.norms ?? []).map((item, index) => ({ item, path: `norms.${index}` })),
  ];
}

/** An activity's net income and loss: the register's gross income less its expenses, or what an
 * association distributed to the member. */
function activityResult(activity: D212Activity) {
  if (activity.association)
    return { net: activity.association.net, loss: activity.association.loss };
  const gross = activity.gross ?? 0;
  const deductible = activity.deductible ?? 0;
  return { net: Math.max(gross - deductible, 0), loss: Math.max(deductible - gross, 0) };
}

/** The declared sources' results: each activity's, and the cumulated net income of the CAS and
 * CASS (art. 148 alin. (3), art. 170 alin. (1): net incomes and norms, losses counted as zero). */
function results(model: D212) {
  const activities = activitiesOf(model).map(({ item }) => activityResult(item));
  const realNet = activities.reduce((sum, item) => sum + item.net, 0);
  const norms = normsOf(model).reduce((sum, { item }) => sum + item.net, 0);
  return {
    activities,
    realNet,
    net: realNet + norms,
    loss: activities.reduce((sum, item) => sum + item.loss, 0),
  };
}

/** The inputs calculateD212 cannot use: the year, the sources and the amounts. */
function inputProblems(model: D212) {
  const problems: { code: string; path: string; message: string }[] = [];
  if (!d212Format(model.year))
    problems.push({ code: 'D212_YEAR', path: 'year', message: yearMessage(model.year) });
  const amount = (path: string, value: unknown) => {
    if (!isAmount(value))
      problems.push({
        code: 'D212_AMOUNT',
        path,
        message: 'Sumele se declară în lei, fără zecimale, nenegative, de cel mult 15 cifre.',
      });
  };
  const activities = activitiesOf(model);
  const norms = normsOf(model);
  if (!activities.length && !norms.length)
    problems.push({
      code: 'D212_SOURCE',
      path: 'activity',
      message:
        'Declarația cuprinde cel puțin o sursă: o activitate în sistem real sau o activitate pe bază de normă de venit.',
    });
  if (activities.some(({ item }) => item.association) && activities.length + norms.length > 1)
    problems.push({
      code: 'D212_SOURCE',
      path: 'activities',
      message:
        'Membrul unei asocieri declară aici numai venitul distribuit din ea, ca singura sursă a declarației.',
    });
  for (const { item: activity, path } of activities) {
    if (activity.association) {
      amount(`${path}.association.net`, activity.association.net);
      amount(`${path}.association.loss`, activity.association.loss);
      if (activity.gross !== undefined || activity.deductible !== undefined)
        problems.push({
          code: 'D212_ASSOCIATION',
          path: `${path}.gross`,
          message:
            'Membrul unei asocieri declară venitul net sau pierderea distribuită, nu venitul brut și cheltuielile asocierii (instrucțiuni pct. 3.5.12).',
        });
      else if (activity.association.net > 0 && activity.association.loss > 0)
        problems.push({
          code: 'D212_ASSOCIATION',
          path: `${path}.association`,
          message: 'Asocierea distribuie fie un venit net, fie o pierdere.',
        });
    } else {
      amount(`${path}.gross`, activity.gross);
      amount(`${path}.deductible`, activity.deductible);
    }
    amount(`${path}.carriedLosses`, activity.carriedLosses);
    amount(`${path}.offsetLoss`, activity.offsetLoss);
  }
  for (const { item: norm, path } of norms) {
    amount(`${path}.norm`, norm.norm);
    amount(`${path}.adjusted`, norm.adjusted);
    amount(`${path}.net`, norm.net);
    amount(`${path}.tax`, norm.tax);
  }
  if (model.cas) {
    amount('cas.base', model.cas.base);
    amount('cas.due', model.cas.due);
  }
  if (model.cass) {
    amount('cass.base', model.cass.base);
    amount('cass.due', model.cass.due);
    amount('cass.minimumDifference', model.cass.minimumDifference);
  }
  if (model.cassOther)
    for (const key of ['rent', 'investment', 'base', 'due', 'withheld'] as const)
      amount(`cassOther.${key}`, model.cassOther[key]);
  amount('tax.deductibleCas', model.tax.deductibleCas);
  amount('tax.deductibleCass', model.tax.deductibleCass);
  amount('tax.due', model.tax.due);
  if (model.cassOption) {
    amount('cassOption.base', model.cassOption.base);
    amount('cassOption.due', model.cassOption.due);
  }
  return problems;
}

/** The derived rows. Throws where the year or an amount is not one the declaration takes;
 * checkD212 lists those without throwing. */
export function calculateD212(model: D212): D212Calculation {
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  const structure = d212Format(model.year)!;
  const { controls } = structure;
  const web = structure.validator === null;
  const activities = activitiesOf(model).map(({ item }) => item);
  const { net, loss, realNet, activities: per } = results(model);
  // Section 4 and the losses are the real system's: nothing of a norm is recalculated.
  const recalculations = activities.map((activity, index) =>
    Math.max(per[index]!.net - activity.offsetLoss, 0),
  );
  const recalculated = recalculations.reduce((sum, value) => sum + value, 0);
  const wages = (count: number) => controls.minimumWage * count;
  const casBand = net < wages(controls.casWages[0]) ? 0 : net < wages(controls.casWages[1]) ? 1 : 2;
  const casDue = model.cas?.due ?? 0;
  const cassDue = model.cass?.due ?? 0;

  let section4: D212Calculation['section4'] = null;
  if (activities.length && realNet > 0) {
    const decimals = web ? 4 : 5;
    // 4.1: the real system's net income within the CAS's cumulated income (art. 118 alin.
    // (2^2)), or nothing when the holder is exempt (the web form then writes 0 and no weight).
    const casTotal = model.casStatus === 'liable' ? net : 0;
    const casWeight = casTotal > 0 ? weight(realNet, casTotal, decimals) : null;
    const casDeductible = casWeight !== null && casDue > 0 ? weighted(casWeight, casDue) : null;
    // 4.2: the CASS on the income itself when the minimum's base applies (rd.5), the weight
    // applied to it, or to the CASS due.
    const cassWeight = weight(realNet, net, decimals);
    const minimumBase = wages(controls.cassWages.minimum);
    const computed =
      model.cass && (web ? net <= minimumBase : model.cass.minimumDifference > 0)
        ? percentOf(net, controls.cassPercent).value
        : null;
    const cassDeductible = model.cass ? weighted(cassWeight, computed ?? cassDue) : null;
    const rows = web
      ? { cas: casDeductible, cass: cassDeductible }
      : {
          cas: model.tax.deductibleCas || null,
          cass: model.tax.deductibleCass || null,
        };
    section4 = {
      recalculated,
      deductibleCas: rows.cas,
      deductibleCass: rows.cass,
      taxable: Math.max(recalculated - (rows.cas ?? 0) - (rows.cass ?? 0), 0),
      tax: model.tax.due,
      cas: {
        net: realNet,
        total: casTotal,
        weight: casWeight,
        due: model.casStatus === 'liable' ? casDue : null,
        deductible: casDeductible,
      },
      cass: {
        net: realNet,
        total: net,
        weight: cassWeight,
        due: cassDue,
        computed,
        deductible: cassDeductible,
      },
    };
  }
  // Section 7's tax: Section 4's and the norms' (oblimpoz_real_total sums both); the CASS of
  // Section 3.2.2 adds its difference due, and its difference withheld in excess is refunded.
  const tax = (section4?.tax ?? 0) + normsOf(model).reduce((sum, { item }) => sum + item.tax, 0);
  const otherDue = model.cassOther?.due ?? 0;
  const otherPlus = Math.max(otherDue - (model.cassOther?.withheld ?? 0), 0);
  const otherMinus = Math.max((model.cassOther?.withheld ?? 0) - otherDue, 0);
  const plus = tax + casDue + cassDue + otherPlus;
  return {
    structure,
    net,
    loss,
    recalculated,
    activities: per.map((item, index) => ({ ...item, recalculated: recalculations[index]! })),
    casBand,
    section4,
    cassOther: model.cassOther
      ? {
          total: model.cassOther.rent + model.cassOther.investment,
          band: bandOf(model.cassOther.rent + model.cassOther.investment, controls),
          plus: otherPlus,
          minus: otherMinus,
        }
      : null,
    totals: {
      tax,
      cas: casDue,
      cass: cassDue + otherPlus,
      payable: Math.max(plus - otherMinus, 0),
      refund: Math.max(otherMinus - plus, 0),
    },
    controlSum: [...model.taxpayer.cnp].reduce(
      (sum, char) => sum + (/\d/.test(char) ? Number(char) : 0),
      0,
    ),
  };
}

/** The band of Section 3.2.2 a total reaches: 0 below the first, then 1, 2, 3. */
function bandOf(total: number, controls: D212Controls) {
  const bands = controls.cassOtherWages ?? [];
  let band = 0;
  bands.forEach((count, index) => {
    if (total >= controls.minimumWage * count) band = index + 1;
  });
  return band;
}

const text = (value: number | bigint) => String(value);
const optional = (value: number | null | undefined) =>
  value === null || value === undefined || value === 0 ? undefined : String(value);
const flag = (value: boolean) => (value ? '1' : '0');
const digits = (value: string | undefined) => value?.replace(/\D/g, '') || undefined;
const iban = (value: string | undefined) => value?.replace(/\s+/g, '').toUpperCase();

/** The web form's label of the category, verbatim (trailing space included). */
const webCategoryLabel = 'Activități independente in Sistem Real ';

/** The option of Chapter II, with the dependants' total the validator requires (none here). */
const optionElement = (option: NonNullable<D212['cassOption']>) =>
  element('oblig_estimat', {
    bifa_optiune: '1',
    situatie_optiune: option.situation,
    baza_optiune: text(option.base),
    cass_optiune: text(option.due),
    totalCassDatorat: text(option.due),
    totalCassDatoratCoasigurat: '0',
  });

/** The structure D212_A1.0.3 (an_r 2025), attributes in the XSD's order. */
function write2025(model: D212, calc: D212Calculation): XmlNode {
  const { taxpayer, cas, cass } = model;
  const activities = activitiesOf(model).map(({ item }) => item);
  const norms = normsOf(model).map(({ item }) => item);
  const { section4 } = calc;
  const rectifies = model.rectifies ?? { income: false, option: false };
  const name = [taxpayer.lastName, taxpayer.initial, taxpayer.firstName].filter(Boolean).join(' ');
  const obligations = element('oblig_realizat', {
    ...(cas
      ? {
          bifa_cas_real: text(calc.casBand),
          cas_total_ven: text(calc.net),
          cas_baza: text(cas.base),
          cas_datorat: text(cas.due),
          cas_dif_plus: text(cas.due),
        }
      : {}),
    ...(cass
      ? {
          bifa_cass_datorat_ai: '1',
          bifa_cass_datorat_dpi: '0',
          cass_total_ven_ai: text(calc.net),
          baza_cass_datorat_ai: text(cass.base),
          cass_datorat_ai: text(cass.due),
          cass_dif_plus_ai: text(cass.due),
        }
      : {}),
    ...(section4
      ? {
          real_venit_net_recalculat_ai: text(section4.recalculated),
          'real_cas-deduc_ai': optional(section4.deductibleCas),
          'real_cass-deductibil_ai': optional(section4.deductibleCass),
          real_venit_net_impozabil_ai: text(section4.taxable),
          real_impozit_datorat_ai: text(section4.tax),
          ...(cas && section4.cas.weight !== null
            ? {
                real_cas_venit_net_ai: text(section4.cas.net),
                real_cas_total_ven_ai: text(section4.cas.total),
                real_cas_pondere_ai: weightText(section4.cas.weight),
                real_cas_datorata_ai: text(cas.due),
                real_cas_deductibila_ai: optional(section4.cas.deductible),
              }
            : {}),
          ...(cass
            ? {
                real_cass_venit_net_ai: text(section4.cass.net),
                real_cass_total_ven_ai: text(section4.cass.total),
                real_cass_pondere_ai: weightText(section4.cass.weight),
                real_cass_datorata_ai: text(cass.due),
                real_cass_calculata_ai: optional(section4.cass.computed),
                real_cass_deductibila_ai: optional(section4.cass.deductible),
              }
            : {}),
        }
      : {}),
    oblimpoz_real_total: text(calc.totals.tax),
    oblimpoz_real_dif_deplata: optional(calc.totals.tax),
    oblcas_real_difPlus: optional(calc.totals.cas),
    oblcass_real_difPlus_ai: optional(calc.totals.cass),
    impozit_venit_plus: optional(calc.totals.tax),
    cas_plus: optional(calc.totals.cas),
    cass_plus: optional(calc.totals.cass),
    dif_de_plata: text(calc.totals.payable),
  });
  return element(
    'd212',
    {
      xmlns: namespace,
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': `${namespace} D212.xsd`,
      d_rec: flag(rectifies.income || rectifies.option),
      rectif1: flag(rectifies.income),
      rectif2: flag(rectifies.option),
      totalPlata_A: text(calc.controlSum),
      luna_r: '12',
      an_r: text(calc.structure.anR),
      bifa_succesor: '0',
      anulare_litA: '0',
      anulare_litB: '0',
      bifa_conformare: '0',
      bifa111: flag(activities.length > 0),
      bifa112: flag(norms.length > 0),
      bifa113: '0',
      bifa121: '0',
      bifa122: '0',
      bifa131: flag(cas !== null),
      bifa132: flag(cass !== null),
      bifa14: flag(section4 !== null),
      bifa15: '0',
      bifa18: '0',
      nume_c: name,
      adresa_c: taxpayer.address,
      telefon_c: digits(taxpayer.phone),
      email_c: taxpayer.email,
      cif: taxpayer.cnp,
      nerezident: '0',
      cont_bancar: iban(taxpayer.iban),
    },
    obligations,
    model.cassOption && optionElement(model.cassOption),
    ...activities.map((activity, index) => {
      const own = calc.activities[index]!;
      return element('cap11', {
        scutire: '0',
        reg: '0',
        categ_venit: '1016',
        det_ven_net: '1',
        forma_org: activity.association ? '2' : '1',
        mod_forma_org: '0',
        caen: activity.caen,
        descriere_sediu_bun: activity.seat,
        // "Nr. document autorizare/ Contract de asociere": a member writes the contract.
        nr_doc_autoriz: activity.association?.number ?? activity.authorization.number,
        data_doc_autoriz: formDate(activity.association?.date ?? activity.authorization.date),
        data_incep: activity.startedOn && formDate(activity.startedOn),
        data_sf: activity.endedOn && formDate(activity.endedOn),
        venit_brut: activity.gross?.toString(),
        chelt_deduc: activity.deductible?.toString(),
        venit_net_anual: own.net > 0 ? text(own.net) : undefined,
        pierdere: optional(own.loss),
        pierdere_precedenta: optional(activity.carriedLosses),
        pierdere_compensata: own.net > 0 ? optional(activity.offsetLoss) : undefined,
        venit_recalculat: own.net > 0 ? text(own.recalculated) : undefined,
        // Rd.9 holds zero after a loss or a zero net income; otherwise the tax is in Section 4.
        impozit11: own.net > 0 ? undefined : '0',
      });
    }),
    ...norms.map((norm) =>
      element('cap12', {
        norma_forma_org: norm.association ? '2' : '1',
        norma_caen: norm.caen,
        norma_descriere_sediu_bun: norm.seat,
        norma_nr_doc_autoriz: norm.authorization.number,
        norma_data_doc_autoriz: formDate(norm.authorization.date),
        norma_data_incep: norm.startedOn && formDate(norm.startedOn),
        norma_data_sf: norm.endedOn && formDate(norm.endedOn),
        norma_data_susp: norm.suspendedOn && formDate(norm.suspendedOn),
        real_norma_venit: text(norm.norm),
        real_ajustare: text(norm.adjusted),
        real_venit_net_anual: text(norm.net),
        real_venit_impozit: text(norm.net),
        real_impozit: text(norm.tax),
      }),
    ),
  );
}

/** The web form's XML for an_r 2026, attributes in the order its writer emits them, with the
 * zeros it writes. */
function write2026(model: D212, calc: D212Calculation): XmlNode {
  const { taxpayer, cas, cass } = model;
  const activities = activitiesOf(model).map(({ item }) => item);
  const norms = normsOf(model).map(({ item }) => item);
  const { section4 } = calc;
  // Section 3.2.2 (nn()): written from the first band; below it the form clears the block.
  const other =
    model.cassOther && calc.cassOther && calc.cassOther.band > 0 ? model.cassOther : null;
  const rectifies = model.rectifies ?? { income: false, option: false };
  const casBlock = cas !== null;
  const obligations = element('oblig_realizat', {
    ...(casBlock
      ? {
          cas_total_ven: text(calc.net),
          cas_baza: text(cas.base),
          cas_datorat: text(cas.due),
          cas_retinut_platitor: '0',
          cas_dif_plus: text(cas.due),
          bifa_cas_real: text(calc.casBand),
          bifa_cas_recalculat: '0',
          bifa_cas_sub_plafon: flag(calc.casBand === 0),
        }
      : {}),
    // The form computes 2.1 whenever there is an independent activity: zeros after a loss.
    cass_total_ven_ai: text(calc.net),
    baza_cass_datorat_ai: text(cass?.base ?? 0),
    cass_anuala_ai: text(cass?.due ?? 0),
    cass_datorat_art180_ai: '0',
    cass_datorat_ai: text(cass?.due ?? 0),
    cass_retinut_platitor_alin6_ai: '0',
    cass_dif_plus_ai: text(cass?.due ?? 0),
    cass_dif_minus6_ai: '0',
    ...(other
      ? {
          cass_ven_dpi: '0',
          cass_ven_asc: '0',
          cass_ven_cfb: text(other.rent),
          cass_ven_inv: text(other.investment),
          cass_ven_asp: '0',
          cass_ven_alt: '0',
          cass_total_ven: text(calc.cassOther!.total),
          cass_baza: text(other.base),
          cass_anuala: text(other.due),
          cass_datorat_art180: '0',
          cass_datorat: text(other.due),
          cass_retinut: text(other.withheld),
          cass_dif_plus: text(calc.cassOther!.plus),
          cass_dif_minus: text(calc.cassOther!.minus),
          bifa_cass_real: text(calc.cassOther!.band),
        }
      : {}),
    bifa_cass_datorat_dpi: flag(other !== null),
    bifa_cass_datorat_ai: flag(calc.net > 0),
    ...(section4
      ? {
          real_venit_net_recalculat_ai: text(section4.recalculated),
          'real_cas-deduc_ai': section4.deductibleCas?.toString(),
          'real_cass-deductibil_ai': section4.deductibleCass?.toString(),
          real_venit_net_impozabil_ai: text(section4.taxable),
          real_impozit_datorat_ai: text(section4.tax),
          real_cas_venit_net_ai: text(section4.cas.net),
          real_cas_total_ven_ai: text(section4.cas.total),
          real_cas_pondere_ai:
            section4.cas.weight === null ? undefined : weightText(section4.cas.weight),
          real_cas_datorata_ai: section4.cas.due === null ? undefined : text(section4.cas.due),
          real_cas_deductibila_ai: section4.cas.deductible?.toString(),
          real_cass_venit_net_ai: text(section4.cass.net),
          real_cass_total_ven_ai: text(section4.cass.total),
          real_cass_pondere_ai: weightText(section4.cass.weight),
          real_cass_datorata_ai: text(section4.cass.due),
          real_cass_calculata_ai: section4.cass.computed?.toString(),
          real_cass_deductibila_ai: section4.cass.deductible?.toString(),
        }
      : {}),
    oblimpoz_real_total: text(calc.totals.tax),
    oblimpoz_real_dif_deplata: text(calc.totals.tax),
    oblimpoz_real_dif_restituit: '0',
    oblcas_real_difPlus: text(calc.totals.cas),
    oblcas_real_str: '0',
    oblcass_real_difPlus_ai: text(cass?.due ?? 0),
    oblcass_real_difMinus_ai: '0',
    ...(other
      ? {
          oblcass_real_difMinus_174: text(calc.cassOther!.minus),
          oblcass_real_difPlus_dpi: text(calc.cassOther!.plus),
          oblcass_real_difMinus_dpi: text(calc.cassOther!.minus),
        }
      : {}),
    oblcass_real_str: '0',
    oblcass_real_str_pensie: '0',
    impozit_venit_plus: text(calc.totals.tax),
    impozit_venit_minus: '0',
    cas_plus: text(calc.totals.cas),
    cass_plus: text(calc.totals.cass),
    cass_minus: text(calc.cassOther?.minus ?? 0),
    dif_de_plata: text(calc.totals.payable),
    dif_de_restituit: text(calc.totals.refund),
  });
  // The form's status list: 2 a pensioner, 5 insured in an own system (both hide CAS).
  const statut =
    model.casStatus === 'pensioner' ? '2' : model.casStatus === 'own_system' ? '5' : undefined;
  return element(
    'd212',
    {
      an_r: text(calc.structure.anR),
      luna_r: '12',
      d_rec: flag(rectifies.income || rectifies.option),
      rectif1: flag(rectifies.income),
      rectif2: flag(rectifies.option),
      totalPlata_A: text(calc.controlSum),
      bifa_conformare: '0',
      bifa18: '0',
      bifa19: '0',
      bifa23: '0',
      anulare_litA: '0',
      anulare_litB: '0',
      bifa111: flag(activities.length > 0),
      bifa112: flag(norms.length > 0),
      bifa14: flag(activities.length > 0),
      bifa113: '0',
      bifa121: '0',
      bifa15: '0',
      bifa122: '0',
      bifa131: flag(casBlock),
      // The 2.1 rows are written, zeros included, so the form ticks CASS.
      bifa132: '1',
      nume_c: taxpayer.lastName,
      initiala_c: taxpayer.initial?.trim().toUpperCase().slice(0, 2),
      prenume_c: taxpayer.firstName,
      cif: taxpayer.cnp,
      cont_bancar: iban(taxpayer.iban),
      adresa_c: taxpayer.address,
      telefon_c: digits(taxpayer.phone),
      email_c: taxpayer.email,
      nerezident: '0',
      statut,
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': namespace,
      xmlns: namespace,
    },
    obligations,
    model.cassOption && optionElement(model.cassOption),
    ...activities.map((activity, index) => {
      const own = calc.activities[index]!;
      return element('cap11', {
        categ_venit: '1016',
        den_venit: webCategoryLabel,
        det_ven_net: '1',
        forma_org: activity.association ? '2' : '1',
        caen: activity.caen,
        descriere_sediu_bun: activity.seat,
        nr_doc_autoriz: activity.authorization.number,
        data_doc_autoriz: formDate(activity.authorization.date),
        nr_doc_asociere: activity.association?.number,
        data_doc_asociere: activity.association && formDate(activity.association.date),
        data_incep: activity.startedOn && formDate(activity.startedOn),
        data_sf: activity.endedOn && formDate(activity.endedOn),
        data_suspendare: activity.suspendedOn && formDate(activity.suspendedOn),
        // The form clears rd. 1 and rd. 2 for a member of an association.
        venit_brut: activity.gross?.toString(),
        chelt_deduc: activity.deductible?.toString(),
        pierdere: optional(own.loss),
        venit_net_anual: own.loss > 0 ? undefined : text(own.net),
        pierdere_precedenta: optional(activity.carriedLosses),
        pierdere_compensata: text(activity.offsetLoss),
        venit_recalculat: text(own.recalculated),
      });
    }),
    ...norms.map(normElement2026),
  );
}

/** A coefficient as the web form stores it: two decimals. */
const coefficient = (percent: string) => Number(percent).toFixed(2);

/**
 * The web form's cap12 (its writer for income 10161): the totals of Subsection 2's C, one
 * norma_loc per place with the rows 7–9.1, and one corectie per coefficient applied. The place's
 * county, locality and street are codes of ANAF's nomenclators, which the form loads from its
 * server and which are not public: they are not written (checkD212 warns).
 */
function normElement2026(norm: D212Norm): XmlNode {
  const coefficients = Boolean(norm.increase || norm.reduction);
  return element(
    'cap12',
    {
      norma_forma_org: norm.association ? '2' : '1',
      norma_nr_doc_autoriz: norm.authorization.number,
      norma_data_doc_autoriz: formDate(norm.authorization.date),
      norma_venit_impozabil: text(norm.net),
      norma_impozit: text(norm.tax),
    },
    element(
      'norma_loc',
      {
        norma_isPGL: '0',
        norma_caen: norm.caen,
        norma_data_incep: norm.startedOn && formDate(norm.startedOn),
        norma_data_sf: norm.endedOn && formDate(norm.endedOn),
        norma_zile_intrerupere: optional(norm.interruptedDays),
        real_norma_venit: text(norm.norm),
        // The form writes 0 for rd. 8 when no coefficient applies.
        real_ajustare: text(coefficients ? norm.adjusted : 0),
        real_venit_net_anual: text(norm.net),
        real_venit_impozit: text(norm.net),
      },
      norm.increase &&
        element('corectie', {
          criteriu: norm.increase.criterion,
          coeficient_majorare: coefficient(norm.increase.percent),
        }),
      norm.reduction &&
        element('corectie', {
          criteriu: norm.reduction.criterion,
          coeficient_reducere: coefficient(norm.reduction.percent),
        }),
    ),
  );
}

/**
 * Writes the declaration for its income year's structure: `d212` with `oblig_realizat`, the
 * option of Chapter II when given, and one `cap11`. Throws where checkD212 finds an error: a
 * return that disagrees with its structure's controls is not written.
 */
export function writeD212(model: D212): string {
  const [error] = checkD212(model).filter((check) => check.severity === 'error');
  if (error) throw new DomainError(error.code, error.message);
  const calc = calculateD212(model);
  return serializeXml(
    calc.structure.validator === null ? write2026(model, calc) : write2025(model, calc),
  );
}

const nameCharacters = /^[\p{L}][\p{L}\- ]*$/u;
// adresa_c: "Doar literele alfabetului latin (A-Z, a-z), cifrele arabe (0-9), semnul virgula (,),
// semnul punct (.), semnul minus (-) si spatii".
const addressCharacters = /^[A-Za-z0-9,.\- ]*$/;
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * The structure's controls for the case written, in Romanian: the identification, the activity's
 * dates and amounts, the CAS and CASS bands, bases and rates, Section 4 and the option, against
 * the constants the structure states. A rounding that differs only because the structure rounds
 * half a leu up and the Code's art. 66 drops it is a warning for the expert contabil; any other
 * disagreement is an error. The cases not written are errors.
 */
export function checkD212(model: D212): D212Check[] {
  const checks: D212Check[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  const warning = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'warning', path, message });
  const structure = d212Format(model.year);
  const web = structure?.validator === null;
  const { taxpayer } = model;

  // Identification. The CNP is never repeated in a message.
  if (!isValidCnp(taxpayer.cnp))
    error('D212_CNP', 'taxpayer.cnp', 'CNP-ul titularului nu este valid.');
  const name = (path: string, value: string | undefined, label: string, required: boolean) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D212_NAME', path, `Completați ${label}.`);
    } else if (!nameCharacters.test(trimmed))
      error('D212_NAME', path, `În ${label} se scriu doar litere, spații și cratima.`);
  };
  name('taxpayer.lastName', taxpayer.lastName, 'numele titularului', true);
  name('taxpayer.firstName', taxpayer.firstName, 'prenumele titularului', true);
  name('taxpayer.initial', taxpayer.initial, 'inițiala tatălui', false);
  if (
    [taxpayer.lastName, taxpayer.initial, taxpayer.firstName].filter(Boolean).join(' ').length > 250
  )
    error('D212_NAME', 'taxpayer', 'Numele, inițiala și prenumele au cel mult 250 de caractere.');
  const address = taxpayer.address?.trim();
  if (!address) error('D212_ADDRESS', 'taxpayer.address', 'Completați adresa domiciliului fiscal.');
  else if (address.length > 200)
    error('D212_ADDRESS', 'taxpayer.address', 'Adresa are cel mult 200 de caractere.');
  else if (!web && !addressCharacters.test(address))
    warning(
      'D212_ADDRESS',
      'taxpayer.address',
      'Structura D212 admite în adresă doar litere fără diacritice, cifre, virgula, punctul, cratima și spațiul; validatorul ANAF o acceptă totuși.',
    );
  if (taxpayer.phone && !/^\d{6,15}$/.test(taxpayer.phone.replace(/[\s.\-+()]/g, '')))
    warning('D212_PHONE', 'taxpayer.phone', 'Telefonul are doar cifre, cel mult 15.');
  if (taxpayer.email && (!isEmail(taxpayer.email) || taxpayer.email.length > 200))
    warning('D212_EMAIL', 'taxpayer.email', 'E-mailul nu este valid.');
  if (taxpayer.iban !== undefined && !isValidIban(taxpayer.iban))
    error('D212_IBAN', 'taxpayer.iban', 'Contul bancar (IBAN) nu este valid.');
  else if (taxpayer.iban && iban(taxpayer.iban)!.length > 24)
    error('D212_IBAN', 'taxpayer.iban', 'Contul bancar (IBAN) are cel mult 24 de caractere.');

  // The year and the amounts; nothing below is checked without them.
  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);
  if (problems.length || !structure) return checks;
  const { controls } = structure;
  const yearStart = `${model.year}-01-01`;
  const yearEnd = `${model.year}-12-31`;

  // The sources: each activity's and norm's place, authorization and dates.
  const sources = [
    ...activitiesOf(model).map((entry) => ({ ...entry, kind: 'activity' as const })),
    ...normsOf(model).map((entry) => ({ ...entry, kind: 'norm' as const })),
  ];
  for (const { item: source, path: at, kind } of sources) {
    if (!/^\d{4}$/.test(source.caen))
      error('D212_CAEN', `${at}.caen`, 'Codul CAEN are patru cifre.');
    if (kind === 'activity' || !web) {
      if (!source.seat?.trim()) error('D212_SEAT', `${at}.seat`, 'Completați sediul activității.');
      else if (source.seat.trim().length > (web ? 200 : 250))
        error('D212_SEAT', `${at}.seat`, `Sediul are cel mult ${web ? 200 : 250} de caractere.`);
    }
    const authorization = source.authorization?.number?.trim();
    if (!authorization)
      error('D212_AUTHORIZATION', `${at}.authorization`, 'Completați documentul de autorizare.');
    else if (authorization.length > (web ? 120 : 15))
      error(
        'D212_AUTHORIZATION',
        `${at}.authorization.number`,
        `Numărul documentului de autorizare are cel mult ${web ? 120 : 15} caractere în această structură.`,
      );
    if (!isDate(source.authorization?.date) || source.authorization.date > yearEnd)
      error(
        'D212_AUTHORIZATION',
        `${at}.authorization.date`,
        `Data documentului de autorizare este o dată de până la ${formDate(yearEnd)}.`,
      );
    for (const key of ['startedOn', 'endedOn', 'suspendedOn'] as const) {
      const value = source[key];
      if (value === undefined) continue;
      if (!isDate(value) || value < yearStart || value > yearEnd)
        error(
          'D212_DATE',
          `${at}.${key}`,
          `Datele începerii, încetării și suspendării se completează numai pentru evenimente din ${model.year}.`,
        );
    }
    if (source.startedOn && source.endedOn && source.startedOn > source.endedOn)
      error('D212_DATE', `${at}.endedOn`, 'Activitatea încetează după ce începe.');
    if (kind === 'activity' && source.suspendedOn && !web)
      warning(
        'D212_SUSPENSION',
        `${at}.suspendedOn`,
        'Structura D212_A1.0.3 nu are data suspendării activității; ea nu apare în declarație.',
      );
    if (kind === 'norm' && source.suspendedOn && web)
      warning(
        'D212_SUSPENSION',
        `${at}.suspendedOn`,
        'Formularul web are pentru normă numai zilele de întrerupere (norma_zile_intrerupere), nu data suspendării.',
      );
  }

  // A member of an association: the contract as registered with the fiscal body (rd. 7).
  for (const { item: activity, path } of activitiesOf(model)) {
    const association = activity.association;
    if (!association) continue;
    if (!association.number?.trim())
      error(
        'D212_ASSOCIATION',
        `${path}.association.number`,
        'Completați numărul contractului de asociere înregistrat la organul fiscal.',
      );
    else if (association.number.trim().length > (web ? 50 : 15))
      error(
        'D212_ASSOCIATION',
        `${path}.association.number`,
        `Numărul contractului de asociere are cel mult ${web ? 50 : 15} caractere în această structură.`,
      );
    if (!isDate(association.date) || association.date > yearEnd)
      error(
        'D212_ASSOCIATION',
        `${path}.association.date`,
        `Data contractului de asociere este o dată de până la ${formDate(yearEnd)}.`,
      );
  }

  const { net, loss, activities: per } = results(model);
  const wages = (count: number) => controls.minimumWage * count;
  const rounded = (
    code: string,
    path: string,
    given: number,
    expected: { value: number; half: boolean },
    label: string,
  ) => {
    if (given === expected.value) return;
    if (expected.half && given === expected.value - 1)
      warning(
        'D212_ROUNDING',
        path,
        `${label}: ${given} lei, după rotunjirea Codului fiscal (art. 66: până la 50 de bani se neglijează); formularul rotunjește 50 de bani în sus (${expected.value} lei). De confirmat cu expertul contabil.`,
      );
    else error(code, path, `${label}: ${given} lei, iar structura dă ${expected.value} lei.`);
  };

  // Losses: rd.6 is the smaller of the carried losses and 70% of the source's net income.
  activitiesOf(model).forEach(({ item: activity, path }, index) => {
    const own = per[index]!.net;
    if (activity.offsetLoss > activity.carriedLosses)
      error(
        'D212_LOSS',
        `${path}.offsetLoss`,
        'Pierderea compensată depășește pierderile reportate.',
      );
    else if (own === 0 && activity.offsetLoss > 0)
      error('D212_LOSS', `${path}.offsetLoss`, 'Pierderea se compensează numai cu un venit net.');
    else if (own > 0 && activity.carriedLosses > 0) {
      const cap = percentOf(own, controls.lossPercent);
      if (activity.offsetLoss !== Math.min(activity.carriedLosses, cap.value))
        rounded(
          'D212_LOSS',
          `${path}.offsetLoss`,
          activity.offsetLoss,
          activity.carriedLosses < cap.value ? { value: activity.carriedLosses, half: false } : cap,
          `Pierderea compensată (cel mult ${controls.lossPercent}% din venitul net al sursei)`,
        );
    }
  });

  // The norm (Subsection 2): rd. 8 from the coefficients, rd. 9 from the days of activity, the
  // tax at 10%. An amount one leu off is a rounding for the expert; more is an error.
  for (const { item: norm, path } of normsOf(model)) {
    // D212_A1.0.3 has Subsection 2 only for an activity started in December 2024 (its rules on
    // norma_data_incep); the others' norm tax for 2024 was set in the declaration filed in 2024.
    if (!web && !(norm.startedOn && norm.startedOn >= `${model.year}-12-01`))
      error(
        'D212_NORMA_START',
        `${path}.startedOn`,
        `În structura D212_A1.0.3, subsecțiunea normelor de venit se completează numai pentru activitatea începută în decembrie ${model.year}.`,
      );
    if (web)
      warning(
        'D212_NORMA_PLACE',
        `${path}.seat`,
        'Locul activității pe bază de normă (județ, localitate, stradă) se alege în formular din nomenclatoarele ANAF, ale căror coduri nu sunt publice: nu este scris în XML.',
      );
    const coefficients: [string, typeof norm.increase][] = [
      ['increase', norm.increase],
      ['reduction', norm.reduction],
    ];
    for (const [key, item] of coefficients) {
      if (!item) continue;
      if (!/^(0|[1-9]\d?)(\.\d{1,2})?$/.test(item.percent) || Number(item.percent) === 0)
        error(
          'D212_NORMA',
          `${path}.${key}.percent`,
          'Coeficientul de corecție este un procent între 0,01 și 99,99.',
        );
      if (!(normCriteria as readonly string[]).includes(item.criterion))
        error(
          'D212_NORMA',
          `${path}.${key}.criterion`,
          'Criteriul coeficientului este unul din 01–13.',
        );
    }
    const near = (path: string, given: number, expected: number, label: string) => {
      if (given === expected) return;
      if (Math.abs(given - expected) === 1)
        warning(
          'D212_ROUNDING',
          path,
          `${label}: ${given} lei față de ${expected} lei calculați de formular: diferență de rotunjire, de confirmat cu expertul contabil.`,
        );
      else error('D212_NORMA', path, `${label}: ${given} lei, iar calculul dă ${expected} lei.`);
    };
    if (!checks.some((check) => check.severity === 'error' && check.path.startsWith(path))) {
      const bp = (percent: string | undefined) => BigInt(Math.round(Number(percent ?? 0) * 100));
      const product = BigInt(norm.norm) * (10_000n + bp(norm.increase?.percent));
      const exact = product * (10_000n - bp(norm.reduction?.percent));
      near(
        `${path}.adjusted`,
        norm.adjusted,
        Number((exact * 2n + 100_000_000n) / 200_000_000n),
        'Norma ajustată (rd. 8)',
      );
      const days = norm.activeDays ?? 365;
      if (norm.activeDays !== undefined && (norm.activeDays < 0 || norm.activeDays > 366))
        error('D212_NORMA', `${path}.activeDays`, 'Zilele de activitate sunt între 0 și 366.');
      else
        near(
          `${path}.net`,
          norm.net,
          norm.activeDays === undefined
            ? norm.adjusted
            : Number((BigInt(norm.adjusted) * BigInt(days) * 2n + 365n) / 730n),
          `Venitul net anual (rd. 9, ${days} de zile din 365)`,
        );
      rounded(
        'D212_NORMA',
        `${path}.tax`,
        norm.tax,
        percentOf(norm.net, controls.taxPercent),
        `Impozitul pe normă (${controls.taxPercent}% din rd. 9.1)`,
      );
    }
  }
  if (
    !activitiesOf(model).length &&
    (model.tax.due !== 0 || model.tax.deductibleCas !== 0 || model.tax.deductibleCass !== 0)
  )
    error(
      'D212_SECTION4',
      'tax',
      'Secțiunea 4 (sistemul real) nu se completează pentru venitul pe bază de normă.',
    );

  // CAS (Section 3.1).
  const band = net < wages(controls.casWages[0]) ? 0 : net < wages(controls.casWages[1]) ? 1 : 2;
  if (model.cas) {
    if (model.casStatus !== 'liable')
      error(
        'D212_CAS',
        'cas',
        'Titularul pensionar sau asigurat în sistem propriu nu datorează CAS (art. 150).',
      );
    if (band === 0 && !web)
      error(
        'D212_CAS_OPTION',
        'cas',
        'Opțiunea pentru CAS sub plafonul de 12 salarii minime nu are rubrică în structura D212_A1.0.3.',
      );
    const least = wages(controls.casWages[band === 2 ? 1 : 0]);
    if (model.cas.base < least)
      error(
        'D212_CAS',
        'cas.base',
        `Baza CAS este cel puțin ${least} lei (${band === 2 ? controls.casWages[1] : controls.casWages[0]} salarii minime).`,
      );
    rounded(
      'D212_CAS',
      'cas.due',
      model.cas.due,
      percentOf(model.cas.base, controls.casPercent),
      `CAS datorată (${controls.casPercent}% din bază)`,
    );
  } else if (model.casStatus === 'liable' && band > 0)
    error(
      'D212_CAS',
      'cas',
      `Venitul net de ${net} lei atinge plafonul CAS de ${wages(controls.casWages[0])} lei: CAS este datorată.`,
    );

  // CASS (Section 3.2.1): the net income, at least the minimum unless an exception applies, at
  // most the cap; nothing on a loss or a zero income.
  const cap = wages(controls.cassWages.maximum);
  const minimum = wages(controls.cassWages.minimum);
  if (model.cass) {
    if (net === 0)
      error(
        'D212_CASS',
        'cass',
        'Pe o pierdere sau un venit net zero nu se datorează CASS (art. 174 alin. (2)).',
      );
    const base = model.cassException ? Math.min(net, cap) : Math.max(minimum, Math.min(net, cap));
    if (model.cass.base !== base)
      error(
        'D212_CASS',
        'cass.base',
        `Baza CASS este ${base} lei: venitul net, între ${model.cassException ? 0 : minimum} și ${cap} lei.`,
      );
    rounded(
      'D212_CASS',
      'cass.due',
      model.cass.due,
      percentOf(model.cass.base, controls.cassPercent),
      `CASS datorată (${controls.cassPercent}% din bază)`,
    );
    const own = percentOf(Math.min(net, cap), controls.cassPercent);
    const difference = model.cass.base > net ? model.cass.due - own.value : 0;
    if (Math.abs(model.cass.minimumDifference - difference) > (own.half ? 1 : 0))
      error(
        'D212_CASS',
        'cass.minimumDifference',
        `Diferența până la CASS minimă este ${difference} lei.`,
      );
  } else if (net > 0) error('D212_CASS', 'cass', `Pe venitul net de ${net} lei se datorează CASS.`);

  // Section 4: the register's deductions and tax against the structure's rows.
  if (!checks.some((check) => check.severity === 'error')) {
    const calc = calculateD212(model);
    const section4 = calc.section4;
    if (section4) {
      // The register deducts each contribution in proportion and caps them at the recalculated
      // income; the form weighs them to 4 or 5 decimals and floors the result at zero.
      const registered = Math.max(
        calc.recalculated - model.tax.deductibleCas - model.tax.deductibleCass,
        0,
      );
      const weighed = Math.max(
        calc.recalculated - (section4.cas.deductible ?? 0) - (section4.cass.deductible ?? 0),
        0,
      );
      if (Math.abs(registered - weighed) > 1)
        error(
          'D212_SECTION4',
          'tax',
          `Venitul net impozabil al registrului (${registered} lei) diferă de cel dat de ponderile formularului (${weighed} lei).`,
        );
      else if (registered !== weighed)
        warning(
          'D212_ROUNDING',
          'tax',
          `Venitul net impozabil al registrului (${registered} lei) diferă cu un leu de cel dat de ponderile formularului (${weighed} lei), din rotunjirea contribuțiilor deductibile.`,
        );
      rounded(
        'D212_SECTION4',
        'tax.due',
        model.tax.due,
        percentOf(section4.taxable, controls.taxPercent),
        `Impozitul (${controls.taxPercent}% din venitul net impozabil)`,
      );
    } else if (model.tax.due !== 0)
      error('D212_SECTION4', 'tax.due', 'Fără venit net nu se datorează impozit.');
    if (Object.values(calc.totals).some((value) => value > maxAmount))
      error('D212_TOTAL', 'tax', 'Un total al declarației depășește 15 cifre.');
  }

  // Section 3.2.2: the CASS on the income declared from outside the books, by the structure's
  // bands (6, 12, 24 minimum wages; art. 170 alin. (3)).
  const other = model.cassOther;
  if (other) {
    if (!controls.cassOtherWages)
      error(
        'D212_DECLARED',
        'cassOther',
        'Secțiunea 3.2.2 (CASS pe veniturile din afara activității) nu este scrisă de aplicație în această structură.',
      );
    else {
      const total = other.rent + other.investment;
      const band = bandOf(total, controls);
      const base = band ? wages(controls.cassOtherWages[band - 1]!) : 0;
      if (other.base !== base)
        error(
          'D212_CASS_OTHER',
          'cassOther.base',
          `Baza CASS pentru veniturile de ${total} lei este ${base} lei (${band ? `${controls.cassOtherWages[band - 1]} salarii minime` : 'sub pragul de 6 salarii minime'}).`,
        );
      else if (base > 0)
        rounded(
          'D212_CASS_OTHER',
          'cassOther.due',
          other.due,
          percentOf(base, controls.cassPercent),
          `CASS pe veniturile declarate (${controls.cassPercent}% din bază)`,
        );
      else if (other.due !== 0)
        error(
          'D212_CASS_OTHER',
          'cassOther.due',
          'Sub pragul de 6 salarii minime nu se datorează CASS.',
        );
    }
  }

  // Chapter II.
  const option = model.cassOption;
  if (option) {
    if (option.situation === 'B' ? loss === 0 : net !== 0 || loss !== 0)
      error(
        'D212_CASS_OPTION',
        'cassOption.situation',
        option.situation === 'B'
          ? 'Situația B cere o pierdere fiscală în anul declarat.'
          : 'Situația C cere un venit net anual zero în anul declarat.',
      );
    if (option.base !== controls.option.base || option.due !== controls.option.due)
      error(
        'D212_CASS_OPTION',
        'cassOption',
        `Baza CASS a opțiunii este ${controls.option.base} lei și contribuția ${controls.option.due} lei în această structură.`,
      );
  }
  if (model.rectifies?.option && !option)
    error(
      'D212_RECTIFICATION',
      'rectifies',
      'Rectificarea capitolului II cere opțiunea pentru CASS.',
    );
  return checks;
}
