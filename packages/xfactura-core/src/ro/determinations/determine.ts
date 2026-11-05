import type { JsonValue, ProfileFact } from '../../kernel';
import { hashOf } from '../../hash';
import { divRound, parseScaled } from '../../money';
import type { MicroConditionsAnswer, QuestionRequest } from '../../questions/kinds';
import { RuleGapError, type DateAxis, type RuleContext } from '../../rules';
import { addDays, addMonthsToDate, daysBetween, type LocalDate } from '../../time';
import { individualForms, type EntityForm } from '../entity';
import {
  determineVatDistance,
  determineVatIoss,
  determineVatOss,
  distanceWatch,
  type DistanceSale,
} from '../oss/determine';
import { determineIntrastat, intrastatWatches, type IntrastatMonth } from '../trade/intrastat';
import type {
  MicroEmployee,
  MicroLinked,
  PayrollQuarterly,
  SizeCriteria,
  SizeThresholds,
} from './parameters';

/*
 * The yearly determinations: which regime a company is in for a year, computed from its books,
 * its recorded facts and the answers its owner gave, under cited rules. Each is a proposal of a
 * dated profile fact that a person confirms (`determination.confirm`), with the computation shown;
 * an input nobody knows is a question (NEEDS_EVIDENCE), a case the engine does not cover is
 * UNSUPPORTED, a missing rule is RULE_GAP. Nothing is defaulted.
 */

/** The axes the engine determines each year. */
export const determinationAxes = [
  'income_tax',
  'vat.period',
  'payroll.period',
  'size.category',
  'vat.threshold',
  'vat.cash',
  'vat.status',
  'vat.eu',
  // Sales to consumers in other Member States (core ro/oss): the place of supply (art. 278^1),
  // the Union scheme (art. 315) and the import scheme (art. 315^2).
  'vat.distance',
  'vat.oss',
  'vat.ioss',
  // Intrastat (core ro/trade, INS): whether the company is a data provider, by flow.
  'intrastat.arrivals',
  'intrastat.dispatches',
] as const;
export type DeterminationAxis = (typeof determinationAxes)[number];

/** The axes whose fact must be recorded for each year (the law decides them yearly). */
export const yearlyAxes: readonly DeterminationAxis[] = [
  'income_tax',
  'vat.period',
  'payroll.period',
  'size.category',
];

/** A value the books, an answer or a recorded fact give; or why it is unknown, with what to ask. */
export type Known<T> =
  | { known: true; value: T; source: 'books' | 'answer' | 'fact'; ref: string | null }
  | { known: false; reason: string; question: QuestionRequest | null };

export interface FxQuote {
  rate: string;
  multiplier: number;
  /** The BNR publication date. */
  date: string;
}

/** A year's figures, from the books when the engine keeps the year, else from the answers. */
export interface YearFigures {
  year: number;
  /** Whether the engine keeps the year's books from 1 January. */
  kept: boolean;
  /** 70x net of 709: the turnover the micro-enterprise limit is checked on (art. 54 alin. (1)). */
  turnover: Known<bigint>;
  /** F20 rd. 01 (70x − 709 + 7411): the net turnover of the size criteria. */
  netTurnover: Known<bigint>;
  /** Class 7: the total revenues of art. 147 alin. (7). */
  totalRevenue: Known<bigint>;
  /** Taxable, exempt with deduction and abroad with deduction (art. 322 alin. (2), art. 282). */
  vatTurnover: Known<bigint>;
  /** Supplies with the place in Romania (art. 310 alin. (2)): revenue on 70x, net of 709, less
   * the supplies abroad; fixed and intangible assets (7583) are not in it. */
  exemptionTurnover: Known<bigint>;
  /** Total assets at the year's end: balance sheet A–C (OMFP nr. 1.802/2014 pct. 15). */
  totalAssets: Known<bigint>;
  /** The year's average number of employees over its 12 months (the size criteria). */
  averageEmployees: Known<string>;
  /** The mean over the months with a D112, i.e. with employees (art. 147 alin. (6)). */
  averageEmployeesD112: Known<string>;
  /** Whether goods were acquired from other EU states (art. 322 alin. (2)). */
  euGoodsAcquisitions: Known<boolean>;
  /** The BNR EUR rate valid at the year's close. */
  eurRate: Known<FxQuote>;
  /** Distance sales and TBE services to consumers in other Member States, without VAT (art.
   * 278^1 alin. (1) lit. b)): the D300's „Total an precedent” of the next year. */
  distanceTurnover?: Known<bigint>;
  /** Intra-Union acquisitions and supplies of goods (core ro/trade): INS's Intrastat threshold
   * of the next year reads them. */
  intrastatArrivals?: Known<bigint>;
  intrastatDispatches?: Known<bigint>;
}

/** The current year's movements, for what is checked during the year. */
export interface YearActivity {
  year: number;
  /** Whether the engine keeps the year from 1 January. */
  kept: boolean;
  /** Turnover (70x net of 709) of each quarter, not cumulative. */
  quarterTurnover: readonly [bigint, bigint, bigint, bigint];
  /** Each day's supplies in the bases of art. 310 alin. (2) and art. 282 alin. (3^1), not
   * cumulative, in date order. */
  days: readonly { date: LocalDate; exemption: bigint; vat: bigint }[];
  /** The day the company's first financial year begins, when within this year: a company set up
   * during the year (Legea nr. 82/1991 art. 27 alin. (8)), whose books hold it from its start. */
  start?: LocalDate | null;
  /** Services across the EU border, from the documents: invoices from suppliers established in
   * another member state and to customers there, by date (art. 317 alin. (1) lit. b)–c)). */
  euServices?: readonly EuService[];
  /** Distance sales and TBE services to consumers in other Member States, by tax point (core
   * ro/oss): what the threshold of art. 278^1 is cumulated over. */
  distance?: readonly DistanceSale[];
  /** Intra-Union goods by the month they moved (core ro/trade): the Intrastat thresholds. */
  intrastat?: readonly IntrastatMonth[];
}

/** An invoice for services across the EU border, as the documents show it. */
export interface EuService {
  date: LocalDate;
  documentId: string;
  number: string;
  direction: 'purchase' | 'sale';
  country: string;
}

/** An employment contract as the books record it (the latest terms). */
export interface Contract {
  employeeId: string;
  start: LocalDate;
  end: LocalDate | null;
  dailyHours: number;
}

export interface DeterminationContext {
  year: number;
  /** The recorded profile facts, superseded ones left out, in effect order. */
  facts: readonly ProfileFact[];
  previous: YearFigures;
  current: YearFigures;
  activity: YearActivity;
  contracts: readonly Contract[];
  /** The owner's answer to `micro.conditions` for the year. */
  micro: Known<MicroConditionsAnswer>;
  /** The engine's date. */
  today: LocalDate;
}

export type DeterminationStatus =
  'proposed' | 'needs_evidence' | 'unsupported' | 'rule_gap' | 'not_applicable';

export interface DeterminationChange {
  value: string;
  effectiveFrom: LocalDate;
  reason: string;
}

export interface Determination {
  axis: DeterminationAxis;
  year: number;
  status: DeterminationStatus;
  /** The value from `effectiveFrom`; null unless proposed. */
  value: string | null;
  effectiveFrom: LocalDate;
  /** Changes within the year: an exit from micro or from VAT on collection, a threshold crossed. */
  changes: DeterminationChange[];
  /** The computation, in Romanian. */
  summary: string;
  lines: string[];
  inputs: { [key: string]: JsonValue };
  clauses: string[];
  /** The parameter versions read. */
  versions: string[];
  /** What to ask when an input is unknown. */
  questions: QuestionRequest[];
  /** Other yearly determinations it depends on that are not recorded yet. */
  dependsOn: DeterminationAxis[];
  unsupported: { trigger: string; message: string; capabilities: string[] } | null;
  /** A hash of what a person confirms: the axis, year, value, changes and inputs. */
  fingerprint: string;
}

const CODE = 'ANAF/Cod-fiscal-consolidat';
const code = (clause: string) => `${CODE}:${clause}`;

/** Amounts as a Romanian reader writes them: 1.234,56. */
export function lei(bani: bigint): string {
  const negative = bani < 0n;
  const digits = (negative ? -bani : bani).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${whole},${digits.slice(-2)}`;
}
const money = (bani: bigint) =>
  `${bani < 0n ? '-' : ''}${(bani < 0n ? -bani : bani) / 100n}.${String((bani < 0n ? -bani : bani) % 100n).padStart(2, '0')}`;

/** An amount in euro, in lei at a BNR rate, in bani (half away from zero). */
export function euroInLei(euro: string, quote: FxQuote): bigint {
  return divRound(
    BigInt(euro) * 100n * parseScaled(quote.rate, 4),
    10_000n * BigInt(quote.multiplier),
    'halfAwayFromZero',
  );
}

/** The value on an axis at a date, from the facts in effect order; null when none. */
export function recordedAt(facts: readonly ProfileFact[], axis: string, date: string) {
  let value: string | null = null;
  for (const fact of facts)
    if (fact.axis === axis && fact.effectiveFrom <= date) value = fact.value;
  return value;
}

/** The value on a yearly axis at a date, from a fact effective within the year only. */
export function recordedInYear(
  facts: readonly ProfileFact[],
  axis: string,
  year: number,
  date: string = `${year}-12-31`,
) {
  let value: string | null = null;
  for (const fact of facts)
    if (fact.axis === axis && fact.effectiveFrom >= `${year}-01-01` && fact.effectiveFrom <= date)
      value = fact.value;
  return value;
}

/** A `profile.fact` question about a yearly axis, asked per year. */
export function factQuestion(axis: string, year: number): QuestionRequest {
  return {
    kind: 'profile.fact',
    subject: { kind: 'profile', id: `${axis}/${year}` },
    params: { axis, from: `${year}-01-01` },
  };
}
/** A `profile.fact` question about an axis that holds until changed, asked from a date. */
export function factQuestionFrom(axis: string, from: string): QuestionRequest {
  return { kind: 'profile.fact', subject: { kind: 'profile', id: axis }, params: { axis, from } };
}
export function figuresQuestion(year: number, figures: readonly string[]): QuestionRequest {
  return {
    kind: 'year.figures',
    subject: { kind: 'year', id: String(year) },
    params: { year, figures: [...figures] },
  };
}
export function microQuestion(year: number): QuestionRequest {
  return {
    kind: 'micro.conditions',
    subject: { kind: 'year', id: String(year) },
    params: { year },
  };
}

/** The `determination.confirm` question of a proposed determination. */
export function confirmQuestion(determination: Determination): QuestionRequest {
  return {
    kind: 'determination.confirm',
    subject: { kind: 'profile', id: `${determination.axis}/${determination.year}` },
    params: {
      axis: determination.axis,
      year: determination.year,
      value: determination.value!,
      effectiveFrom: determination.effectiveFrom,
      changes: determination.changes.map((change) => ({ ...change })),
      summary: determination.summary.slice(0, 2000),
      lines: determination.lines.slice(0, 80).map((line) => line.slice(0, 2000)),
      clauses: determination.clauses.slice(0, 40),
      fingerprint: determination.fingerprint,
    },
  };
}

const quarterStart = (year: number, quarter: number) =>
  `${year}-${String(quarter * 3 - 2).padStart(2, '0')}-01` as LocalDate;
const quarterOf = (date: string) => Math.ceil(Number(date.slice(5, 7)) / 3);

/** Full-time equivalents employed on a day, from the contracts (8 hours a day is full time). */
export function fteOn(contracts: readonly Contract[], day: string): number {
  return contracts
    .filter((contract) => contract.start <= day && (contract.end === null || contract.end >= day))
    .reduce((sum, contract) => sum + contract.dailyHours / 8, 0);
}

/** Each month's number of employees: those with a contract running at some point in the month. */
export function monthlyHeadcount(contracts: readonly Contract[], year: number): number[] {
  return Array.from({ length: 12 }, (_, index) => {
    const from = `${year}-${String(index + 1).padStart(2, '0')}-01`;
    const to = addDays(addMonthsToDate(from as LocalDate, 1), -1);
    return new Set(
      contracts
        .filter(
          (contract) => contract.start <= to && (contract.end === null || contract.end >= from),
        )
        .map((contract) => contract.employeeId),
    ).size;
  });
}

/** An average to two decimals, half away from zero. */
export function average(total: number, count: number): string {
  if (count === 0) return '0';
  const hundredths = divRound(BigInt(total) * 100n, BigInt(count), 'halfAwayFromZero');
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

/** Collects a determination's computation as it is made. */
export class Draft {
  lines: string[] = [];
  clauses = new Set<string>();
  versions = new Set<string>();
  inputs: { [key: string]: JsonValue } = {};
  questions: QuestionRequest[] = [];
  dependsOn: DeterminationAxis[] = [];
  changes: DeterminationChange[] = [];

  constructor(
    readonly axis: DeterminationAxis,
    readonly year: number,
    readonly rules: RuleContext,
  ) {}

  cite(...clauses: string[]) {
    for (const clause of clauses) this.clauses.add(clause);
  }

  line(text: string) {
    this.lines.push(text);
  }

  ask(question: QuestionRequest | null) {
    if (
      question &&
      !this.questions.some(
        (item) =>
          item.kind === question.kind &&
          item.subject.id === question.subject.id &&
          hashOf(item.params) === hashOf(question.params),
      )
    )
      this.questions.push(question);
  }

  /** A parameter, recording the version read. */
  param<T>(key: string, axis: DateAxis, date: string): T {
    const value = this.rules.param<T>(key, axis, date as LocalDate);
    for (const id of this.rules.used.keys()) if (id.startsWith(`${key}/`)) this.versions.add(id);
    return value;
  }

  /** A known figure, or records why it is not and what to ask. */
  known<T>(name: string, figure: Known<T>, show: (value: T) => JsonValue): T | undefined {
    if (figure.known) {
      this.inputs[name] = { value: show(figure.value), source: figure.source, ref: figure.ref };
      return figure.value;
    }
    this.inputs[name] = { unknown: figure.reason };
    this.line(`Necunoscut: ${figure.reason}`);
    this.ask(figure.question);
    return undefined;
  }

  finish(
    status: DeterminationStatus,
    value: string | null,
    effectiveFrom: string,
    summary: string,
    unsupported: Determination['unsupported'] = null,
  ): Determination {
    const changes = status === 'proposed' ? this.changes : [];
    return {
      axis: this.axis,
      year: this.year,
      status,
      value: status === 'proposed' ? value : null,
      effectiveFrom: effectiveFrom as LocalDate,
      changes,
      summary,
      lines: this.lines,
      inputs: this.inputs,
      clauses: [...this.clauses],
      versions: [...this.versions].sort(),
      questions: status === 'needs_evidence' ? this.questions : [],
      dependsOn: this.dependsOn,
      unsupported,
      fingerprint: hashOf({
        axis: this.axis,
        year: this.year,
        status,
        value: status === 'proposed' ? value : null,
        effectiveFrom,
        changes,
        inputs: this.inputs,
      }),
    };
  }

  notApplicable(reason: string) {
    this.line(reason);
    return this.finish('not_applicable', null, `${this.year}-01-01`, reason);
  }

  needs(reason: string, question?: QuestionRequest | null) {
    if (question) this.ask(question);
    return this.finish('needs_evidence', null, `${this.year}-01-01`, reason);
  }

  ruleGap(error: RuleGapError) {
    this.line(error.message);
    this.ask(factQuestion(this.axis, this.year));
    return this.finish(
      'rule_gap',
      null,
      `${this.year}-01-01`,
      `Regula pentru ${this.axis} în ${this.year} nu este în registru: ${error.message}`,
    );
  }
}

/** Runs a determination, turning a missing rule into a RULE_GAP. */
export function guarded(draft: Draft, run: () => Determination): Determination {
  try {
    return run();
  } catch (error) {
    if (error instanceof RuleGapError) return draft.ruleGap(error);
    throw error;
  }
}

const formOf = (context: DeterminationContext) =>
  recordedAt(context.facts, 'entity.form', `${context.year}-12-31`) as EntityForm | null;

// ---------------------------------------------------------------------------------------------
// Micro-enterprise or profit tax (Codul fiscal art. 47–48, 51–52, 54)

type Condition = {
  id: string;
  clause: string;
  state: 'met' | 'failed' | 'unknown' | 'not_applicable';
  text: string;
};

/** The linked enterprises' revenue counted through a quarter of the year (art. 52 alin. (5^1)–
 * (5^2)): turnover as answered through that quarter or later (an upper bound), and for a
 * linked enterprise on a norm, a quarter of the yearly norm for each quarter elapsed. Null when an
 * enterprise's figure for the quarter is not answered. */
export function linkedThrough(
  linked: MicroConditionsAnswer['linked'],
  quarter: number,
  normaShare: string,
): bigint | null {
  let sum = 0n;
  for (const item of linked) {
    if (!item.currentYear) return null;
    const amount = parseScaled(item.currentYear.amount, 2);
    if (item.basis === 'norma')
      sum += divRound(
        amount * parseScaled(normaShare, 4) * BigInt(quarter),
        10_000n,
        'halfAwayFromZero',
      );
    else if (item.currentYear.throughQuarter >= quarter) sum += amount;
    else return null;
  }
  return sum;
}

export function determineIncomeTax(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('income_tax', year, rules);
  const start = `${year}-01-01`;
  const before = `${year - 1}-12-31`;
  return guarded(draft, () => {
    const form = formOf(context);
    if (!form)
      return draft.needs(
        'Forma juridică a companiei nu este înregistrată (entity.form).',
        factQuestionFrom('entity.form', start),
      );
    if (individualForms.includes(form))
      return draft.notApplicable(
        'O PFA, II sau IF datorează impozit pe venit (titlul IV), nu impozit pe profit sau pe veniturile microîntreprinderilor.',
      );
    const limit = draft.param<string>(
      'ro.micro.revenue_limit_eur',
      'reporting_period_start',
      start,
    );
    const employee = draft.param<MicroEmployee>(
      'ro.micro.employee',
      'reporting_period_start',
      start,
    );
    const linkedRule = draft.param<MicroLinked>('ro.micro.linked', 'reporting_period_start', start);
    draft.cite(
      code('art.47(1)(c)'),
      code('art.47(1)'),
      code('art.47(1^1)'),
      code('art.47(1)(g)'),
      code('art.47(3)'),
      code('art.48(1)-(2^1)'),
      'OUG156/2024:art.LXIV.pct.2-3',
    );
    const answer = draft.known('micro', context.micro, (value) => ({
      linked: value.linked.length,
      evidence: value.evidenceIds,
    }));
    const established =
      answer?.established && answer.established >= start && answer.established <= `${year}-12-31`
        ? answer.established
        : null;
    const conditions: Condition[] = [];
    const add = (condition: Condition) => conditions.push(condition);

    // c) and alin. (1^1): the previous year's turnover with the linked enterprises', at most the
    // limit at the BNR rate of the previous year's close.
    if (established)
      add({
        id: 'c',
        clause: code('art.48(3)-(3^3)'),
        state: 'not_applicable',
        text: `Înființată la ${established}: limita veniturilor anului precedent nu se aplică (art. 48 alin. (3)).`,
      });
    else {
      const turnover = draft.known('previousTurnover', context.previous.turnover, money);
      const rate = draft.known('previousEurRate', context.previous.eurRate, (quote) => ({
        ...quote,
      }));
      if (turnover === undefined || rate === undefined)
        add({
          id: 'c',
          clause: code('art.47(1)(c)'),
          state: 'unknown',
          text: 'Venituri necunoscute.',
        });
      else {
        const limitLei = euroInLei(limit, rate);
        const linked = answer
          ? answer.linked.reduce((sum, item) => sum + parseScaled(item.previousYear, 2), 0n)
          : null;
        const total = turnover + (linked ?? 0n);
        const state = total > limitLei ? 'failed' : linked === null ? 'unknown' : ('met' as const);
        add({
          id: 'c',
          clause: code('art.47(1)(c)'),
          state,
          text: `Cifra de afaceri ${year - 1}: ${lei(turnover)} lei${linked === null ? ', întreprinderile legate necunoscute' : linked ? ` + întreprinderile legate ${lei(linked)} lei` : ', fără întreprinderi legate'} = ${lei(total)} lei, față de ${limit} € × ${rate.rate} (BNR ${rate.date}) = ${lei(limitLei)} lei.`,
        });
      }
    }

    // g): at least one employee at the previous year's end, a mandate, or a new company's 90 days.
    const fteBefore = fteOn(context.contracts, before);
    if (established) {
      const deadline = addDays(established as LocalDate, employee.newCompanyDays);
      const hired = context.contracts.some(
        (contract) =>
          contract.start >= established &&
          contract.start <= deadline &&
          fteOn(context.contracts, contract.start) >= Number(employee.fte),
      );
      add({
        id: 'g',
        clause: code('art.48(3)-(3^3)'),
        state: hired || answer?.mandate ? 'met' : context.today > deadline ? 'failed' : 'unknown',
        text: hired
          ? `Salariat angajat în ${employee.newCompanyDays} de zile de la înregistrare.`
          : `Niciun salariat cu normă întreagă până la ${deadline}.`,
      });
    } else if (fteBefore >= Number(employee.fte))
      add({
        id: 'g',
        clause: code('art.47(1)(g)'),
        state: 'met',
        text: `${fteBefore} normă/norme întregi la ${before}, din contractele de muncă.`,
      });
    else
      add({
        id: 'g',
        clause: code('art.47(1)(g)'),
        state: answer ? (answer.mandate ? 'met' : 'failed') : 'unknown',
        text: answer?.mandate
          ? 'Contract de administrare sau mandat plătit cel puțin cu salariul minim (art. 51 alin. (4) lit. b)).'
          : `Contractele de muncă însumează ${fteBefore} normă la ${before}${answer ? ', fără contract de mandat' : ''}.`,
      });

    // d), e), h), i) and alin. (3): only the owner knows them.
    const owner = (
      id: string,
      clause: string,
      ok: (value: MicroConditionsAnswer) => boolean | null,
      text: string,
    ) =>
      add({
        id,
        clause,
        state: !answer
          ? 'unknown'
          : ok(answer) === null
            ? 'not_applicable'
            : ok(answer)
              ? 'met'
              : 'failed',
        text,
      });
    owner(
      'd',
      code('art.47(1)'),
      (value) => !value.stateOwned,
      'Capitalul nu este deținut de stat sau de o unitate administrativ-teritorială.',
    );
    owner(
      'e',
      code('art.47(1)'),
      (value) => !value.dissolution,
      'Societatea nu este în dizolvare urmată de lichidare.',
    );
    owner(
      'h',
      code('art.47(3)'),
      (value) => value.shareholders !== 'not_designated',
      'Asociații cu peste 25% au stabilit-o ca singura lor microîntreprindere, sau nu dețin alta.',
    );
    owner(
      'i',
      code('art.47(1)'),
      (value) =>
        established
          ? null
          : value.statementsOnTime === 'not_required'
            ? null
            : value.statementsOnTime === 'yes',
      'Situațiile financiare anuale au fost depuse în termen.',
    );
    owner(
      '3',
      code('art.47(3)'),
      (value) => !value.excludedActivity,
      'Nu desfășoară o activitate exclusă (art. 47 alin. (3)).',
    );
    add({
      id: 'f',
      clause: 'OUG156/2024:art.LXIV.pct.2-3',
      state: 'not_applicable',
      text: 'Ponderea veniturilor din consultanță și management nu mai este o condiție: art. 47 alin. (1) lit. f) a fost abrogat (OUG nr. 156/2024 art. LXIV pct. 3; art. 54 alin. (3)).',
    });

    for (const condition of conditions)
      draft.line(
        `${condition.id === '3' ? 'Alin. (3)' : `Lit. ${condition.id})`}: ${condition.state === 'met' ? 'îndeplinită' : condition.state === 'failed' ? 'NEÎNDEPLINITĂ' : condition.state === 'unknown' ? 'necunoscută' : 'nu se aplică'}. ${condition.text}`,
      );
    draft.inputs.conditions = conditions.map((condition) => ({
      id: condition.id,
      state: condition.state,
    }));
    draft.inputs.fteAtPreviousYearEnd = fteBefore;
    const failed = conditions.filter((condition) => condition.state === 'failed');
    if (failed.length) {
      for (const condition of failed) draft.cite(condition.clause);
      return draft.finish(
        'proposed',
        'profit',
        start,
        `Pentru ${year} compania nu îndeplinește condițiile microîntreprinderii (${failed.map((condition) => (condition.id === '3' ? 'alin. (3)' : `lit. ${condition.id})`)).join(', ')}): datorează impozit pe profit.`,
      );
    }
    if (conditions.some((condition) => condition.state === 'unknown')) {
      if (!answer) draft.ask(microQuestion(year));
      return draft.needs(
        `Condițiile microîntreprinderii pentru ${year} nu sunt toate cunoscute: întrebați proprietarul.`,
      );
    }

    // Eligible: the option is the company's (art. 48 alin. (1)–(2^1)); it carries the previous
    // year's regime unless it opted otherwise by 31 March (art. 55 alin. (2)).
    const previous = established ? null : recordedAt(context.facts, 'income_tax', before);
    draft.inputs.previousRegime = previous;
    if (!previous)
      return draft.needs(
        `Compania îndeplinește condițiile microîntreprinderii pentru ${year}; opțiunea pentru impozitul pe veniturile microîntreprinderilor sau pe profit nu este înregistrată.`,
        factQuestion('income_tax', year),
      );
    draft.line(
      previous === 'micro'
        ? `Îndeplinește condițiile și a fost microîntreprindere în ${year - 1}: rămâne microîntreprindere (art. 48 alin. (2^1): nu poate opta pentru profit în cursul anului).`
        : `Îndeplinește condițiile, dar a plătit impozit pe profit în ${year - 1}: poate opta pentru impozitul micro din ${year}, comunicând opțiunea până la 31 martie (art. 48 alin. (2), art. 55 alin. (2)); fără opțiune rămâne la profit.`,
    );

    // Exits during the year (art. 52): the limit crossed in a quarter, the only employee not
    // replaced in 30 days, the statements not filed in time.
    if (previous === 'micro') {
      const exits: { quarter: number; reason: string }[] = [];
      const rate = context.previous.eurRate.known ? context.previous.eurRate.value : null;
      if (rate) {
        const limitLei = euroInLei(limit, rate);
        let own = 0n;
        const linked = answer?.linked ?? [];
        for (let quarter = 1; quarter <= 4; quarter++) {
          if (quarterStart(year, quarter) > context.today) break;
          own += context.activity.quarterTurnover[quarter - 1]!;
          const others = linked.length ? linkedThrough(linked, quarter, linkedRule.normaShare) : 0n;
          if (own > limitLei) {
            exits.push({
              quarter,
              reason: `cifra de afaceri cumulată ${lei(own)} lei depășește ${lei(limitLei)} lei în trimestrul ${quarter} (art. 52 alin. (1), (5))`,
            });
            break;
          }
          if (others === null) {
            draft.cite(code('art.52(5^1)-(5^2)'));
            draft.ask(microQuestion(year));
            return draft.needs(
              `Veniturile întreprinderilor legate până la trimestrul ${quarter} al anului ${year} nu sunt cunoscute: limita se verifică pe veniturile cumulate (art. 52 alin. (5^1)–(5^2)).`,
            );
          }
          if (own + others > limitLei) {
            draft.cite(code('art.52(5^1)-(5^2)'));
            exits.push({
              quarter,
              reason: `veniturile cumulate cu ale întreprinderilor legate, ${lei(own + others)} lei, depășesc ${lei(limitLei)} lei în trimestrul ${quarter} (art. 52 alin. (5^1)–(5^2))`,
            });
            break;
          }
        }
        draft.inputs.yearTurnover = context.activity.quarterTurnover.map(money);
      }
      if (!answer?.mandate)
        for (const ended of context.contracts.filter(
          (contract) =>
            contract.end !== null && contract.end >= start && contract.end < `${year}-12-31`,
        )) {
          const after = addDays(ended.end!, 1);
          if (fteOn(context.contracts, after) >= Number(employee.fte)) continue;
          const deadline = addDays(ended.end!, employee.replacementDays);
          const replaced = context.contracts.some(
            (contract) =>
              contract.start > ended.end! &&
              contract.start <= deadline &&
              (contract.end === null || daysBetween(contract.start, contract.end) >= 364) &&
              fteOn(context.contracts, contract.start) >= Number(employee.fte),
          );
          if (replaced || context.today <= deadline) continue;
          const quarter = quarterOf(ended.end!) + 1;
          draft.cite(code('art.52(2)-(3)'));
          if (quarter <= 4)
            exits.push({
              quarter,
              reason: `raportul de muncă a încetat la ${ended.end} și niciun salariat nu a fost angajat în ${employee.replacementDays} de zile (art. 52 alin. (3))`,
            });
        }
      if (answer?.lateStatementsFrom && answer.lateStatementsFrom.startsWith(String(year))) {
        draft.cite(code('art.52(2)-(3)'));
        exits.push({
          quarter: quarterOf(answer.lateStatementsFrom),
          reason: `situațiile financiare nu au fost depuse în termen (${answer.lateStatementsFrom}, art. 52 alin. (2))`,
        });
      }
      // Alin. (4) and (7): an excluded activity started, or the shareholders' other
      // micro-enterprises, from the quarter it happened in.
      for (const [from, text] of [
        [answer?.excludedActivityFrom, 'a început o activitate exclusă (art. 52 alin. (4))'],
        [
          answer?.shareholdersExitFrom,
          'asociații cu peste 25% dețin și alte microîntreprinderi și au stabilit ieșirea ei (art. 52 alin. (7))',
        ],
      ] as const)
        if (from && from.startsWith(String(year))) {
          draft.cite(code('art.52(4),(6)-(7)'));
          exits.push({ quarter: quarterOf(from), reason: `${text} la ${from}` });
        }
      const first = exits.sort((a, b) => a.quarter - b.quarter)[0];
      if (first) {
        draft.cite(code('art.52(1),(5)'));
        draft.changes.push({
          value: 'profit',
          effectiveFrom: quarterStart(year, first.quarter),
          reason: first.reason,
        });
        draft.line(`Iese din sistemul micro din trimestrul ${first.quarter}: ${first.reason}.`);
      }
    }
    return draft.finish(
      'proposed',
      previous,
      start,
      `Pentru ${year}: ${previous === 'micro' ? 'impozit pe veniturile microîntreprinderilor' : 'impozit pe profit'}${draft.changes.length ? `, apoi impozit pe profit din ${draft.changes[0]!.effectiveFrom}` : ''}.`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The VAT period (art. 322)

export function determineVatPeriod(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('vat.period', year, rules);
  const start = `${year}-01-01`;
  return guarded(draft, () => {
    const atStart = recordedAt(context.facts, 'vat.status', start);
    const atEnd = recordedAt(context.facts, 'vat.status', `${year}-12-31`);
    if (!atStart && !atEnd)
      return draft.needs(
        'Regimul TVA al companiei nu este înregistrat (vat.status).',
        factQuestionFrom('vat.status', start),
      );
    if (atStart !== 'normal_vat' && atEnd !== 'normal_vat')
      return draft.notApplicable(`Compania nu este înregistrată în scopuri de TVA în ${year}.`);
    draft.cite(code('art.322(2)-(6)'), code('norme.art.322.pct.103(2)-(3)'));
    if (atStart !== 'normal_vat') return registrationYearPeriod(context, draft);
    const registeredBefore = context.facts.find(
      (fact) =>
        fact.axis === 'vat.status' &&
        fact.value === 'normal_vat' &&
        fact.effectiveFrom > `${year - 1}-01-01` &&
        fact.effectiveFrom <= `${year - 1}-12-31` &&
        recordedAt(context.facts, 'vat.status', addDays(fact.effectiveFrom, -1)) !== 'normal_vat',
    );
    if (registeredBefore) return afterRegistrationPeriod(context, draft, registeredBefore);
    const limit = draft.param<string>('ro.vat.period.limit_eur', 'reporting_period_start', start);
    const turnover = draft.known('previousVatTurnover', context.previous.vatTurnover, money);
    const rate = draft.known('previousEurRate', context.previous.eurRate, (quote) => ({
      ...quote,
    }));
    const goods = draft.known(
      'previousEuGoodsAcquisitions',
      context.previous.euGoodsAcquisitions,
      (value) => value,
    );
    if (turnover === undefined || rate === undefined || goods === undefined)
      return draft.needs(`Cifra de afaceri a anului ${year - 1} nu este cunoscută.`);
    const limitLei = euroInLei(limit, rate);
    const quarterly = turnover <= limitLei && !goods;
    draft.line(
      `Cifra de afaceri ${year - 1} din operațiuni taxabile, scutite cu drept de deducere și cu locul în străinătate: ${lei(turnover)} lei, față de ${limit} € × ${rate.rate} (BNR ${rate.date}) = ${lei(limitLei)} lei; ${goods ? 'cu' : 'fără'} achiziții intracomunitare de bunuri.`,
    );
    return draft.finish(
      'proposed',
      quarterly ? 'quarterly' : 'monthly',
      start,
      `Perioada fiscală de TVA în ${year}: ${quarterly ? 'trimestrul' : 'luna'} calendaristic${quarterly ? '' : 'ă'}.`,
    );
  });
}

/** A year's turnover recalculated for a whole calendar year (art. 322 alin. (4)–(5)): in
 * proportion to the days of activity, or to the calendar months begun, as the register says. */
function annualized(
  draft: Draft,
  turnover: bigint,
  from: LocalDate,
  to: LocalDate,
): { value: bigint; text: string } {
  const year = Number(from.slice(0, 4));
  const method = draft.param<'days' | 'months'>(
    'ro.vat.registration.annualized',
    'reporting_period_start',
    from,
  );
  if (method === 'months') {
    const months = Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    return {
      value: divRound(turnover * 12n, BigInt(months), 'halfAwayFromZero'),
      text: `${lei(turnover)} lei × 12 / ${months} luni începute`,
    };
  }
  const days = daysBetween(from, to) + 1;
  const inYear = daysBetween(`${year}-01-01` as LocalDate, `${year}-12-31` as LocalDate) + 1;
  return {
    value: divRound(turnover * BigInt(inYear), BigInt(days), 'halfAwayFromZero'),
    text: `${lei(turnover)} lei × ${inYear} / ${days} zile de activitate`,
  };
}

/**
 * The VAT period of the year a small enterprise registers in (art. 322 alin. (4)): the turnover
 * obtained before registration, recalculated for a whole calendar year, against the limit at the
 * BNR rate of the previous 31 December (norme pct. 103 alin. (2)); monthly above it, or after an
 * intra-Community acquisition of goods before registration.
 */
function registrationYearPeriod(context: DeterminationContext, draft: Draft): Determination {
  const year = context.year;
  const registration = context.facts
    .filter(
      (fact) =>
        fact.axis === 'vat.status' &&
        fact.value === 'normal_vat' &&
        fact.effectiveFrom > `${year}-01-01` &&
        fact.effectiveFrom <= `${year}-12-31`,
    )
    .map((fact) => fact.effectiveFrom)
    .sort()[0]!;
  draft.cite(code('art.322(4)-(5)'), code('norme.art.322.pct.103(2)-(3)'));
  draft.inputs.registration = registration;
  const from = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  if (!context.activity.kept && !context.activity.start)
    return draft.needs(
      `Compania se înregistrează în scopuri de TVA la ${registration}, iar registrele nu cuprind anul ${year} de la 1 ianuarie: cifra de afaceri obținută până la înregistrare nu se poate recalcula (art. 322 alin. (4)).`,
      factQuestion('vat.period', year),
    );
  const limit = draft.param<string>('ro.vat.period.limit_eur', 'reporting_period_start', from);
  const rate = draft.known('previousEurRate', context.previous.eurRate, (quote) => ({
    ...quote,
  }));
  const goods = draft.known(
    'euGoodsAcquisitions',
    context.current.euGoodsAcquisitions,
    (value) => value,
  );
  if (rate === undefined || goods === undefined)
    return draft.needs(
      `Cursul de la 31.12.${year - 1} sau achizițiile din ${year} nu sunt cunoscute.`,
    );
  const turnover = context.activity.days
    .filter((day) => day.date >= from && day.date < registration)
    .reduce((sum, day) => sum + day.exemption, 0n);
  const yearly = annualized(draft, turnover, from, addDays(registration as LocalDate, -1));
  const limitLei = euroInLei(limit, rate);
  draft.inputs.annualized = money(yearly.value);
  draft.line(
    `Înregistrare în scopuri de TVA la ${registration}: cifra de afaceri obținută de la ${from}, recalculată pentru un an întreg, ${yearly.text} = ${lei(yearly.value)} lei, față de ${limit} € × ${rate.rate} (BNR ${rate.date}) = ${lei(limitLei)} lei; ${goods ? 'cu' : 'fără'} achiziții intracomunitare de bunuri în ${year}.`,
  );
  draft.line(
    'O înregistrare din oficiu are luna drept perioadă fiscală în anul înregistrării (norme pct. 103 alin. (1)): decizia de înregistrare o arată.',
  );
  const quarterly = yearly.value <= limitLei && !goods;
  return draft.finish(
    'proposed',
    quarterly ? 'quarterly' : 'monthly',
    registration,
    `Perioada fiscală de TVA de la ${registration}: ${quarterly ? 'trimestrul' : 'luna'} calendaristic${quarterly ? '' : 'ă'} (art. 322 alin. (4)); primul decont începe la data înregistrării.`,
  );
}

/** The year after a registration (art. 322 alin. (5)): the turnover actually obtained in the
 * registration year from the registration, recalculated for a whole year. */
function afterRegistrationPeriod(
  context: DeterminationContext,
  draft: Draft,
  registered: ProfileFact,
): Determination {
  const year = context.year;
  const start = `${year}-01-01`;
  draft.cite(code('art.322(4)-(5)'), code('norme.art.322.pct.103(2)-(3)'));
  const limit = draft.param<string>('ro.vat.period.limit_eur', 'reporting_period_start', start);
  const turnover = draft.known('previousVatTurnover', context.previous.vatTurnover, money);
  const rate = draft.known('previousEurRate', context.previous.eurRate, (quote) => ({
    ...quote,
  }));
  const goods = draft.known(
    'previousEuGoodsAcquisitions',
    context.previous.euGoodsAcquisitions,
    (value) => value,
  );
  if (turnover === undefined || rate === undefined || goods === undefined)
    return draft.needs(`Cifra de afaceri a anului ${year - 1} nu este cunoscută.`);
  const yearly = annualized(
    draft,
    turnover,
    registered.effectiveFrom,
    `${year - 1}-12-31` as LocalDate,
  );
  const limitLei = euroInLei(limit, rate);
  draft.line(
    `Înregistrare în scopuri de TVA la ${registered.effectiveFrom}: cifra de afaceri efectivă a anului ${year - 1} de la înregistrare, recalculată pentru un an întreg, ${yearly.text} = ${lei(yearly.value)} lei, față de ${lei(limitLei)} lei; ${goods ? 'cu' : 'fără'} achiziții intracomunitare de bunuri.`,
  );
  const quarterly = yearly.value <= limitLei && !goods;
  return draft.finish(
    'proposed',
    quarterly ? 'quarterly' : 'monthly',
    start,
    `Perioada fiscală de TVA în ${year}: ${quarterly ? 'trimestrul' : 'luna'} calendaristic${quarterly ? '' : 'ă'} (art. 322 alin. (5)).`,
  );
}

// ---------------------------------------------------------------------------------------------
// Monthly or quarterly D112 (art. 80 alin. (2), art. 147 alin. (4)–(10))

/** Whether the company employs in the year: a contract running in it, else the recorded fact
 * at the year's start and its changes within the year; null when nothing says. */
export function employerIn(context: DeterminationContext): boolean | null {
  const start = `${context.year}-01-01`;
  const end = `${context.year}-12-31`;
  if (
    context.contracts.some(
      (contract) => contract.start <= end && (contract.end === null || contract.end >= start),
    )
  )
    return true;
  const values = [
    recordedAt(context.facts, 'employer', start),
    ...context.facts
      .filter(
        (fact) =>
          fact.axis === 'employer' && fact.effectiveFrom > start && fact.effectiveFrom <= end,
      )
      .map((fact) => fact.value),
  ];
  if (values.includes('yes')) return true;
  return values[0] === 'no' || (values[0] === null && values.length > 1) ? false : null;
}

export function determinePayrollPeriod(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('payroll.period', year, rules);
  const start = `${year}-01-01`;
  return guarded(draft, () => {
    const employer = employerIn(context);
    if (employer === null)
      return draft.needs(
        `Nu se știe dacă firma are salariați în ${year} (employer).`,
        factQuestionFrom('employer', start),
      );
    if (!employer) return draft.notApplicable(`Firma nu are salariați în ${year}.`);
    const form = formOf(context);
    if (!form)
      return draft.needs(
        'Forma juridică a companiei nu este înregistrată (entity.form).',
        factQuestionFrom('entity.form', start),
      );
    const rule = draft.param<PayrollQuarterly>(
      'ro.payroll.quarterly',
      'reporting_period_start',
      start,
    );
    draft.cite(code('art.80(2)-(3)'), code('art.147(4)-(10)'));
    const option =
      'Fără opțiunea pentru depunerea lunară, depusă până la 31 ianuarie (art. 147 alin. (8)).';
    if (individualForms.includes(form)) {
      draft.line(
        `O ${form.toUpperCase()} cu salariați plătește impozitul și depune D112 trimestrial (art. 80 alin. (2) lit. d)). ${option}`,
      );
      return draft.finish('proposed', 'quarterly', start, `D112 trimestrial în ${year}.`);
    }
    const regime = recordedInYear(context.facts, 'income_tax', year, start);
    if (!regime) {
      draft.dependsOn.push('income_tax');
      return draft.needs(
        `Regimul impozitului pe profit sau micro pentru ${year} nu este înregistrat; condițiile D112 trimestriale depind de el.`,
      );
    }
    const averageText = draft.known(
      'previousAverageEmployees',
      context.previous.averageEmployeesD112,
      (value) => value,
    );
    if (averageText === undefined)
      return draft.needs(`Numărul mediu de salariați din ${year - 1} nu este cunoscut.`);
    const fewer = parseScaled(averageText, 2) < BigInt(rule.employeesBelow) * 100n;
    draft.line(
      `Numărul mediu de salariați din ${year - 1} (media lunilor cu D112): ${averageText}, ${fewer ? 'sub' : 'nu sub'} ${rule.employeesBelow}.`,
    );
    let quarterly = fewer;
    if (regime === 'profit') {
      const revenue = draft.known('previousTotalRevenue', context.previous.totalRevenue, money);
      const rate = draft.known('previousEurRate', context.previous.eurRate, (quote) => ({
        ...quote,
      }));
      if (revenue === undefined || rate === undefined)
        return draft.needs(`Veniturile totale din ${year - 1} nu sunt cunoscute.`);
      const limitLei = euroInLei(rule.revenueLimitEur, rate);
      draft.line(
        `Venituri totale ${year - 1}: ${lei(revenue)} lei, față de ${rule.revenueLimitEur} € × ${rate.rate} (BNR ${rate.date}) = ${lei(limitLei)} lei.`,
      );
      quarterly = quarterly && revenue <= limitLei;
    }
    draft.line(
      quarterly ? option : 'Condițiile art. 80 alin. (2) nu sunt îndeplinite: D112 lunar.',
    );
    return draft.finish(
      'proposed',
      quarterly ? 'quarterly' : 'monthly',
      start,
      `D112 ${quarterly ? 'trimestrial' : 'lunar'} în ${year}.`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The size category (OMFP nr. 1.802/2014 pct. 9 and 12–15; OMF nr. 2.036/2025 anexa 1)

export const sizeCategories = ['micro', 'small', 'medium_large'] as const;
export type SizeCategory = (typeof sizeCategories)[number];
const rank = (category: SizeCategory) => sizeCategories.indexOf(category);

export interface Indicators {
  assets: bigint;
  turnover: bigint;
  /** To two decimals. */
  employees: string;
}

/** Whether indicators exceed at least two of three criteria. */
export function exceeds(indicators: Indicators, criteria: SizeCriteria): boolean {
  const over = [
    indicators.assets > BigInt(criteria.assets) * 100n,
    indicators.turnover > BigInt(criteria.turnover) * 100n,
    parseScaled(indicators.employees, 2) > BigInt(criteria.employees) * 100n,
  ].filter(Boolean).length;
  return over >= 2;
}

/** The category one year's indicators alone give. */
export function categoryOf(indicators: Indicators, thresholds: SizeThresholds): SizeCategory {
  if (!exceeds(indicators, thresholds.micro)) return 'micro';
  if (!exceeds(indicators, thresholds.small)) return 'small';
  return 'medium_large';
}

/**
 * The category of a year from the previous one's and the two years' indicators: it changes only
 * when both years are beyond it (pct. 12 alin. (1), pct. 13): up to the lower of the two, down to
 * the higher.
 */
export function nextCategory(
  previous: SizeCategory,
  before: SizeCategory,
  current: SizeCategory,
): SizeCategory {
  if (rank(before) > rank(previous) && rank(current) > rank(previous))
    return sizeCategories[Math.min(rank(before), rank(current))]!;
  if (rank(before) < rank(previous) && rank(current) < rank(previous))
    return sizeCategories[Math.max(rank(before), rank(current))]!;
  return previous;
}

const categoryText: Record<SizeCategory, string> = {
  micro: 'microentitate',
  small: 'entitate mică',
  medium_large: 'entitate mijlocie sau mare',
};

export function determineSizeCategory(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('size.category', year, rules);
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  return guarded(draft, () => {
    const form = formOf(context);
    if (!form)
      return draft.needs(
        'Forma juridică a companiei nu este înregistrată (entity.form).',
        factQuestionFrom('entity.form', start),
      );
    const books = recordedAt(context.facts, 'books.system', end);
    if (books === 'single' || (!books && individualForms.includes(form)))
      return draft.notApplicable(
        'Contabilitatea în partidă simplă nu întocmește situații financiare anuale (OMFP nr. 170/2015 cap. II pct. 11).',
      );
    const thresholds = draft.param<SizeThresholds>(
      'ro.size.thresholds',
      'fiscal_year_start',
      start,
    );
    draft.cite(
      'OMF2036/2025:anexa1.pct.2.1-2.3',
      'OMF2036/2025:anexa1.pct.2.6',
      'OMFP1802/2014:pct.12-13',
      'OMFP1802/2014:pct.15',
    );
    const indicators = (figures: YearFigures, label: string): Indicators | undefined => {
      const assets = draft.known(`${label}TotalAssets`, figures.totalAssets, money);
      const turnover = draft.known(`${label}NetTurnover`, figures.netTurnover, money);
      const employees = draft.known(`${label}AverageEmployees`, figures.averageEmployees, (v) => v);
      return assets === undefined || turnover === undefined || employees === undefined
        ? undefined
        : { assets, turnover, employees };
    };
    const show = (value: Indicators) =>
      `active ${lei(value.assets)} lei, cifră de afaceri netă ${lei(value.turnover)} lei, ${value.employees} salariați în medie`;
    const previous = recordedAt(
      context.facts,
      'size.category',
      `${year - 1}-12-31`,
    ) as SizeCategory | null;
    draft.inputs.previousCategory = previous;
    if (!previous)
      return draft.needs(
        `Categoria de mărime a exercițiului ${year - 1} nu este înregistrată (situațiile financiare depuse pentru el o arată).`,
        factQuestion('size.category', year - 1),
      );
    const before = indicators(context.previous, 'previous');
    if (!before) return draft.needs(`Indicatorii exercițiului ${year - 1} nu sunt cunoscuți.`);
    const testBefore = categoryOf(before, thresholds);
    draft.line(
      `${year - 1}: ${show(before)}: ${categoryText[testBefore]} după criterii; categoria înregistrată: ${categoryText[previous]}.`,
    );
    const auditBefore = exceeds(before, thresholds.audit);
    let category: SizeCategory = previous;
    if (testBefore !== previous || auditBefore) {
      if (context.today <= end)
        return draft.needs(
          `${year - 1} a depășit criteriile categoriei sale: categoria pentru ${year} se stabilește la sfârșitul exercițiului, din indicatorii ambilor ani (OMFP nr. 1.802/2014 pct. 13).`,
          factQuestion('size.category', year),
        );
      const now = indicators(context.current, 'current');
      if (!now) return draft.needs(`Indicatorii exercițiului ${year} nu sunt cunoscuți.`);
      const testNow = categoryOf(now, thresholds);
      draft.line(`${year}: ${show(now)}: ${categoryText[testNow]} după criterii.`);
      category = nextCategory(previous, testBefore, testNow);
      if (auditBefore && exceeds(now, thresholds.audit)) {
        draft.line(
          `Depășește două dintre pragurile auditului (${thresholds.audit.assets} lei, ${thresholds.audit.turnover} lei, ${thresholds.audit.employees} salariați) în ${year - 1} și ${year}: situațiile financiare se auditează.`,
        );
        return draft.finish('unsupported', null, start, 'Situații financiare auditate.', {
          trigger: 'AUDIT_REQUIRED',
          message: `Situațiile financiare ale exercițiului ${year} se auditează (OMF nr. 2.036/2025 anexa nr. 1 pct. 2.6 alin. (4)): auditul statutar nu este acoperit.`,
          capabilities: ['STATUTORY_AUDIT'],
        });
      }
    } else
      draft.line(
        `${year - 1} nu a depășit criteriile categoriei sale: categoria nu se schimbă în ${year}, oricare ar fi indicatorii lui ${year} (pct. 12 alin. (1)).`,
      );
    if (category === 'medium_large')
      return draft.finish('unsupported', null, start, 'Entitate mijlocie sau mare.', {
        trigger: 'SIZE_MEDIUM_LARGE',
        message: `În ${year} compania este entitate mijlocie sau mare: situațiile financiare complete și auditul nu sunt acoperite.`,
        capabilities: ['ANNUAL_STATEMENTS_LARGE', 'STATUTORY_AUDIT'],
      });
    return draft.finish(
      'proposed',
      category,
      start,
      `Categoria de mărime pentru ${year}: ${categoryText[category]}.`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The small-enterprise threshold of a company not registered for VAT (art. 310)

export function determineVatThreshold(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('vat.threshold', year, rules);
  const start = context.activity.start ?? `${year}-01-01`;
  return guarded(draft, () => {
    const atStart = recordedAt(context.facts, 'vat.status', start);
    if (!atStart)
      return draft.needs(
        'Regimul TVA al companiei nu este înregistrat (vat.status).',
        factQuestionFrom('vat.status', start),
      );
    if (atStart === 'normal_vat')
      return draft.notApplicable(`Compania este înregistrată în scopuri de TVA la ${start}.`);
    const threshold = draft.param<string>(
      'ro.vat.exemption.threshold',
      'reporting_period_start',
      `${year}-01-01`,
    );
    draft.cite(code('art.310(1)-(2),(6)'));
    if (!context.activity.kept && !context.activity.start)
      return draft.needs(
        `Registrele nu cuprind anul ${year} de la 1 ianuarie: cifra de afaceri a regimului de scutire nu se poate cumula.`,
        factQuestion('vat.threshold', year),
      );
    if (context.activity.start) {
      // A company set up during the year: the threshold is the whole one (art. 310 alin. (5)),
      // cumulated from its first day.
      draft.cite(code('art.310(4)-(5)'), 'L82/1991:art.27(8)');
      draft.inputs.start = context.activity.start;
      draft.line(
        `Firma începe activitatea la ${start} (primul exercițiu financiar începe la înființare, Legea nr. 82/1991 art. 27 alin. (8)): plafonul nu se proporționalizează pentru anul început (art. 310 alin. (5)).`,
      );
    }
    const limit = BigInt(threshold) * 100n;
    const { total, crossed } = exemptionCrossing(context, limit);
    draft.inputs.exemptionTurnover = money(total);
    draft.inputs.crossed = crossed;
    draft.line(
      `Livrări și prestări cu locul în România în ${year}${crossed ? ` până la ${crossed}` : ''}: ${lei(total)} lei, față de plafonul de ${lei(limit)} lei.`,
    );
    if (crossed) {
      draft.cite(code('art.316(1)(b),(1^1)'));
      draft.changes.push({
        value: 'exceeded',
        effectiveFrom: crossed,
        reason: `plafonul de ${threshold} lei este depășit la ${crossed}: înregistrarea în scopuri de TVA se solicită cel târziu la această dată (art. 310 alin. (6))`,
      });
      draft.line(
        `Înregistrarea în scopuri de TVA se solicită cel târziu la ${crossed} (art. 310 alin. (6), art. 316 alin. (1) lit. b)) și este valabilă de la această dată (art. 316 alin. (1^1) lit. b)); regimul normal se aplică începând cu tranzacția care depășește plafonul.`,
      );
      return draft.finish(
        'proposed',
        'under',
        start,
        `Plafonul de scutire este depășit la ${crossed}: înregistrare în scopuri de TVA de la această dată.`,
      );
    }
    return draft.finish('proposed', 'under', start, `Sub plafonul de scutire în ${year}.`);
  });
}

/**
 * The day the year's supplies under the exemption (art. 310 alin. (2)) exceed the threshold: the
 * cumulated bases of the days the company was outside VAT the day before (a registration valid
 * from the day itself, the one the crossing gives, does not stop the count).
 */
export function exemptionCrossing(
  context: DeterminationContext,
  limit: bigint,
): { total: bigint; crossed: LocalDate | null } {
  let total = 0n;
  const from = context.activity.start ?? `${context.year}-01-01`;
  for (const day of context.activity.days) {
    if (day.date < from) continue;
    if (recordedAt(context.facts, 'vat.status', addDays(day.date, -1)) === 'normal_vat')
      return { total, crossed: null };
    total += day.exemption;
    if (total > limit) return { total, crossed: day.date };
  }
  return { total, crossed: null };
}

// ---------------------------------------------------------------------------------------------
// VAT on collection: eligibility and the exit (art. 282 alin. (3^1)–(5))

/** The last day of the VAT period after the one containing a date. */
function nextPeriodEnd(date: LocalDate, quarterly: boolean): LocalDate {
  const months = quarterly ? 3 : 1;
  const first = quarterly
    ? quarterStart(Number(date.slice(0, 4)), quarterOf(date))
    : (`${date.slice(0, 7)}-01` as LocalDate);
  return addDays(addMonthsToDate(first, months * 2), -1);
}

export function determineCashVat(context: DeterminationContext, rules: RuleContext): Determination {
  const year = context.year;
  const draft = new Draft('vat.cash', year, rules);
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  return guarded(draft, () => {
    const status = recordedAt(context.facts, 'vat.status', start);
    if (status !== 'normal_vat')
      return status
        ? draft.notApplicable(`Compania nu este înregistrată în scopuri de TVA la ${start}.`)
        : draft.needs(
            'Regimul TVA al companiei nu este înregistrat (vat.status).',
            factQuestionFrom('vat.status', start),
          );
    const recorded = recordedAt(context.facts, 'vat.cash', start);
    if (!recorded)
      return draft.needs(
        'Nu este înregistrat dacă firma aplică TVA la încasare (vat.cash).',
        factQuestionFrom('vat.cash', start),
      );
    draft.inputs.recorded = recorded;
    draft.cite(code('art.282(3^1)-(5)'));
    // The ceiling "for the year" (alin. (3^1) lit. a)): the version in force at the year's end.
    const ceiling = draft.param<string>('ro.vat.cash.ceiling', 'reporting_period_start', end);
    const turnover = draft.known('previousVatTurnover', context.previous.vatTurnover, money);
    if (turnover === undefined)
      return draft.needs(`Cifra de afaceri a anului ${year - 1} nu este cunoscută.`);
    const limit = BigInt(ceiling) * 100n;
    const eligible = turnover <= limit;
    draft.line(
      `Cifra de afaceri ${year - 1}: ${lei(turnover)} lei, față de plafonul de ${lei(limit)} lei: ${eligible ? 'eligibilă' : 'NEELIGIBILĂ'} pentru TVA la încasare (art. 282 alin. (3^1) lit. a), alin. (4) lit. c)).`,
    );
    if (!eligible)
      return draft.finish(
        'proposed',
        'no',
        start,
        `În ${year} firma nu poate aplica TVA la încasare: cifra de afaceri din ${year - 1} depășește plafonul.`,
      );
    if (recorded === 'yes') {
      const period = recordedInYear(context.facts, 'vat.period', year, start);
      let total = 0n;
      for (const day of context.activity.days) {
        total += day.vat;
        let dayCeiling: string;
        try {
          dayCeiling = draft.param<string>(
            'ro.vat.cash.ceiling',
            'reporting_period_start',
            day.date,
          );
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          draft.line(
            `Plafonul nu are versiune la ${day.date}: depășirea nu se verifică pentru ziua aceasta.`,
          );
          continue;
        }
        if (total <= BigInt(dayCeiling) * 100n) continue;
        if (!period) {
          draft.dependsOn.push('vat.period');
          return draft.needs(
            `Plafonul TVA la încasare este depășit la ${day.date}; ieșirea depinde de perioada fiscală a anului ${year}, neînregistrată.`,
          );
        }
        const exit = addDays(nextPeriodEnd(day.date, period === 'quarterly'), 1);
        draft.changes.push({
          value: 'no',
          effectiveFrom: exit,
          reason: `cifra de afaceri cumulată depășește plafonul de ${dayCeiling} lei la ${day.date}: sistemul se aplică până la sfârșitul perioadei fiscale următoare (art. 282 alin. (5))`,
        });
        draft.line(`Iese din sistemul TVA la încasare la ${exit}.`);
        break;
      }
    }
    return draft.finish(
      'proposed',
      recorded,
      start,
      `TVA la încasare în ${year}: ${recorded === 'yes' ? 'da' : 'nu'}${draft.changes.length ? `, până la ${addDays(draft.changes[0]!.effectiveFrom, -1)}` : ''}.`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Registered for VAT or not: the registration the threshold makes due, a registration by option
// and leaving the VAT system (art. 310 alin. (3), (6), (7), art. 316 alin. (1), (1^1), (11))

export function determineVatStatus(
  context: DeterminationContext,
  rules: RuleContext,
): Determination {
  const year = context.year;
  const draft = new Draft('vat.status', year, rules);
  const first = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  const end = `${year}-12-31`;
  return guarded(draft, () => {
    const atStart = recordedAt(context.facts, 'vat.status', first);
    if (!atStart)
      return draft.needs(
        'Regimul TVA al companiei nu este înregistrat (vat.status).',
        factQuestionFrom('vat.status', first),
      );
    draft.inputs.atStart = atStart;
    const threshold = draft.param<string>(
      'ro.vat.exemption.threshold',
      'reporting_period_start',
      `${year}-01-01`,
    );
    const limit = BigInt(threshold) * 100n;
    const kept = context.activity.kept || Boolean(context.activity.start);
    const crossing = atStart === 'non_vat' && kept ? exemptionCrossing(context, limit) : null;
    const recorded = context.facts.filter(
      (fact) =>
        fact.axis === 'vat.status' && fact.effectiveFrom > first && fact.effectiveFrom <= end,
    );
    let value = atStart;
    let since: LocalDate = first;
    const move = (to: string, from: LocalDate, reason: string) => {
      if (to === value) return;
      draft.changes.push({ value: to, effectiveFrom: from, reason });
      value = to;
      since = from;
    };
    draft.line(
      `La ${first}: ${atStart === 'normal_vat' ? 'înregistrată în scopuri de TVA (art. 316)' : 'neînregistrată în scopuri de TVA'}.`,
    );
    const events = [
      ...(crossing?.crossed ? [{ date: crossing.crossed, kind: 'crossing' as const }] : []),
      ...recorded.map((fact) => ({
        date: fact.effectiveFrom,
        kind: 'fact' as const,
        value: fact.value,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    for (const event of events) {
      if (event.kind === 'crossing') {
        draft.cite(code('art.310(1)-(2),(6)'), code('art.316(1)(b),(1^1)'));
        draft.inputs.crossed = event.date;
        draft.line(
          `Plafonul de scutire de ${threshold} lei este depășit la ${event.date}: înregistrarea se solicită cel târziu atunci și este valabilă de la această dată, inclusiv când se cere sau se face din oficiu mai târziu (art. 316 alin. (1^1) lit. b) și f), art. 310 alin. (6^1)–(6^2)).`,
        );
        move(
          'normal_vat',
          event.date,
          `plafonul de scutire este depășit la ${event.date} (art. 310 alin. (6), art. 316 alin. (1^1) lit. b))`,
        );
        continue;
      }
      if (event.value === 'normal_vat' && crossing?.crossed && event.date > crossing.crossed) {
        draft.line(
          `Înregistrarea consemnată de la ${event.date} este după depășirea plafonului (${crossing.crossed}): data înregistrării rămâne data depășirii (art. 310 alin. (6^1) lit. a), (6^2) lit. a)); o decizie cu altă dată (norme pct. 84 alin. (2) lit. c)) se indică cu documentul.`,
        );
        continue;
      }
      if (event.value === value) continue;
      if (event.value === 'normal_vat') {
        draft.cite(code('art.316(1)(b),(1^1)'));
        draft.line(
          `Înregistrare prin opțiune consemnată de la ${event.date}: valabilă de la data solicitării (art. 310 alin. (3), art. 316 alin. (1) lit. c), alin. (1^1) lit. c)).`,
        );
        move('normal_vat', event.date, 'înregistrare prin opțiune (art. 310 alin. (3))');
        continue;
      }
      // Leaving the VAT system: allowed when neither the previous year nor this one up to the
      // request exceeded the threshold (art. 310 alin. (7)).
      draft.cite(code('art.310(7)'), code('art.316(11)(g),(13)'));
      const previous = draft.known(
        'previousExemptionTurnover',
        context.previous.exemptionTurnover,
        money,
      );
      if (previous === undefined)
        return draft.needs(
          `Anularea înregistrării de la ${event.date} cere cifra de afaceri a anului ${year - 1} (art. 310 alin. (7)).`,
        );
      const current = context.activity.days
        .filter((item) => item.date >= first && item.date < event.date)
        .reduce((sum, item) => sum + item.exemption, 0n);
      draft.inputs.deregistration = { date: event.date, current: money(current) };
      const eligible = previous <= limit && current <= limit;
      draft.line(
        `Anularea înregistrării consemnată de la ${event.date}: cifra de afaceri ${year - 1} ${lei(previous)} lei și ${year} până atunci ${lei(current)} lei, față de plafonul de ${lei(limit)} lei: ${eligible ? 'se poate cere' : 'NU se poate cere'} (art. 310 alin. (7)); ultimul decont se depune până la 25 a lunii următoare comunicării deciziei (art. 316 alin. (13)).`,
      );
      if (eligible)
        move(
          'non_vat',
          event.date,
          'anularea înregistrării pentru regimul special de scutire, de la comunicarea deciziei (art. 310 alin. (7), art. 316 alin. (11) lit. g))',
        );
    }
    draft.inputs.until = since;
    return draft.finish(
      'proposed',
      atStart,
      first,
      `Regimul TVA în ${year}: ${atStart === 'normal_vat' ? 'plătitor' : 'neplătitor'} de la ${first}${draft.changes.map((change) => `, ${change.value === 'normal_vat' ? 'plătitor' : 'neplătitor'} de la ${change.effectiveFrom}`).join('')}.`,
    );
  });
}

/**
 * The special registration of art. 317 (`vat.eu`, `special`) for a company outside VAT that buys
 * services from a supplier established in another member state, or supplies services there to a
 * taxable person (alin. (1) lit. b)–c)): due before the first such operation; valid from the
 * request (norme pct. 90 alin. (4)). Services to or from outside the Union need no code.
 */
export function determineVatEu(context: DeterminationContext, rules: RuleContext): Determination {
  const year = context.year;
  const draft = new Draft('vat.eu', year, rules);
  const first = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  return guarded(draft, () => {
    const status = (date: string) => recordedAt(context.facts, 'vat.status', date);
    const outside =
      status(first) !== 'normal_vat' ||
      context.facts.some(
        (fact) =>
          fact.axis === 'vat.status' &&
          fact.value !== 'normal_vat' &&
          fact.effectiveFrom > first &&
          fact.effectiveFrom <= `${year}-12-31`,
      );
    if (!status(first) && !context.facts.some((fact) => fact.axis === 'vat.status'))
      return draft.needs(
        'Regimul TVA al companiei nu este înregistrat (vat.status).',
        factQuestionFrom('vat.status', first),
      );
    if (!outside)
      return draft.notApplicable(
        `Compania este înregistrată în scopuri de TVA tot anul ${year}: codul art. 316 servește operațiunilor intracomunitare.`,
      );
    const services = (context.activity.euServices ?? []).filter(
      (item) => item.date >= first && status(item.date) !== 'normal_vat',
    );
    const recorded = recordedAt(context.facts, 'vat.eu', `${year}-12-31`);
    if (!services.length) {
      if (!recorded)
        return draft.notApplicable(
          `Registrele nu au servicii intracomunitare ale firmei neînregistrate în ${year}.`,
        );
      draft.line(
        `Nicio factură de servicii intracomunitare în ${year}: faptul consemnat (${recorded}) rămâne.`,
      );
      return draft.finish('proposed', recorded, first, `Cod art. 317 în ${year}: ${recorded}.`);
    }
    draft.cite(code('art.317(1)'), code('norme.art.317.pct.90(4)'), code('art.325(1)'));
    const earliest = services[0]!;
    draft.inputs.firstOperation = {
      date: earliest.date,
      documentId: earliest.documentId,
      direction: earliest.direction,
    };
    draft.inputs.operations = services.length;
    draft.line(
      `Prima operațiune intracomunitară cu servicii a firmei neînregistrate în ${year}: factura ${earliest.number} din ${earliest.date}, ${earliest.direction === 'purchase' ? `serviciu primit de la un prestator din ${earliest.country} (art. 317 alin. (1) lit. c))` : `serviciu prestat unui beneficiar din ${earliest.country} (art. 317 alin. (1) lit. b))`}; în total ${services.length} facturi.`,
    );
    const atFirst = recordedAt(context.facts, 'vat.eu', earliest.date);
    if (atFirst === 'special') {
      const since = context.facts
        .filter((fact) => fact.axis === 'vat.eu' && fact.effectiveFrom <= earliest.date)
        .at(-1)!.effectiveFrom;
      const from = since > first ? since : first;
      draft.line(
        `Codul de TVA art. 317 este consemnat de la ${since}, înaintea primei operațiuni.`,
      );
      return draft.finish(
        'proposed',
        'special',
        from,
        `Cod art. 317 în ${year}: da, de la ${from}.`,
      );
    }
    draft.line(
      `Codul de TVA art. 317 trebuie solicitat înainte de ${earliest.date} și e valabil de la data cererii (norme pct. 90 alin. (4)); cu codul, firma depune D390 pentru aceste servicii (art. 325), iar TVA pentru serviciile primite o declară în D301 (art. 324).`,
    );
    return draft.finish(
      'proposed',
      'special',
      earliest.date,
      `Cod de TVA art. 317 necesar de la ${earliest.date}, prima operațiune intracomunitară cu servicii.`,
    );
  });
}

/** Every determination of a year, in axis order. */
export function determineYear(context: DeterminationContext, rules: RuleContext): Determination[] {
  return [
    determineIncomeTax(context, rules),
    determineVatPeriod(context, rules),
    determinePayrollPeriod(context, rules),
    determineSizeCategory(context, rules),
    determineVatThreshold(context, rules),
    determineCashVat(context, rules),
    determineVatStatus(context, rules),
    determineVatEu(context, rules),
    determineVatDistance(context, rules),
    determineVatOss(context, rules),
    determineVatIoss(context, rules),
    determineIntrastat(context, rules, 'arrivals'),
    determineIntrastat(context, rules, 'dispatches'),
  ];
}

// ---------------------------------------------------------------------------------------------
// Thresholds watched during the year

/** The share at which a threshold is reported before it is crossed: a product choice, not a
 * legal value. */
export const WATCH_PERCENT = 80;

export interface ThresholdWatch {
  /** The parameter whose value is watched. */
  key: string;
  axis: DeterminationAxis;
  year: number;
  /** In bani. */
  limit: bigint;
  value: bigint;
  /** Whole percent of the limit reached, rounded down. */
  percent: number;
  clauses: string[];
  message: string;
}

/**
 * The thresholds a company in its current regime is approaching or crossed in the year: the
 * micro-enterprise limit, the small-enterprise VAT threshold and the VAT on collection ceiling.
 * Only those at `WATCH_PERCENT` or more are returned.
 */
export function thresholdWatches(
  context: DeterminationContext,
  rules: RuleContext,
): ThresholdWatch[] {
  const year = context.year;
  const start = `${year}-01-01`;
  const at = context.today < `${year}-12-31` ? context.today : `${year}-12-31`;
  const watches: ThresholdWatch[] = [];
  const watch = (item: Omit<ThresholdWatch, 'percent' | 'year'>) => {
    if (item.limit <= 0n) return;
    const percent = Number((item.value * 100n) / item.limit);
    if (percent >= WATCH_PERCENT) watches.push({ ...item, year, percent });
  };
  const safe = <T>(run: () => T): T | null => {
    try {
      return run();
    } catch (error) {
      if (error instanceof RuleGapError) return null;
      throw error;
    }
  };
  if (recordedAt(context.facts, 'income_tax', at) === 'micro' && context.previous.eurRate.known) {
    const limit = safe(() =>
      rules.param<string>(
        'ro.micro.revenue_limit_eur',
        'reporting_period_start',
        start as LocalDate,
      ),
    );
    if (limit) {
      const value = context.activity.quarterTurnover.reduce((sum, item) => sum + item, 0n);
      const limitLei = euroInLei(limit, context.previous.eurRate.value);
      watch({
        key: 'ro.micro.revenue_limit_eur',
        axis: 'income_tax',
        limit: limitLei,
        value,
        clauses: [code('art.52(1),(5)')],
        message: `Cifra de afaceri cumulată din ${year}, ${lei(value)} lei, față de limita microîntreprinderii de ${lei(limitLei)} lei (${limit} €).`,
      });
    }
  }
  const status = recordedAt(context.facts, 'vat.status', at);
  if (status === 'non_vat') {
    const threshold = safe(() =>
      rules.param<string>(
        'ro.vat.exemption.threshold',
        'reporting_period_start',
        start as LocalDate,
      ),
    );
    if (threshold) {
      const value = context.activity.days.reduce((sum, day) => sum + day.exemption, 0n);
      watch({
        key: 'ro.vat.exemption.threshold',
        axis: 'vat.threshold',
        limit: BigInt(threshold) * 100n,
        value,
        clauses: [code('art.310(1)-(2),(6)')],
        message: `Livrările cu locul în România din ${year}, ${lei(value)} lei, față de plafonul de scutire de ${threshold} lei (art. 310).`,
      });
    }
  }
  if (status === 'normal_vat') {
    const distance = safe(() => distanceWatch(context, rules, at));
    if (distance) watch(distance);
    for (const intrastat of safe(() => intrastatWatches(context, rules)) ?? []) watch(intrastat);
  }
  if (status === 'normal_vat' && recordedAt(context.facts, 'vat.cash', at) === 'yes') {
    const ceiling = safe(() =>
      rules.param<string>('ro.vat.cash.ceiling', 'reporting_period_start', at as LocalDate),
    );
    if (ceiling) {
      const value = context.activity.days.reduce((sum, day) => sum + day.vat, 0n);
      watch({
        key: 'ro.vat.cash.ceiling',
        axis: 'vat.cash',
        limit: BigInt(ceiling) * 100n,
        value,
        clauses: [code('art.282(3^1)-(5)')],
        message: `Cifra de afaceri din ${year}, ${lei(value)} lei, față de plafonul TVA la încasare de ${ceiling} lei.`,
      });
    }
  }
  return watches;
}
