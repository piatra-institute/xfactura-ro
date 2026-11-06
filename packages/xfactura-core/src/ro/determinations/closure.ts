import { hashOf } from '../../hash';
import type { ProfileFact } from '../../kernel';
import type { QuestionRequest } from '../../questions/kinds';
import { individualForms, type EntityForm } from '../entity';
import { euVatPrefixes } from '../geo';
import type { ObligationKind } from '../obligations';
import { d112Filing } from '../payroll/quarterly';
import type { LocalDate } from '../../time';
import { provisionalProrata } from '../exempt/facts';
import { d406Begun, type D406StartAt } from '../saft/applicability';
import { ossClosureRules } from '../oss/closure';
import { tradeClosureRules } from '../trade/closure';
import {
  confirmQuestion,
  factQuestion,
  figuresQuestion,
  recordedAt,
  recordedInYear,
  yearlyAxes,
  type Determination,
  type DeterminationAxis,
} from './determine';

/*
 * The obligation closure (docs/CONFORMANCE.md, "Obligation closure and negative eligibility"):
 * from a company's recorded facts, its yearly determinations and what its books show over a
 * range of months, which returns apply, which facts are unknown (NEEDS_EVIDENCE, each naming the
 * question to ask), and which known cases the engine does not cover (UNSUPPORTED). Rules run to a
 * fixed point: a rule fires once every slot it reads is derived; a rule that never can is a named
 * gap, never a pass. Each item records the rule and the slots, with their basis, it came from.
 */

export const CLOSURE_VERSION = 'ro-closure@8';

export type ClosureStatus = 'ELIGIBLE' | 'NEEDS_EVIDENCE' | 'UNSUPPORTED';

/** What the books show over the range, as the engine reads it. */
export interface ClosureBooks {
  /** The first day the books cover: the start of the company's first financial year (the
   * earliest by its start). The months before it have no returns and no needs; a first year
   * starting mid-month covers that month. Null when the company keeps no financial year. */
  firstDay: string | null;
  /** The last day of each financial year the engine keeps. */
  financialYearEnds: readonly string[];
  /** Months with an employment contract running. */
  employmentMonths: readonly string[];
  /** Months with sick leave or a contract ended: a quarterly D112 is due monthly then (art. 147
   * alin. (11)). */
  payrollEventMonths: readonly string[];
  /** Months with services across the EU border, supplied or bought, and intra-community
   * supplies and acquisitions of goods (D390). */
  euServiceMonths: readonly string[];
  /** Months with supplies exempt without the right of deduction (EX-292): the company is mixed
   * and applies a pro-rata (art. 300). */
  exemptNoDeductionMonths?: readonly string[];
  /** Months with dividend tax withheld. */
  dividendMonths: readonly string[];
  /** The other taxes withheld at source (O1), by month and the return that declares their
   * beneficiaries: D205 (interest, rent paid to residents), D207 (non-residents), D112
   * (intellectual property, not written yet). */
  withholdings?: readonly { month: string; annual: 'D205' | 'D207' | 'D112' }[];
  /** Invoices received from suppliers outside Romania; `reverseCharge` when booked as services
   * under the general rule (an RC-… tax entry). */
  foreignPurchases: readonly {
    month: string;
    documentId: string;
    country: string;
    reverseCharge?: boolean;
  }[];
  /** The services bought from abroad with the VAT owed by the company (RC-… output entries), by
   * tax point: outside VAT they are declared in D301 (art. 324). */
  reverseCharges?: readonly { date: string; documentId: string; code: string }[];
  /** Months with lines on stock accounts (class 3), a dealer's items under the margin scheme
   * (on 371, each its purchase document) left out. */
  stockMonths: readonly string[];
  /** Months with production postings (G4): lines tagged by a work order, its work in progress or
   * its price differences. */
  productionMonths?: readonly string[];
  /** The special VAT schemes the books show (V4), by month: a travel agency's margins and sales
   * (`travel`), a dealer's items bought or sold under the margin scheme (`goods`), purchases
   * under the agricultural flat rate (`flat_rate`). */
  schemes?: readonly { month: string; scheme: 'travel' | 'goods' | 'flat_rate' }[];
  /** Months with sponsorship expenses (6582). */
  sponsorshipMonths: readonly string[];
  /** Months with payroll taxes booked (444, 431x, 436) and no employment contract running. */
  payrollWithoutContractMonths: readonly string[];
  /** A PFA's, II's or IF's income sources, per year. */
  incomeSources: readonly { year: string; count: number; real: boolean }[];
  /** The years (YYYY) a fixed asset was held: a card of the register, or a balance or movement
   * on a tangible asset account (21x). */
  assetYears: readonly string[];
  /** The half-year report's decision for each year the range touches (`ro.halfyear.report`,
   * core `annual/half-year.ts`): owed, not owed, unknown with what it lacks, or a rule gap. */
  halfYear?: readonly {
    year: string;
    status: 'required' | 'none' | 'unknown' | 'gap';
    due: string | null;
    message: string;
    missing: readonly string[];
  }[];
}

export interface ClosureInput {
  /** The first and last month (YYYY-MM). */
  interval: { from: string; to: string };
  /** The recorded profile facts, superseded ones left out, in effect order. */
  facts: readonly ProfileFact[];
  /** The determinations of every year the range touches (`determineYear`). */
  determinations: readonly Determination[];
  /** The fingerprint each yearly fact was confirmed against, by `<axis>/<year>`. */
  confirmed: Readonly<Record<string, string>>;
  books: ClosureBooks;
  /** `ro.d406.start` for each month of the years the range touches (`d406StartOf`): from when
   * each taxpayer category files D406, or the rule gap. */
  d406Start: Readonly<Record<string, D406StartAt>>;
}

export interface Need {
  /** `<question kind>|<subject kind>:<subject id>`. */
  id: string;
  code: 'FACT_UNKNOWN' | 'DETERMINATION_MISSING' | 'DETERMINATION_CONFLICT' | 'INPUT_UNKNOWN';
  /** The fact it is about (`vat.status`, `vat.period/2026`). */
  fact: string;
  message: string;
  question: QuestionRequest;
  rules: string[];
}

export interface Unsupported {
  trigger: string;
  message: string;
  missingCapabilities: string[];
  evidenceIds: string[];
  rule: string;
  resolution: string;
}

export interface ClosureObligation {
  /** The return: D300, D112, S1005… or a statement the engine does not prepare. */
  kind: string;
  /** The deadline parameter; null for a return the engine does not cover. */
  deadline: ObligationKind | null;
  period: string;
  /** The period the deadline counts from, when not the return's own (a quarterly D112's
   * month is due after the quarter). */
  deadlinePeriod: string | null;
  state: 'applies' | 'needs_evidence' | 'unsupported';
  rule: string;
  clauses: string[];
  /** The slots read, with their value and basis. */
  facts: string[];
  /** The needs (ids) or unsupported triggers blocking it. */
  blockers: string[];
}

export interface ClosureGap {
  code: 'CYCLE' | 'UNRESOLVED';
  rules: string[];
  slots: string[];
  message: string;
}

export interface Closure {
  version: string;
  /** A hash of the rule set: what changes when a rule changes. */
  rulesHash: string;
  interval: { from: string; to: string };
  status: ClosureStatus;
  obligations: ClosureObligation[];
  needs: Need[];
  unsupported: Unsupported[];
  gaps: ClosureGap[];
  trace: { rule: string; iteration: number; read: string[]; produced: string[] }[];
}

/** A derived slot: a value, unknown (with the needs), or unsupported. */
export type Slot =
  | { state: 'known'; value: string; basis: string }
  | { state: 'unknown'; needs: string[] }
  | { state: 'unsupported'; triggers: string[] };

export interface Emitter {
  derive(key: string, slot: Slot): void;
  obligation(item: Omit<ClosureObligation, 'rule' | 'clauses' | 'facts'>): void;
  /** Records a need and returns its id. */
  need(need: Omit<Need, 'id' | 'rules'>): string;
  /** Records an unsupported case and returns its trigger. */
  unsupported(item: Omit<Unsupported, 'rule'>): string;
}

export interface ClosureRule {
  id: string;
  clauses: readonly string[];
  /** The slots it reads: it fires once they are all derived. */
  reads: readonly string[];
  /** The slots it derives. */
  derives: readonly string[];
  run(read: (key: string) => Slot, emit: Emitter): void;
}

/** What the evaluation of a rule set produced. */
export interface Evaluation {
  slots: Map<string, Slot>;
  obligations: ClosureObligation[];
  needs: Map<string, Need>;
  unsupported: Map<string, Unsupported>;
  gaps: ClosureGap[];
  trace: Closure['trace'];
}

const show = (key: string, slot: Slot) =>
  slot.state === 'known'
    ? `${key}=${slot.value} (${slot.basis})`
    : slot.state === 'unknown'
      ? `${key}=?`
      : `${key}=UNSUPPORTED`;

/**
 * Runs rules to a fixed point: each pass fires every rule whose reads are all derived, until a
 * pass fires none. Rules left are gaps: a cycle when what they read is derived by another rule
 * left, unresolved when nothing derives it.
 */
export function evaluateRules(rules: readonly ClosureRule[]): Evaluation {
  const slots = new Map<string, Slot>();
  const obligations: ClosureObligation[] = [];
  const needs = new Map<string, Need>();
  const unsupported = new Map<string, Unsupported>();
  const trace: Closure['trace'] = [];
  let pending = [...rules];
  for (let iteration = 0; pending.length; iteration++) {
    const ready = pending.filter((rule) => rule.reads.every((key) => slots.has(key)));
    if (!ready.length) break;
    for (const rule of ready) {
      const produced: string[] = [];
      const read = (key: string) => {
        const slot = slots.get(key);
        if (!slot) throw new Error(`${rule.id} reads ${key}, which it did not declare.`);
        return slot;
      };
      rule.run(read, {
        derive(key, slot) {
          if (!rule.derives.includes(key))
            throw new Error(`${rule.id} derives ${key}, which it did not declare.`);
          slots.set(key, slot);
          produced.push(show(key, slot));
        },
        obligation(item) {
          obligations.push({
            ...item,
            rule: rule.id,
            clauses: [...rule.clauses],
            facts: rule.reads.map((key) => show(key, slots.get(key)!)),
          });
          produced.push(`${item.kind} ${item.period} ${item.state}`);
        },
        need(item) {
          const id = `${item.question.kind}|${item.question.subject.kind}:${item.question.subject.id}`;
          const existing = needs.get(id);
          if (existing) {
            if (!existing.rules.includes(rule.id)) existing.rules.push(rule.id);
          } else needs.set(id, { ...item, id, rules: [rule.id] });
          produced.push(`need ${id}`);
          return id;
        },
        unsupported(item) {
          if (!unsupported.has(item.trigger))
            unsupported.set(item.trigger, { ...item, rule: rule.id });
          else {
            const known = unsupported.get(item.trigger)!;
            known.evidenceIds = [...new Set([...known.evidenceIds, ...item.evidenceIds])];
          }
          produced.push(`unsupported ${item.trigger}`);
          return item.trigger;
        },
      });
      trace.push({
        rule: rule.id,
        iteration,
        read: rule.reads.map((key) => show(key, slots.get(key)!)),
        produced,
      });
    }
    pending = pending.filter((rule) => !ready.includes(rule));
  }
  const gaps: ClosureGap[] = [];
  if (pending.length) {
    const derivedByPending = new Set(pending.flatMap((rule) => rule.derives));
    const missing = (rule: ClosureRule) => rule.reads.filter((key) => !slots.has(key));
    const cyclic = pending.filter((rule) => missing(rule).some((key) => derivedByPending.has(key)));
    const unresolved = pending.filter((rule) => !cyclic.includes(rule));
    if (cyclic.length)
      gaps.push({
        code: 'CYCLE',
        rules: cyclic.map((rule) => rule.id),
        slots: [...new Set(cyclic.flatMap(missing))],
        message: `Regulile ${cyclic.map((rule) => rule.id).join(', ')} depind una de alta: aplicabilitatea lor nu se poate stabili.`,
      });
    if (unresolved.length)
      gaps.push({
        code: 'UNRESOLVED',
        rules: unresolved.map((rule) => rule.id),
        slots: [...new Set(unresolved.flatMap(missing))],
        message: `Nicio regulă nu stabilește ${[...new Set(unresolved.flatMap(missing))].join(', ')}.`,
      });
  }
  return { slots, obligations, needs, unsupported, gaps, trace };
}

// ---------------------------------------------------------------------------------------------
// The Romanian rules

const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (month: string) => {
  const [year, number] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};
const quarterLabel = (month: string) =>
  `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
const isQuarterEnd = (month: string) => Number(month.slice(5, 7)) % 3 === 0;
const CODE = 'ANAF/Cod-fiscal-consolidat';
/** What blocks a slot: its needs (ids) or its unsupported triggers. */
const blockersOf = (slot: Slot) =>
  slot.state === 'unknown' ? slot.needs : slot.state === 'unsupported' ? slot.triggers : [];

const factNeed = (emit: Emitter, axis: string, message: string) =>
  emit.need({
    code: 'FACT_UNKNOWN',
    fact: axis,
    message,
    question: { kind: 'profile.fact', subject: { kind: 'profile', id: axis }, params: { axis } },
  });

const previousDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * A determination that holds until changed (`vat.status`, `vat.eu`) against the recorded fact at
 * a month's end: the need to confirm it when they differ and nobody confirmed this computation;
 * null when they agree, or before the computed value starts.
 */
function heldConflict(
  input: ClosureInput,
  emit: Emitter,
  axis: 'vat.status' | 'vat.eu',
  month: string,
  label: string,
): string | null {
  const year = Number(month.slice(0, 4));
  const end = lastDay(month);
  const determination = input.determinations.find(
    (item) => item.axis === axis && item.year === year && item.status === 'proposed',
  );
  if (!determination || end < determination.effectiveFrom) return null;
  const computed =
    determination.changes.filter((change) => change.effectiveFrom <= end).at(-1)?.value ??
    determination.value;
  const recorded = recordedAt(input.facts, axis, end);
  if (computed === recorded || input.confirmed[`${axis}/${year}`] === determination.fingerprint)
    return null;
  return emit.need({
    code: 'DETERMINATION_CONFLICT',
    fact: `${axis}/${year}`,
    message: `${label} înregistrat pentru ${month} („${recorded ?? '—'}”) diferă de calcul („${computed}”): ${determination.summary}`,
    question: confirmQuestion(determination),
  });
}

/** The months of the range. */
function monthsOf(interval: ClosureInput['interval']) {
  const months: string[] = [];
  for (let y = Number(interval.from.slice(0, 4)), m = Number(interval.from.slice(5, 7)); ;) {
    const label = `${y}-${pad(m)}`;
    if (label > interval.to) break;
    months.push(label);
    if (++m === 13) [y, m] = [y + 1, 1];
  }
  return months;
}

/**
 * The slot of a yearly determination at a month: the recorded fact effective within the year
 * (a fact carried from an earlier year is not this year's determination); a need when none is
 * recorded or when it differs from the computation it was not confirmed against.
 */
function yearlySlot(
  input: ClosureInput,
  emit: Emitter,
  axis: DeterminationAxis,
  month: string,
  label: string,
): Slot {
  const year = Number(month.slice(0, 4));
  const end = lastDay(month);
  const determination = input.determinations.find(
    (item) => item.axis === axis && item.year === year,
  );
  if (determination?.status === 'unsupported' && determination.unsupported)
    return {
      state: 'unsupported',
      triggers: [
        emit.unsupported({
          trigger: determination.unsupported.trigger,
          message: determination.unsupported.message,
          missingCapabilities: determination.unsupported.capabilities,
          evidenceIds: [],
          resolution:
            'Acoperire revizuită pentru acest caz sau ținerea lui în afara aplicației, atribuită explicit.',
        }),
      ],
    };
  const recorded = recordedInYear(input.facts, axis, year, end);
  const ask = (code: Need['code'], message: string): Slot => {
    const questions: QuestionRequest[] =
      determination?.status === 'proposed'
        ? [confirmQuestion(determination)]
        : determination?.status === 'needs_evidence' && determination.questions.length
          ? determination.questions
          : [factQuestion(axis, year)];
    return {
      state: 'unknown',
      needs: questions.map((question) =>
        emit.need({ code, fact: `${axis}/${year}`, message, question }),
      ),
    };
  };
  if (!recorded)
    return ask(
      'DETERMINATION_MISSING',
      `${label} pentru ${year} nu este stabilit${determination?.status === 'proposed' ? `: calculul propune „${determination.value}”, de confirmat` : determination?.status === 'needs_evidence' ? `: ${determination.summary}` : ''}.`,
    );
  if (determination?.status === 'proposed') {
    const computed =
      determination.changes.filter((change) => change.effectiveFrom <= end).at(-1)?.value ??
      determination.value;
    if (computed !== recorded && input.confirmed[`${axis}/${year}`] !== determination.fingerprint)
      return ask(
        'DETERMINATION_CONFLICT',
        `${label} înregistrat pentru ${month} („${recorded}”) diferă de calcul („${computed}”): ${determination.summary}`,
      );
  }
  return { state: 'known', value: recorded, basis: `fapt ${axis} ${year}` };
}

/** Builds the rules for a range of months. */
export function closureRules(input: ClosureInput): ClosureRule[] {
  const books = input.books;
  // Only the months the books cover: before the company's first financial year there are no
  // returns to list and no facts to ask (its facts are recorded from the books' start), nor the
  // annual returns of a year before it (D212, D205, S1005…). A company that keeps no financial
  // year at all is not restricted: every month of the range is read from its facts alone.
  const first = books.firstDay?.slice(0, 7) ?? null;
  const months = monthsOf(input.interval).filter((month) => first === null || month >= first);
  const years = [...new Set(months.map((month) => Number(month.slice(0, 4))))];
  const facts = input.facts;
  const rules: ClosureRule[] = [];

  for (const month of months) {
    const end = lastDay(month);
    const year = Number(month.slice(0, 4));
    rules.push({
      id: `fact.entity.form@${month}`,
      clauses: [],
      reads: [],
      derives: [`form@${month}`],
      run(_read, emit) {
        const value = recordedAt(facts, 'entity.form', end);
        emit.derive(
          `form@${month}`,
          value
            ? { state: 'known', value, basis: 'fapt entity.form' }
            : {
                state: 'unknown',
                needs: [
                  factNeed(emit, 'entity.form', 'Forma juridică a companiei nu este înregistrată.'),
                ],
              },
        );
      },
    });
    rules.push({
      id: `fact.books.system@${month}`,
      clauses: ['OUG44/2008:art.15', 'OMFP170/2015:art.2-5'],
      reads: [`form@${month}`],
      derives: [`books@${month}`],
      run(read, emit) {
        const form = read(`form@${month}`);
        const recorded = recordedAt(facts, 'books.system', end);
        // A PFA's, II's or IF's option for double entry (OMFP nr. 170/2015 art. 3–5) against OUG
        // nr. 44/2008 art. 15 ("vor ține contabilitatea în partidă simplă"): recorded, not covered.
        if (
          recorded === 'double' &&
          form.state === 'known' &&
          individualForms.includes(form.value as EntityForm)
        ) {
          emit.derive(`books@${month}`, {
            state: 'unsupported',
            triggers: [
              emit.unsupported({
                trigger: 'PFA_DOUBLE_ENTRY',
                message:
                  'O PFA, II sau IF a înregistrat opțiunea pentru contabilitatea în partidă dublă: OUG nr. 44/2008 art. 15 prevede partida simplă, OMFP nr. 170/2015 art. 3 admite opțiunea „cu excepția cazurilor în care … alte acte normative prevăd expres” partida simplă; registrele în partidă dublă ale unei persoane fizice nu sunt acoperite.',
                missingCapabilities: ['PFA_DOUBLE_ENTRY'],
                evidenceIds: [],
                resolution:
                  'Expertul contabil decide dacă opțiunea este admisă; până atunci registrele în partidă dublă se țin în afara aplicației, atribuit explicit.',
              }),
            ],
          });
          return;
        }
        emit.derive(
          `books@${month}`,
          recorded
            ? { state: 'known', value: recorded, basis: 'fapt books.system' }
            : form.state !== 'known'
              ? form
              : {
                  state: 'known',
                  value: individualForms.includes(form.value as EntityForm) ? 'single' : 'double',
                  basis: 'forma juridică (Legea nr. 82/1991; OUG nr. 44/2008 art. 15)',
                },
        );
      },
    });
    rules.push({
      id: `fact.vat.status@${month}`,
      clauses: [`${CODE}:art.316(1)(b),(1^1)`, `${CODE}:art.310(7)`],
      reads: [],
      derives: [`vat@${month}`],
      run(_read, emit) {
        const value = recordedAt(facts, 'vat.status', end);
        // A registration the threshold made due, or a deregistration, that the recorded facts
        // contradict: asked, never assumed either way. Without the year's `vat.status`
        // determination, the threshold's crossing alone asks for the registration.
        const year = Number(month.slice(0, 4));
        const crossed = input.determinations
          .find((item) => item.axis === 'vat.threshold' && item.year === year)
          ?.changes.find((change) => change.value === 'exceeded' && change.effectiveFrom <= end);
        const conflict =
          value &&
          (input.determinations.some((item) => item.axis === 'vat.status' && item.year === year)
            ? heldConflict(input, emit, 'vat.status', month, 'Regimul TVA')
            : crossed && value !== 'normal_vat'
              ? emit.need({
                  code: 'DETERMINATION_CONFLICT',
                  fact: 'vat.status',
                  message: `Plafonul de scutire este depășit la ${crossed.effectiveFrom}: înregistrarea în scopuri de TVA se solicită cel târziu atunci și este valabilă de la această dată (art. 316 alin. (1) lit. b), alin. (1^1) lit. b)); regimul înregistrat este „${value}”.`,
                  question: {
                    kind: 'profile.fact',
                    subject: { kind: 'profile', id: 'vat.status' },
                    params: { axis: 'vat.status', from: crossed.effectiveFrom },
                  },
                })
              : null);
        emit.derive(
          `vat@${month}`,
          conflict
            ? { state: 'unknown', needs: [conflict] }
            : value
              ? { state: 'known', value, basis: 'fapt vat.status' }
              : {
                  state: 'unknown',
                  needs: [
                    factNeed(emit, 'vat.status', 'Regimul TVA al companiei nu este înregistrat.'),
                  ],
                },
        );
      },
    });
    rules.push({
      id: `fact.vat.period@${month}`,
      clauses: [`${CODE}:art.322(2)-(6)`],
      reads: [`vat@${month}`],
      derives: [`vatPeriod@${month}`],
      run(read, emit) {
        const vat = read(`vat@${month}`);
        emit.derive(
          `vatPeriod@${month}`,
          vat.state !== 'known'
            ? vat
            : vat.value !== 'normal_vat'
              ? { state: 'known', value: 'none', basis: 'neplătitor de TVA' }
              : yearlySlot(input, emit, 'vat.period', month, 'Perioada fiscală de TVA'),
        );
      },
    });
    rules.push({
      id: `fact.vat.eu@${month}`,
      clauses: [`${CODE}:art.317`],
      reads: [`vat@${month}`],
      derives: [`vatEu@${month}`],
      run(read, emit) {
        const vat = read(`vat@${month}`);
        if (vat.state !== 'known' || vat.value === 'normal_vat') {
          emit.derive(
            `vatEu@${month}`,
            vat.state === 'known'
              ? { state: 'known', value: 'n/a', basis: 'plătitor de TVA' }
              : vat,
          );
          return;
        }
        const value = recordedAt(facts, 'vat.eu', end);
        // The special code the books' EU services require (determination `vat.eu`), against the
        // recorded fact: a conflict is asked. With the code, D301 and D390 are covered.
        const conflict = heldConflict(input, emit, 'vat.eu', month, 'Codul de TVA art. 317');
        emit.derive(
          `vatEu@${month}`,
          conflict
            ? { state: 'unknown', needs: [conflict] }
            : !value
              ? {
                  state: 'unknown',
                  needs: [
                    factNeed(
                      emit,
                      'vat.eu',
                      'Nu este înregistrat dacă firma neplătitoare de TVA are cod de TVA pentru operațiuni intracomunitare (art. 317).',
                    ),
                  ],
                }
              : { state: 'known', value, basis: 'fapt vat.eu' },
        );
      },
    });
    rules.push({
      id: `fact.employer@${month}`,
      clauses: [],
      reads: [],
      derives: [`employer@${month}`],
      run(_read, emit) {
        if (books.employmentMonths.includes(month)) {
          emit.derive(`employer@${month}`, {
            state: 'known',
            value: 'yes',
            basis: 'contractele de muncă din registre',
          });
          return;
        }
        const value = recordedAt(facts, 'employer', end);
        emit.derive(
          `employer@${month}`,
          value
            ? { state: 'known', value, basis: 'fapt employer' }
            : {
                state: 'unknown',
                needs: [
                  factNeed(emit, 'employer', 'Nu este înregistrat dacă firma are salariați.'),
                ],
              },
        );
      },
    });
    rules.push({
      id: `fact.payroll.period@${month}`,
      clauses: [`${CODE}:art.80(2)-(3)`, `${CODE}:art.147(4)-(10)`],
      reads: [`employer@${month}`],
      derives: [`payrollPeriod@${month}`],
      run(read, emit) {
        const employer = read(`employer@${month}`);
        emit.derive(
          `payrollPeriod@${month}`,
          employer.state !== 'known'
            ? employer
            : employer.value !== 'yes'
              ? { state: 'known', value: 'none', basis: 'fără salariați' }
              : yearlySlot(input, emit, 'payroll.period', month, 'Perioada declarației 112'),
        );
      },
    });
    rules.push({
      id: `fact.income_tax@${month}`,
      clauses: [`${CODE}:art.47(1)(c)`, `${CODE}:art.48(1)-(2^1)`],
      reads: [`form@${month}`],
      derives: [`incomeTax@${month}`],
      run(read, emit) {
        const form = read(`form@${month}`);
        emit.derive(
          `incomeTax@${month}`,
          form.state !== 'known'
            ? form
            : individualForms.includes(form.value as EntityForm)
              ? { state: 'known', value: 'none', basis: 'impozit pe venit (titlul IV)' }
              : yearlySlot(input, emit, 'income_tax', month, 'Impozitul pe profit sau micro'),
        );
      },
    });

    // Returns.
    // Leaving VAT during the month (art. 310 alin. (7), art. 316 alin. (13)): the last return
    // covers the period up to the day before the cancellation, whatever the VAT period, and is due
    // by the 25th of the month after the one the decision was communicated in.
    const lastReturns = (emit: Emitter) => {
      const cancelled = facts
        .filter(
          (fact) =>
            fact.axis === 'vat.status' &&
            fact.value !== 'normal_vat' &&
            fact.effectiveFrom >= `${month}-01` &&
            fact.effectiveFrom <= end &&
            recordedAt(facts, 'vat.status', previousDay(fact.effectiveFrom)) === 'normal_vat',
        )
        .at(-1);
      if (!cancelled) return;
      const last = previousDay(cancelled.effectiveFrom);
      const lastMonth = last.slice(0, 7);
      const kind = recordedAt(facts, 'vat.period', last);
      if (!kind) {
        const need = factNeed(
          emit,
          'vat.period',
          'Perioada fiscală de TVA de dinaintea anulării înregistrării nu este înregistrată.',
        );
        for (const item of ['D300', 'D394'] as const)
          emit.obligation({
            kind: item,
            deadline: item,
            period: lastMonth,
            deadlinePeriod: month,
            state: 'needs_evidence',
            blockers: [need],
          });
        return;
      }
      const quarterly = kind === 'quarterly';
      // A monthly period ended the month before: that month's own return is the last one.
      if (lastMonth !== month && (!quarterly || isQuarterEnd(lastMonth))) return;
      for (const item of ['D300', 'D394'] as const)
        emit.obligation({
          kind: item,
          deadline: item,
          period: quarterly ? quarterLabel(lastMonth) : lastMonth,
          deadlinePeriod: month,
          state: 'applies',
          blockers: [],
        });
    };
    rules.push({
      id: `obligation.vat@${month}`,
      clauses: [`${CODE}:art.323(1)`, 'OPANAF2328/2016:art.I', `${CODE}:art.316(11)(g),(13)`],
      reads: [`vat@${month}`, `vatPeriod@${month}`],
      derives: [],
      run(read, emit) {
        const vat = read(`vat@${month}`);
        const period = read(`vatPeriod@${month}`);
        if (vat.state !== 'known' || (vat.value === 'normal_vat' && period.state !== 'known')) {
          const blockers = [...blockersOf(vat), ...blockersOf(period)];
          for (const kind of ['D300', 'D394'] as const)
            emit.obligation({
              kind,
              deadline: kind,
              period: month,
              deadlinePeriod: null,
              state:
                vat.state === 'unsupported' || period.state === 'unsupported'
                  ? 'unsupported'
                  : 'needs_evidence',
              blockers,
            });
          return;
        }
        if (vat.value !== 'normal_vat') {
          lastReturns(emit);
          return;
        }
        if (period.state !== 'known') return;
        const quarterly = period.value === 'quarterly';
        if (quarterly && !isQuarterEnd(month)) return;
        const label = quarterly ? quarterLabel(month) : month;
        for (const kind of ['D300', 'D394'] as const)
          emit.obligation({
            kind,
            deadline: kind,
            period: label,
            deadlinePeriod: null,
            state: 'applies',
            blockers: [],
          });
      },
    });
    rules.push({
      id: `fact.d406.start@${month}`,
      clauses: ['OPANAF407/2025:anexa5.pct.1-2'],
      reads: [`form@${month}`],
      derives: [`d406Begun@${month}`],
      run(read, emit) {
        const form = read(`form@${month}`);
        const at = input.d406Start[month];
        emit.derive(
          `d406Begun@${month}`,
          form.state !== 'known'
            ? form
            : individualForms.includes(form.value as EntityForm)
              ? { state: 'known', value: 'exempt', basis: 'PFA, II sau IF (anexa nr. 5 pct. 4)' }
              : !at || 'gap' in at
                ? {
                    state: 'unsupported',
                    triggers: [
                      emit.unsupported({
                        trigger: 'RULE_GAP',
                        message: `Data de la care se depune D406 nu este în registru pentru ${month}: ${at && 'gap' in at ? at.gap : 'ro.d406.start'}`,
                        missingCapabilities: ['ro.d406.start'],
                        evidenceIds: [],
                        resolution: 'Parametrul ro.d406.start revizuit pentru perioadă.',
                      }),
                    ],
                  }
                : (() => {
                    const begun = d406Begun(facts, at.start, end);
                    return begun.state === 'known'
                      ? {
                          state: 'known' as const,
                          value: begun.value ? 'yes' : 'no',
                          basis: begun.basis,
                        }
                      : {
                          state: 'unknown' as const,
                          needs: [factNeed(emit, 'taxpayer.category', begun.message)],
                        };
                  })(),
        );
      },
    });
    rules.push({
      id: `obligation.d406@${month}`,
      clauses: ['OPANAF1783/2021:anexa4.pct.1-4', 'OPANAF407/2025:anexa5.pct.4'],
      reads: [`vat@${month}`, `vatPeriod@${month}`, `form@${month}`, `d406Begun@${month}`],
      derives: [],
      run(read, emit) {
        const vat = read(`vat@${month}`);
        const period = read(`vatPeriod@${month}`);
        const form = read(`form@${month}`);
        // Before the company's category files (anexa nr. 5 pct. 1.1), no D406; while that is
        // unknown, it waits on the category.
        const begun = read(`d406Begun@${month}`);
        if (begun.state === 'known' && begun.value === 'no') return;
        // A company's D406: with each VAT period, quarterly outside VAT; each month while the VAT
        // status or period is unknown (it decides the period, never whether D406 is due).
        const quarterly =
          vat.state === 'known' &&
          (vat.value !== 'normal_vat' ||
            (period.state === 'known' && period.value === 'quarterly'));
        let due: Pick<ClosureObligation, 'period' | 'state' | 'blockers'> | null = null;
        if (vat.state !== 'known' || (vat.value === 'normal_vat' && period.state !== 'known'))
          due = {
            period: month,
            state:
              vat.state === 'unsupported' || period.state === 'unsupported'
                ? 'unsupported'
                : 'needs_evidence',
            blockers: [...blockersOf(vat), ...blockersOf(period)],
          };
        else if (!quarterly) due = { period: month, state: 'applies', blockers: [] };
        else if (isQuarterEnd(month))
          due = { period: quarterLabel(month), state: 'applies', blockers: [] };
        if (!due) return;
        const item = { kind: 'D406', deadline: 'D406', deadlinePeriod: null } as const;
        if (
          form.state === 'known' &&
          !individualForms.includes(form.value as EntityForm) &&
          begun.state !== 'known'
        ) {
          emit.obligation({
            ...item,
            period: due.period,
            state:
              due.state === 'unsupported' || begun.state === 'unsupported'
                ? 'unsupported'
                : 'needs_evidence',
            blockers: [...new Set([...due.blockers, ...blockersOf(begun)])],
          });
          return;
        }
        if (form.state === 'known' && !individualForms.includes(form.value as EntityForm)) {
          // Sales in the Union scheme (V4) are D398's, and D406 reports them too, under 310340
          // at each consumer state's rate (`ro.d406.oss`): a period with them is covered.
          emit.obligation({ ...item, ...due });
          return;
        }
        // A PFA, II or IF does not file D406: OPANAF nr. 1.783/2021 anexa nr. 5 pct. 4 lit. a)–c)
        // exempts them in every version (OPANAF nr. 373/2022, 2.518/2022 and 407/2025).
        if (form.state === 'known') return;
        // The form unknown: a company's return or an open question, it waits on the form.
        emit.obligation({
          ...item,
          period: due.period,
          state: due.state === 'unsupported' ? 'unsupported' : 'needs_evidence',
          blockers: [...due.blockers, ...blockersOf(form)],
        });
      },
    });
    if (books.euServiceMonths.includes(month))
      rules.push({
        id: `obligation.d390@${month}`,
        clauses: ['OPANAF591/2016:anexa4.pct.1.1', `${CODE}:art.325(1)`],
        reads: [`vat@${month}`, `vatEu@${month}`],
        derives: [],
        run(read, emit) {
          const vat = read(`vat@${month}`);
          const code = read(`vatEu@${month}`);
          // Outside VAT, D390 is the art. 317 code holder's (art. 325 alin. (1)).
          if (vat.state === 'known' && vat.value !== 'normal_vat') {
            if (code.state === 'known' && code.value === 'special') {
              emit.obligation({
                kind: 'D390',
                deadline: 'D390',
                period: month,
                deadlinePeriod: null,
                state: 'applies',
                blockers: [],
              });
              return;
            }
            emit.obligation({
              kind: 'D390',
              deadline: code.state === 'known' ? null : 'D390',
              period: month,
              deadlinePeriod: null,
              state: code.state === 'known' ? 'unsupported' : 'needs_evidence',
              blockers:
                code.state === 'known'
                  ? [
                      emit.unsupported({
                        trigger: 'EU_SERVICES_NON_VAT',
                        message: `Servicii intracomunitare în ${month} ale unei firme neînregistrate în scopuri de TVA, fără cod de TVA după art. 317: codul se solicita înaintea operațiunii (art. 317 alin. (1) lit. b)–c)); fără el D390 nu se poate depune.`,
                        missingCapabilities: ['VAT_ART317_REGISTRATION'],
                        evidenceIds: [],
                        resolution:
                          'Solicitați codul de TVA art. 317 și înregistrați-l (vat.eu special, cu documentul), sau tratați operațiunile în afara aplicației, atribuit explicit.',
                      }),
                    ]
                  : blockersOf(code),
            });
            return;
          }
          emit.obligation({
            kind: 'D390',
            deadline: 'D390',
            period: month,
            deadlinePeriod: null,
            state: vat.state === 'known' ? 'applies' : 'needs_evidence',
            blockers: vat.state === 'unknown' ? vat.needs : [],
          });
        },
      });
    const special = (books.reverseCharges ?? []).filter(
      (item) =>
        item.date.startsWith(month) && recordedAt(facts, 'vat.status', item.date) !== 'normal_vat',
    );
    if (special.length)
      rules.push({
        id: `obligation.d301@${month}`,
        clauses: [`${CODE}:art.307(2)`, `${CODE}:art.324(1)-(2)`, 'OPANAF592/2016:anexa2.pct.I'],
        reads: [`vat@${month}`],
        derives: [],
        run(read, emit) {
          // The VAT a non-payer owes on services bought from abroad: the special return, whether
          // or not it holds the art. 317 code (OPANAF nr. 592/2016, section 4).
          const vat = read(`vat@${month}`);
          emit.obligation({
            kind: 'D301',
            deadline: 'D301',
            period: month,
            deadlinePeriod: null,
            state: vat.state === 'unsupported' ? 'unsupported' : 'applies',
            blockers: vat.state === 'unsupported' ? vat.triggers : [],
          });
        },
      });
    rules.push({
      id: `obligation.d112@${month}`,
      clauses: [`${CODE}:art.147(1)`, `${CODE}:art.147(4)-(10)`],
      reads: [`employer@${month}`, `payrollPeriod@${month}`],
      derives: [],
      run(read, emit) {
        const employer = read(`employer@${month}`);
        const period = read(`payrollPeriod@${month}`);
        if (employer.state === 'known' && employer.value !== 'yes') return;
        if (employer.state !== 'known' || period.state !== 'known') {
          const blockers = [employer, period].flatMap((slot) =>
            slot.state === 'unknown'
              ? slot.needs
              : slot.state === 'unsupported'
                ? slot.triggers
                : [],
          );
          emit.obligation({
            kind: 'D112',
            deadline: 'D112',
            period: month,
            deadlinePeriod: null,
            state: 'needs_evidence',
            blockers,
          });
          return;
        }
        // A quarterly filer declares each month after the quarter; sick leave or a contract
        // ended brings that month, and the quarter's months before it, to the 25th after it (art.
        // 147 alin. (11), `d112Filing`).
        const filing = d112Filing(
          month,
          period.value === 'quarterly' ? 'quarterly' : 'monthly',
          books.payrollEventMonths,
        );
        emit.obligation({
          kind: 'D112',
          deadline: filing.deadline,
          period: month,
          deadlinePeriod: filing.counted === month ? null : filing.counted,
          state: 'applies',
          blockers: [],
        });
      },
    });
    if (isQuarterEnd(month))
      rules.push({
        id: `obligation.income_tax@${month}`,
        clauses: [`${CODE}:art.56(1)`, `${CODE}:art.41(1)`, `${CODE}:art.42(1)`],
        reads: [`incomeTax@${month}`],
        derives: [],
        run(read, emit) {
          const tax = read(`incomeTax@${month}`);
          if (tax.state === 'known' && tax.value === 'micro')
            emit.obligation({
              kind: 'D100',
              deadline: 'D100.micro',
              period: month,
              deadlinePeriod: null,
              state: 'applies',
              blockers: [],
            });
          else if (tax.state === 'unknown')
            emit.obligation({
              kind: 'D100',
              deadline: 'D100.micro',
              period: month,
              deadlinePeriod: null,
              state: 'needs_evidence',
              blockers: tax.needs,
            });
          else if (tax.state === 'known' && tax.value === 'profit') {
            // The system of declaring and paying (art. 41): quarterly by law after a micro year
            // (alin. (6) lit. d)), else the company's option; the annual system with prepayments
            // is not covered.
            const microBefore =
              recordedAt(facts, 'income_tax', `${year - 1}-12-31`) === 'micro' ||
              recordedAt(facts, 'income_tax', `${year}-01-01`) === 'micro';
            const system = recordedAt(facts, 'profit.system', end);
            const blockers =
              system === 'annual'
                ? [
                    emit.unsupported({
                      trigger: 'PROFIT_ANNUAL_SYSTEM',
                      message:
                        'Sistemul anual de declarare și plată a impozitului pe profit, cu plăți anticipate trimestriale (art. 41 alin. (2)–(3), (8)–(10^1)), nu este acoperit.',
                      missingCapabilities: ['PROFIT_PREPAYMENTS'],
                      evidenceIds: [],
                      resolution:
                        'Sistemul trimestrial (art. 41 alin. (1)) sau calculul plăților anticipate în afara aplicației.',
                    }),
                  ]
                : !system && !microBefore
                  ? [
                      factNeed(
                        emit,
                        'profit.system',
                        'Nu este înregistrat sistemul de declarare și plată a impozitului pe profit: trimestrial (art. 41 alin. (1)) sau anual cu plăți anticipate (alin. (2)).',
                      ),
                    ]
                  : [];
            const state =
              system === 'annual' ? 'unsupported' : blockers.length ? 'needs_evidence' : 'applies';
            if (!month.endsWith('-12'))
              emit.obligation({
                kind: 'D100',
                deadline: 'D100.profit',
                period: month,
                deadlinePeriod: null,
                state,
                blockers,
              });
            else
              emit.obligation({
                kind: 'D101',
                deadline: 'D101',
                period: month.slice(0, 4),
                deadlinePeriod: null,
                state,
                blockers,
              });
          }
        },
      });
    const withheldHere = (books.withholdings ?? []).filter(
      (item) => item.month === month && item.annual !== 'D112',
    );
    // A month with tax withheld at source and no dividend tax: its own D100 (art. 84^1 alin. (6),
    // art. 97 alin. (2), art. 224 alin. (5)).
    if (withheldHere.length && !books.dividendMonths.includes(month))
      rules.push({
        id: `obligation.withholding@${month}`,
        clauses: [`${CODE}:art.97(2)`, `${CODE}:art.84^1(3)-(6)`, `${CODE}:art.224(5)`],
        reads: [],
        derives: [],
        run(_read, emit) {
          emit.obligation({
            kind: 'D100',
            deadline: 'D100.withholding',
            period: month,
            deadlinePeriod: null,
            state: 'applies',
            blockers: [],
          });
        },
      });
    if (books.dividendMonths.includes(month))
      rules.push({
        id: `obligation.dividends@${month}`,
        clauses: [`${CODE}:art.43(2)`, `${CODE}:art.97(7)`],
        reads: [],
        derives: [],
        run(_read, emit) {
          emit.obligation({
            kind: 'D100',
            deadline: 'D100.dividends',
            period: month,
            deadlinePeriod: null,
            state: 'applies',
            blockers: [],
          });
        },
      });
    if (month.endsWith('-12')) {
      const withheldInYear = (books.withholdings ?? []).filter((item) =>
        item.month.startsWith(String(year)),
      );
      if (
        books.dividendMonths.some((item) => item.startsWith(String(year))) ||
        withheldInYear.some((item) => item.annual === 'D205')
      )
        rules.push({
          id: `obligation.d205@${year}`,
          clauses: [`${CODE}:art.132(2)`],
          reads: [],
          derives: [],
          run(_read, emit) {
            emit.obligation({
              kind: 'D205',
              deadline: 'D205',
              period: String(year),
              deadlinePeriod: null,
              state: 'applies',
              blockers: [],
            });
          },
        });
      if (withheldInYear.some((item) => item.annual === 'D207'))
        rules.push({
          id: `obligation.d207@${year}`,
          clauses: [`${CODE}:art.231(1)`],
          reads: [],
          derives: [],
          run(_read, emit) {
            emit.obligation({
              kind: 'D207',
              deadline: 'D207',
              period: String(year),
              deadlinePeriod: null,
              state: 'applies',
              blockers: [],
            });
          },
        });
      rules.push({
        id: `obligation.income@${year}`,
        clauses: [`${CODE}:art.122(3)`, `${CODE}:art.125(4)`],
        reads: [`form@${month}`],
        derives: [],
        run(read, emit) {
          const form = read(`form@${month}`);
          // Returns of individuals wait for the form: while it is unknown, its need is listed
          // (`fact.entity.form`, and D100 and D406 read it), but D212 and D204 are not, so a
          // company is never offered an individual's return.
          if (form.state !== 'known' || !individualForms.includes(form.value as EntityForm)) return;
          emit.obligation({
            kind: 'D212',
            deadline: 'D212',
            period: String(year),
            deadlinePeriod: null,
            state: 'applies',
            blockers: [],
          });
          const sources = books.incomeSources.find((item) => item.year === String(year));
          if (form.value === 'if' && sources?.real)
            emit.obligation({
              kind: 'D204',
              deadline: 'D204',
              period: String(year),
              deadlinePeriod: null,
              state: 'applies',
              blockers: [],
            });
          // Several sources of a PFA or II are kept per source (pfa.fiscalRegister, D212); an IF's
          // distribution and D204 per source are not.
          if (form.value === 'if' && (sources?.count ?? 0) > 1)
            emit.unsupported({
              trigger: 'IF_SOURCES_MULTIPLE',
              message: `Întreprinderea familială are mai multe surse de venit în ${year}: distribuirea pe surse și D204 pentru mai multe surse nu sunt acoperite.`,
              missingCapabilities: ['IF_SOURCES_MULTIPLE'],
              evidenceIds: [],
              resolution:
                'Acoperirea mai multor surse ale unei IF sau ținerea lor în afara aplicației.',
            });
        },
      });
      if (books.financialYearEnds.includes(`${year}-12-31`)) {
        rules.push({
          id: `fact.size.category@${year}`,
          clauses: ['OMF2036/2025:anexa1.pct.2.1-2.3', 'OMFP1802/2014:pct.12-13'],
          reads: [`books@${month}`],
          derives: [`size@${year}`],
          run(read, emit) {
            const system = read(`books@${month}`);
            emit.derive(
              `size@${year}`,
              system.state === 'unsupported' && system.triggers.includes('PFA_DOUBLE_ENTRY')
                ? {
                    state: 'known',
                    value: 'none',
                    basis:
                      'PFA, II sau IF: fără situații financiare anuale (OMFP nr. 170/2015 art. 5)',
                  }
                : system.state !== 'known'
                  ? system
                  : system.value === 'single'
                    ? { state: 'known', value: 'none', basis: 'partidă simplă' }
                    : yearlySlot(input, emit, 'size.category', month, 'Categoria de mărime'),
            );
          },
        });
        rules.push({
          id: `obligation.statements@${year}`,
          clauses: [
            'L82/1991:art.36(1)(a)',
            'L82/1991:art.36(2)',
            'OMF2036/2025:anexa1.pct.2.1-2.3',
            'OMF2036/2025:anexa1.pct.2.2',
          ],
          reads: [`size@${year}`],
          derives: [],
          run(read, emit) {
            const size = read(`size@${year}`);
            const period = String(year);
            if (size.state === 'known' && size.value === 'none') return;
            // A company a person states has carried out no activity since it was set up files the
            // inactivity declaration instead of statements (art. 36 alin. (2)); the statements'
            // preparation asks the fact when the books show no activity.
            if (recordedAt(input.facts, 'activity.none', `${year}-12-31`) === 'yes') {
              emit.obligation({
                kind: 'S1046',
                deadline: 'S1046',
                period,
                deadlinePeriod: null,
                state: 'applies',
                blockers: [],
              });
              return;
            }
            if (size.state === 'known' && size.value === 'micro')
              emit.obligation({
                kind: 'S1005',
                deadline: 'S1005',
                period,
                deadlinePeriod: null,
                state: 'applies',
                blockers: [],
              });
            else if (size.state === 'known' && size.value === 'small')
              // S1003 (Y2): its package is pinned for 2025; a year without one is the
              // declaration's FORMAT_GAP when prepared, as S1005's is.
              emit.obligation({
                kind: 'S1003',
                deadline: 'S1003',
                period,
                deadlinePeriod: null,
                state: 'applies',
                blockers: [],
              });
            else
              emit.obligation({
                kind: size.state === 'known' ? 'SF.large' : 'S1005',
                deadline: size.state === 'known' ? null : 'S1005',
                period,
                deadlinePeriod: null,
                state: size.state === 'unknown' ? 'needs_evidence' : 'unsupported',
                blockers:
                  size.state === 'unknown'
                    ? size.needs
                    : size.state === 'unsupported'
                      ? size.triggers
                      : [],
              });
          },
        });
      }
      // The annual assets file (D406 Active) of a company holding fixed assets, for a financial
      // year its D406 obligation covers whole (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 1, 7–8;
      // ANAF's clarification of 14.11.2022), by the statements' deadline. ANAF's validator takes
      // only a year of twelve months.
      if (
        books.financialYearEnds.includes(`${year}-12-31`) &&
        books.assetYears.includes(String(year))
      )
        rules.push({
          id: `obligation.d406.assets@${year}`,
          clauses: ['OPANAF1783/2021:anexa4.pct.1,7-8', 'ANAF/D406_Clarificare_2022:precizari'],
          reads: [`form@${month}`],
          derives: [],
          run(read, emit) {
            const form = read(`form@${month}`);
            if (form.state === 'known' && individualForms.includes(form.value as EntityForm))
              return;
            const period = String(year);
            const item = {
              kind: 'D406',
              deadline: 'D406.assets' as const,
              period,
              deadlinePeriod: null,
            };
            if (form.state !== 'known') {
              emit.obligation({
                ...item,
                state: form.state === 'unsupported' ? 'unsupported' : 'needs_evidence',
                blockers: blockersOf(form),
              });
              return;
            }
            // The year from its first day in the books: a first year begun later is shorter.
            const opens =
              first !== null && first > `${year}-01` ? books.firstDay! : `${year}-01-01`;
            if (opens > `${year}-01-01`) {
              emit.obligation({
                ...item,
                state: 'unsupported',
                blockers: [
                  emit.unsupported({
                    trigger: 'D406_ASSETS_SHORT_YEAR',
                    message: `Primul exercițiu financiar (${opens} – ${year}-12-31) are mai puțin de 12 luni: validatorul ANAF primește declarația D406 pentru active doar pentru 12 luni, iar raportarea unui exercițiu mai scurt nu este stabilită.`,
                    missingCapabilities: ['D406_ASSETS_SHORT_YEAR'],
                    evidenceIds: [],
                    resolution:
                      'Răspunsul ANAF sau al expertului contabil pentru exercițiul scurt; până atunci declarația se pregătește în afara aplicației.',
                  }),
                ],
              });
              return;
            }
            const at = input.d406Start[`${year}-01`];
            if (!at || 'gap' in at) {
              emit.obligation({
                ...item,
                state: 'unsupported',
                blockers: [
                  emit.unsupported({
                    trigger: 'RULE_GAP',
                    message: `Data de la care se depune D406 nu este în registru pentru ${year}-01: ${at && 'gap' in at ? at.gap : 'ro.d406.start'}`,
                    missingCapabilities: ['ro.d406.start'],
                    evidenceIds: [],
                    resolution: 'Parametrul ro.d406.start revizuit pentru perioadă.',
                  }),
                ],
              });
              return;
            }
            const begun = d406Begun(facts, at.start, opens);
            if (begun.state === 'unknown') {
              emit.obligation({
                ...item,
                state: 'needs_evidence',
                blockers: [factNeed(emit, 'taxpayer.category', begun.message)],
              });
              return;
            }
            // A year begun before the obligation is not reported (the clarification).
            if (begun.value) emit.obligation({ ...item, state: 'applies', blockers: [] });
          },
        });
    }
    // The half-year report at 30 June (Legea nr. 82/1991 art. 28 alin. (2), the Ministry's order
    // of each year): owed by the entities under OMFP nr. 1.802/2014 the order names. The engine
    // does not prepare it: owed, it is UNSUPPORTED and kept outside, explicitly assigned; unknown,
    // it names what it lacks; a year no order is read for is a rule gap.
    const half = month.endsWith('-06')
      ? (books.halfYear ?? []).find((item) => item.year === String(year))
      : undefined;
    if (half && half.status !== 'none')
      rules.push({
        id: `obligation.halfyear@${year}`,
        clauses: ['OMF1194/2025:art.2,anexa.pct.16-17', 'ANAF/raportari-semestriale:2026'],
        reads: [`books@${month}`],
        derives: [],
        run(read, emit) {
          const system = read(`books@${month}`);
          if (system.state === 'known' && system.value === 'single') return;
          const item = {
            kind: 'SF.halfyear',
            deadline: null,
            period: `${year}-06`,
            deadlinePeriod: null,
          };
          if (system.state !== 'known') {
            emit.obligation({
              ...item,
              state: system.state === 'unsupported' ? 'unsupported' : 'needs_evidence',
              blockers: blockersOf(system),
            });
            return;
          }
          if (half.status === 'unknown') {
            emit.obligation({
              ...item,
              state: 'needs_evidence',
              blockers: [
                emit.need({
                  code: 'INPUT_UNKNOWN',
                  fact: `halfyear/${year}`,
                  message: half.message,
                  question: half.missing.some((what) => what.startsWith('cifra'))
                    ? figuresQuestion(year - 1, ['netTurnover'])
                    : {
                        kind: 'evidence.missing',
                        subject: { kind: 'company', id: `halfyear-${year}` },
                        params: { what: half.message },
                      },
                }),
              ],
            });
            return;
          }
          emit.obligation({
            ...item,
            state: 'unsupported',
            blockers: [
              emit.unsupported(
                half.status === 'gap'
                  ? {
                      trigger: 'RULE_GAP',
                      message: half.message,
                      missingCapabilities: ['ro.halfyear.report'],
                      evidenceIds: [],
                      resolution:
                        'Ordinul ministrului pentru raportarea la 30 iunie, citit și registrat.',
                    }
                  : {
                      trigger: 'HALFYEAR_REPORT',
                      message: half.message,
                      missingCapabilities: ['HALFYEAR_REPORT'],
                      evidenceIds: [],
                      resolution:
                        'Raportarea contabilă la 30 iunie se întocmește și se depune în afara aplicației, atribuit explicit.',
                    },
              ),
            ],
          });
        },
      });
  }

  // Cases the engine does not cover, from the books and the determinations.
  for (const year of years) {
    const inYear = months.filter((month) => month.startsWith(String(year)));
    // Changes of regime and the D700 that declares them (art. 55): entering the micro-enterprise
    // regime on 1 January (alin. (2)), leaving it from 1 January (alin. (5)) or during the year,
    // from the quarter a condition failed (art. 52, alin. (1) and (5)). The year before the books
    // is not read: its regime is not the books' to know.
    const before = `${year - 1}-12`;
    const previousRead = months.includes(before) ? [`incomeTax@${before}`] : [];
    rules.push({
      id: `scope.income_tax.transition@${year}`,
      clauses: [
        `${CODE}:art.52(1),(5)`,
        `${CODE}:art.48(1)-(2^1)`,
        `${CODE}:art.55(2)`,
        `${CODE}:art.55(1),(5)`,
      ],
      reads: [...previousRead, ...inYear.map((month) => `incomeTax@${month}`)],
      derives: [],
      run(read, emit) {
        const slots = inYear.map((month) => ({ month, slot: read(`incomeTax@${month}`) }));
        const known = slots.flatMap(({ month, slot }) =>
          slot.state === 'known' && (slot.value === 'micro' || slot.value === 'profit')
            ? [{ month, value: slot.value }]
            : [],
        );
        const firstOfBooks = first !== null && first > `${year - 1}-12`;
        const previous = previousRead.length
          ? read(previousRead[0]!)
          : firstOfBooks
            ? null
            : ({
                state: 'known',
                value: recordedAt(facts, 'income_tax', `${year - 1}-12-31`) ?? '',
                basis: 'fapt income_tax',
              } as const);
        const january = known.find((item) => item.month === `${year}-01`);
        const d700 = (deadline: ObligationKind, counted: string | null) =>
          emit.obligation({
            kind: 'D700',
            deadline,
            period: String(year),
            deadlinePeriod: counted,
            state: 'applies',
            blockers: [],
          });
        if (january && previous?.state === 'known') {
          if (previous.value === 'profit' && january.value === 'micro')
            d700('D700.micro_entry', String(year - 1));
          if (previous.value === 'micro' && january.value === 'profit')
            d700('D700.micro_exit_january', String(year - 1));
        }
        for (let index = 1; index < known.length; index++) {
          const [from, to] = [known[index - 1]!, known[index]!];
          if (from.value === 'micro' && to.value === 'profit') d700('D700.micro_exit', null);
          if (from.value === 'profit' && to.value === 'micro')
            emit.unsupported({
              trigger: 'MICRO_ENTRY_MIDYEAR',
              message: `Impozitul micro înregistrat din ${to.month} după impozitul pe profit în cursul anului ${year}: o microîntreprindere nu poate intra în sistem în cursul anului (art. 48 alin. (2)–(2^1)); faptul income_tax trebuie corectat.`,
              missingCapabilities: ['INCOME_TAX_REGIME'],
              evidenceIds: [],
              resolution: 'Corectați faptul income_tax cu documentul care îl susține (D700).',
            });
        }
      },
    });
    rules.push({
      id: `scope.determinations@${year}`,
      clauses: [`${CODE}:art.310(1)-(2),(6)`, `${CODE}:art.282(3^1)-(5)`],
      reads: [],
      derives: [],
      run(_read, emit) {
        for (const determination of input.determinations.filter(
          (item) =>
            item.year === year &&
            !yearlyAxes.includes(item.axis) &&
            item.status === 'unsupported' &&
            item.unsupported,
        ))
          emit.unsupported({
            trigger: determination.unsupported!.trigger,
            message: determination.unsupported!.message,
            missingCapabilities: determination.unsupported!.capabilities,
            evidenceIds: [],
            resolution: 'Acoperire revizuită pentru acest caz.',
          });
        // VAT on collection: a recorded regime the computation contradicts.
        const cash = input.determinations.find(
          (item) => item.axis === 'vat.cash' && item.year === year,
        );
        if (cash?.status === 'needs_evidence')
          for (const question of cash.questions)
            emit.need({
              code: 'INPUT_UNKNOWN',
              fact: `vat.cash/${year}`,
              message: cash.summary,
              question,
            });
        if (cash?.status === 'proposed') {
          const differs = inYear.some((month) => {
            const end = lastDay(month);
            const computed =
              cash.changes.filter((change) => change.effectiveFrom <= end).at(-1)?.value ??
              cash.value;
            return computed !== recordedAt(facts, 'vat.cash', end);
          });
          if (differs && input.confirmed[`vat.cash/${year}`] !== cash.fingerprint)
            emit.need({
              code: 'DETERMINATION_CONFLICT',
              fact: `vat.cash/${year}`,
              message: `TVA la încasare înregistrată diferă de calcul: ${cash.summary}`,
              question: confirmQuestion(cash),
            });
        }
      },
    });
  }
  for (const month of months) {
    const purchases = books.foreignPurchases.filter((item) => item.month === month);
    if (purchases.length)
      rules.push({
        id: `scope.foreign.purchases@${month}`,
        clauses: [`${CODE}:art.317(1)`, `${CODE}:art.307(2)`, `${CODE}:norme.art.317.pct.90(4)`],
        reads: [`vat@${month}`, `vatEu@${month}`],
        derives: [],
        run(read, emit) {
          const vat = read(`vat@${month}`);
          const code = read(`vatEu@${month}`);
          if (vat.state === 'known' && vat.value === 'normal_vat') return;
          // Covered: services under the general rule booked with the VAT owed (D301), from
          // outside the Union, or from it with the art. 317 code. Not covered: an invoice not
          // booked so (goods, other place-of-supply rules), or EU services without the code.
          const unbooked = purchases.filter((item) => item.reverseCharge !== true);
          const uncoded =
            code.state === 'known' && code.value !== 'special'
              ? purchases.filter(
                  (item) =>
                    item.reverseCharge === true &&
                    euVatPrefixes[item.country] !== undefined &&
                    item.country !== 'RO',
                )
              : [];
          const countries = (items: typeof purchases) =>
            [...new Set(items.map((item) => item.country))].join(', ');
          if (unbooked.length)
            emit.unsupported({
              trigger: 'FOREIGN_SERVICE_PURCHASE',
              message: `Facturi de la furnizori din afara României în ${month} (${countries(unbooked)}) ale unei firme neînregistrate în scopuri de TVA, neînregistrate ca servicii după regula generală (invoices.crossBorder): bunurile și celelalte reguli privind locul prestării nu sunt acoperite.`,
              missingCapabilities: ['FOREIGN_PURCHASE_TREATMENT'],
              evidenceIds: unbooked.map((item) => item.documentId),
              resolution:
                'Înregistrați serviciile după regula generală (invoices.crossBorder, cu TVA datorată prin D301) sau procesați facturile în afara aplicației, atribuit explicit.',
            });
          if (uncoded.length)
            emit.unsupported({
              trigger: 'FOREIGN_SERVICE_PURCHASE',
              message: `Servicii de la prestatori din alte state membre în ${month} (${countries(uncoded)}) ale unei firme fără cod de TVA după art. 317: codul se solicita înaintea primirii lor (art. 317 alin. (1) lit. c)); TVA se datorează oricum și se declară în D301.`,
              missingCapabilities: ['VAT_ART317_REGISTRATION'],
              evidenceIds: uncoded.map((item) => item.documentId),
              resolution:
                'Solicitați codul de TVA art. 317 și înregistrați-l (vat.eu special, cu documentul), sau tratați operațiunile în afara aplicației, atribuit explicit.',
            });
        },
      });
  }
  // A year with supplies exempt without the right of deduction: the company is mixed and applies
  // its provisional pro-rata (art. 300 alin. (9)–(10)), the year's fact, or a special one the
  // engine does not compute (alin. (16)–(18)).
  for (const year of years) {
    const exempt = (books.exemptNoDeductionMonths ?? []).filter(
      (month) => month.startsWith(`${year}-`) && months.includes(month),
    );
    if (!exempt.length) continue;
    const last = exempt.at(-1)!;
    rules.push({
      id: `scope.prorata@${year}`,
      clauses: [`${CODE}:art.300(8)-(14)`],
      reads: [`vat@${last}`],
      derives: [],
      run(read, emit) {
        const vat = read(`vat@${last}`);
        if (vat.state !== 'known' || vat.value !== 'normal_vat') return;
        const provisional = provisionalProrata(input.facts, lastDay(last) as LocalDate);
        if (!provisional.found)
          emit.need({
            code: 'FACT_UNKNOWN',
            fact: `vat.prorata/${year}`,
            message: `Operațiuni scutite fără drept de deducere în ${exempt.join(', ')}: pro rata provizorie a anului ${year} se comunică organului fiscal (art. 300 alin. (9)–(10)) și se înregistrează (vat.prorata).`,
            question: factQuestion('vat.prorata', year),
          });
        else if (provisional.fact.kind === 'special')
          emit.unsupported({
            trigger: 'PRORATA_SPECIAL',
            message: `Pro rata specială a anului ${year} (art. 300 alin. (16)–(18)), aprobată sau impusă de Ministerul Finanțelor pe sectoare sau pe operațiunile deciziei, nu este calculată.`,
            missingCapabilities: ['VAT_PRORATA_SPECIAL'],
            evidenceIds: [],
            resolution:
              'Calculați pro rata specială și ajustările în afara aplicației, atribuit explicit.',
          });
      },
    });
  }
  // The special VAT schemes (V4): registered persons' regimes. Their D300 and D394 rows are
  // covered; the SAF-T has no code for the margin schemes, so a company's D406 of those months
  // cannot be prepared.
  for (const year of years) {
    const marked = (books.schemes ?? []).filter(
      (item) => item.month.startsWith(`${year}-`) && months.includes(item.month),
    );
    if (!marked.length) continue;
    const schemeMonths = [...new Set(marked.map((item) => item.month))].sort();
    const marginMonths = [
      ...new Set(marked.filter((item) => item.scheme !== 'flat_rate').map((item) => item.month)),
    ].sort();
    rules.push({
      id: `scope.schemes@${year}`,
      clauses: [`${CODE}:art.311(4)-(6)`, `${CODE}:art.312(2)-(4)`, `${CODE}:art.315^1(17)-(18)`],
      reads: schemeMonths.flatMap((month) => [`vat@${month}`, `form@${month}`]),
      derives: [],
      run(read, emit) {
        const outside = schemeMonths.filter((month) => {
          const vat = read(`vat@${month}`);
          return vat.state === 'known' && vat.value !== 'normal_vat';
        });
        if (outside.length)
          emit.unsupported({
            trigger: 'SPECIAL_SCHEME_NON_VAT',
            message: `Operațiuni în regimurile speciale de TVA (marja, cota forfetară) în ${outside.join(', ')}, în care firma nu este înregistrată în scopuri de TVA: aceste regimuri sunt ale persoanelor înregistrate.`,
            missingCapabilities: ['SPECIAL_SCHEME_NON_VAT'],
            evidenceIds: [],
            resolution: 'Verificați regimul de TVA înregistrat (vat.status) și înregistrările.',
          });
        // A PFA, II or IF files no D406; a company, or a form not yet known, does.
        const d406 = marginMonths.filter((month) => {
          const form = read(`form@${month}`);
          return !(form.state === 'known' && individualForms.includes(form.value as EntityForm));
        });
        if (d406.length)
          emit.unsupported({
            trigger: 'MARGIN_SCHEME_D406',
            message: `Operațiuni în regimul marjei (art. 311, 312) în ${d406.join(', ')}: nomenclatorul SAF-T al ANAF nu are un cod de taxă pentru regimul marjei, deci D406 al acestor perioade nu se întocmește din aplicație.`,
            missingCapabilities: ['D406_MARGIN_TAX_CODE'],
            evidenceIds: [],
            resolution:
              'D406 al perioadei întocmit în afara aplicației, atribuit explicit, până când ANAF publică un cod pentru regimul marjei.',
          });
      },
    });
  }
  // A farmer applying the special regime (art. 315^1): its VAT side is booked, but neither the
  // income tax of agricultural activities (art. 103–107) nor the turnover of art. 310 without
  // the agricultural supplies (alin. (4) lit. c)).
  if (
    months.length &&
    recordedAt(facts, 'vat.agriculture', lastDay(input.interval.to)) === 'special'
  )
    rules.push({
      id: 'scope.agriculture',
      clauses: [`${CODE}:art.315^1(1)-(4)`],
      reads: [],
      derives: [],
      run(_read, emit) {
        emit.unsupported({
          trigger: 'AGRICULTURE_FARMER',
          message:
            'Firma este agricultor în regimul special (vat.agriculture special): facturile cu compensația în cotă forfetară se înregistrează, dar impozitul pe venitul din activități agricole (art. 103–107 din Codul fiscal) și plafonul de scutire al art. 310 fără livrările agricole (art. 315^1 alin. (4) lit. c)) nu sunt calculate.',
          missingCapabilities: ['AGRICULTURAL_INCOME', 'VAT_THRESHOLD_AGRICULTURE'],
          evidenceIds: [],
          resolution:
            'Venitul agricol și plafonul de TVA stabilite în afara aplicației, atribuite explicit.',
        });
      },
    });
  // A range wholly before the books: nothing to read, nothing to ask.
  if (!months.length) return rules;
  rules.push({
    id: 'scope.books',
    clauses: [],
    reads: [],
    derives: [],
    run(_read, emit) {
      if (books.stockMonths.length)
        emit.unsupported({
          trigger: 'GOODS_STOCK',
          message: `Registrele au înregistrări pe conturi de stocuri (clasa 3) în ${books.stockMonths.join(', ')} pe care gestiunea pe articole nu le explică: intrări și ieșiri fără mișcări de stoc, diferențe de preț sau ajustări în afara gestiunii.`,
          missingCapabilities: ['STOCK_OUTSIDE_REGISTER'],
          evidenceIds: [],
          resolution:
            'Înregistrările prin gestiune (recepție, descărcare, bon de consum) sau preluarea soldului în gestiune (stock.opening).',
        });
      if (books.sponsorshipMonths.length)
        emit.unsupported({
          trigger: 'SPONSORSHIP',
          message: `Sponsorizări (6582) în ${books.sponsorshipMonths.join(', ')}: impozitul pe profit scade sponsorizarea în limitele legii, dar declarația informativă privind beneficiarii (D107, art. 42 alin. (3)) nu este acoperită.`,
          missingCapabilities: ['D107'],
          evidenceIds: [],
          resolution: 'Declarația 107, întocmită în afara aplicației, atribuită explicit.',
        });
      const intellectual = [
        ...new Set(
          (books.withholdings ?? [])
            .filter((item) => item.annual === 'D112')
            .map((item) => item.month),
        ),
      ];
      if (intellectual.length)
        emit.unsupported({
          trigger: 'D112_INTELLECTUAL_PROPERTY',
          message: `Impozit reținut pe drepturi de proprietate intelectuală în ${intellectual.join(', ')}: se declară în D112 (art. 132 alin. (2) din Codul fiscal), pe care aplicația nu îl scrie încă pentru aceste venituri.`,
          missingCapabilities: ['D112_INTELLECTUAL_PROPERTY'],
          evidenceIds: [],
          resolution:
            'D112 pentru drepturile de proprietate intelectuală, depus în afara aplicației.',
        });
      if (books.payrollWithoutContractMonths.length)
        emit.unsupported({
          trigger: 'PAYROLL_WITHOUT_EMPLOYEES',
          message: `Impozit sau contribuții salariale în ${books.payrollWithoutContractMonths.join(', ')} fără niciun contract de muncă: remunerația administratorului sau alte venituri asimilate salariilor (D112 pentru ele) nu sunt acoperite.`,
          missingCapabilities: ['D112_ASSIMILATED_INCOME'],
          evidenceIds: [],
          resolution: 'Modulul veniturilor asimilate salariilor (W1).',
        });
    },
  });
  const last = lastDay(input.interval.to);
  rules.push({
    id: 'scope.activity',
    clauses: [],
    reads: [],
    derives: [],
    run(_read, emit) {
      const goods = recordedAt(facts, 'activity.goods', last);
      if (!goods)
        factNeed(
          emit,
          'activity.goods',
          'Nu este înregistrat dacă firma vinde sau ține bunuri în stoc (activity.goods).',
        );
      else if (goods === 'yes') {
        // Goods kept in the stock register (G1) at cost, covered once its written policies are
        // recorded (OMFP 1802/2014 pct. 96, 289–291); or at their retail price (G2, pct. 286
        // alin. (8)), on the perpetual inventory only (pct. 291 alin. (5)), its Z reports and
        // monthly discharges checked at each month's close.
        const retail = recordedAt(facts, 'policy.stock.retail', last) === 'retail';
        const method = recordedAt(facts, 'policy.stock.valuation', last);
        const inventory = recordedAt(facts, 'policy.stock.inventory', last);
        if (!method && !retail)
          factNeed(
            emit,
            'policy.stock.valuation',
            'Nu este înregistrată metoda de evaluare a ieșirilor din gestiune (policy.stock.valuation: FIFO, LIFO, CMP după fiecare recepție sau lunar).',
          );
        if (!inventory)
          factNeed(
            emit,
            'policy.stock.inventory',
            'Nu este înregistrată metoda de evidență a stocurilor (policy.stock.inventory: inventar permanent sau intermitent).',
          );
        if (!retail && !recordedAt(facts, 'policy.stock.negative', last))
          factNeed(
            emit,
            'policy.stock.negative',
            'Nu este înregistrat dacă politicile contabile admit stocuri negative (policy.stock.negative).',
          );
        if (retail && inventory === 'intermittent')
          emit.unsupported({
            trigger: 'RETAIL_INTERMITTENT',
            message:
              'Firma ține mărfurile la preț cu amănuntul cu inventarul intermitent: metoda global-valorică nu se aplică cu inventarul intermitent (OMFP 1802/2014 pct. 291 alin. (5)).',
            missingCapabilities: ['RETAIL_INTERMITTENT'],
            evidenceIds: [],
            resolution: 'Inventarul permanent, sau mărfurile ținute la cost.',
          });
      }
      // Production (G4): products costed under a written method (OMFP 1802/2014 pct. 8 pct. 7,
      // 286), kept on the perpetual inventory; the intermittent one is not built for products.
      if (books.productionMonths?.length) {
        if (!recordedAt(facts, 'policy.production.cost', last))
          factNeed(
            emit,
            'policy.production.cost',
            'Nu este înregistrată metoda de calcul al costului produselor (policy.production.cost: costul standard sau costul de producție efectiv).',
          );
        if (recordedAt(facts, 'policy.stock.inventory', last) === 'intermittent')
          emit.unsupported({
            trigger: 'PRODUCTION_INTERMITTENT',
            message: `Firma are producție (${books.productionMonths.join(', ')}) cu inventarul intermitent: produsele stabilite doar prin inventar la sfârșitul perioadei nu sunt construite (funcțiunile conturilor 345 și 711 descriu inventarul permanent).`,
            missingCapabilities: ['PRODUCTION_INTERMITTENT'],
            evidenceIds: [],
            resolution: 'Inventarul permanent pentru produse.',
          });
      }
      const regime = recordedAt(facts, 'regime.excluded', last);
      if (!regime)
        factNeed(
          emit,
          'regime.excluded',
          'Nu este înregistrat dacă firma are accize, face parte dintr-un grup fiscal sau aplică IFRS (regime.excluded).',
        );
      else if (regime !== 'none')
        emit.unsupported({
          trigger: `REGIME_${regime.toUpperCase()}`,
          message: `Regimul ${regime} este în afara acoperirii produsului.`,
          missingCapabilities: [regime.toUpperCase()],
          evidenceIds: [],
          resolution: 'În afara domeniului: se ține în afara aplicației.',
        });
    },
  });
  // Sales to consumers in other Member States and the One Stop Shop (core ro/oss).
  rules.push(...ossClosureRules(input, months));
  // INS's Intrastat declarations (core ro/trade).
  rules.push(...tradeClosureRules(input, months));
  return rules;
}

/** The last day of a period label: a month, a quarter (`2026-Q3`) or a year. */
export function periodEnd(period: string): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return lastDay(`${quarter[1]}-${pad(Number(quarter[2]) * 3)}`);
  if (/^\d{4}$/.test(period)) return `${period}-12-31`;
  return lastDay(period);
}

/** The closure of a range of months: what applies, what is unknown, what is not covered. */
export function evaluateClosure(input: ClosureInput): Closure {
  const rules = closureRules(input);
  const evaluation = evaluateRules(rules);
  const unsupported = [...evaluation.unsupported.values()];
  for (const gap of evaluation.gaps)
    unsupported.push({
      trigger: `CLOSURE_${gap.code}`,
      message: gap.message,
      missingCapabilities: ['CLOSURE_RULES'],
      evidenceIds: [],
      rule: gap.rules[0]!,
      resolution: 'O regulă care stabilește aplicabilitatea, revizuită.',
    });
  const needs = [...evaluation.needs.values()];
  return {
    version: CLOSURE_VERSION,
    rulesHash: hashOf(
      [
        ...new Map(rules.map((rule) => [rule.id.replace(/@.*/, ''), [...rule.clauses]] as const)),
      ].sort(([a], [b]) => a.localeCompare(b)),
    ),
    interval: { ...input.interval },
    status: unsupported.length
      ? 'UNSUPPORTED'
      : needs.length || evaluation.obligations.some((item) => item.state !== 'applies')
        ? 'NEEDS_EVIDENCE'
        : 'ELIGIBLE',
    obligations: evaluation.obligations.sort(
      (a, b) =>
        periodEnd(a.period).localeCompare(periodEnd(b.period)) ||
        a.kind.localeCompare(b.kind) ||
        a.period.localeCompare(b.period),
    ),
    needs,
    unsupported,
    gaps: evaluation.gaps,
    trace: evaluation.trace,
  };
}
