import { hashOf } from '../../hash';
import type { ProfileFact } from '../../kernel';
import type { QuestionRequest } from '../../questions/kinds';
import { individualForms, type EntityForm } from '../entity';
import type { ObligationKind } from '../obligations';
import {
  confirmQuestion,
  factQuestion,
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

export const CLOSURE_VERSION = 'ro-closure@2';

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
  /** Months with services across the EU border, supplied or bought. */
  euServiceMonths: readonly string[];
  /** Months with dividend tax withheld. */
  dividendMonths: readonly string[];
  /** Invoices received from suppliers outside Romania. */
  foreignPurchases: readonly { month: string; documentId: string; country: string }[];
  /** Months with lines on stock accounts (class 3). */
  stockMonths: readonly string[];
  /** Months with sponsorship expenses (6582). */
  sponsorshipMonths: readonly string[];
  /** Months with payroll taxes booked (444, 431x, 436) and no employment contract running. */
  payrollWithoutContractMonths: readonly string[];
  /** A PFA's, II's or IF's income sources, per year. */
  incomeSources: readonly { year: string; count: number; real: boolean }[];
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
      clauses: ['OUG44/2008:art.15'],
      reads: [`form@${month}`],
      derives: [`books@${month}`],
      run(read, emit) {
        const form = read(`form@${month}`);
        const recorded = recordedAt(facts, 'books.system', end);
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
      clauses: [],
      reads: [],
      derives: [`vat@${month}`],
      run(_read, emit) {
        const value = recordedAt(facts, 'vat.status', end);
        emit.derive(
          `vat@${month}`,
          value
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
        emit.derive(
          `vatEu@${month}`,
          !value
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
            : value === 'special'
              ? {
                  state: 'unsupported',
                  triggers: [
                    emit.unsupported({
                      trigger: 'VAT_ART317',
                      message:
                        'Firma are cod de TVA pentru operațiuni intracomunitare (art. 317): decontul special (D301) nu este acoperit.',
                      missingCapabilities: ['VAT_ART317', 'D301'],
                      evidenceIds: [],
                      resolution: 'Acoperire revizuită pentru art. 317 și D301.',
                    }),
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
    rules.push({
      id: `obligation.vat@${month}`,
      clauses: [`${CODE}:art.323(1)`, 'OPANAF2328/2016:art.I'],
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
        if (vat.value !== 'normal_vat' || period.state !== 'known') return;
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
      id: `obligation.d406@${month}`,
      clauses: ['OPANAF1783/2021:anexa4.pct.1-4'],
      reads: [`vat@${month}`, `vatPeriod@${month}`, `form@${month}`],
      derives: [],
      run(read, emit) {
        const vat = read(`vat@${month}`);
        const period = read(`vatPeriod@${month}`);
        const form = read(`form@${month}`);
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
        if (form.state === 'known' && !individualForms.includes(form.value as EntityForm)) {
          emit.obligation({ ...item, ...due });
          return;
        }
        if (form.state === 'known') {
          // Whether SAF-T reaches a PFA, II or IF is open (docs/PFA_II_IF.md §5, question 7):
          // never assumed either way, a named gap until the expert contabil answers.
          const trigger = emit.unsupported({
            trigger: 'D406_INDIVIDUAL',
            message:
              'Dacă D406 (SAF-T) se aplică unei PFA, II sau IF este o întrebare deschisă pentru expertul contabil (sfera OPANAF nr. 1783/2021): aplicația nu presupune nici că se depune, nici că nu se depune.',
            missingCapabilities: ['D406_INDIVIDUAL_SCOPE'],
            evidenceIds: [],
            resolution:
              'Expertul contabil răspunde dacă OPANAF nr. 1783/2021 se aplică PFA, II și IF; până atunci, D406 se ține în afara aplicației, atribuit explicit.',
          });
          emit.obligation({
            ...item,
            period: due.period,
            state: 'unsupported',
            blockers: [trigger, ...due.blockers],
          });
          return;
        }
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
        clauses: ['OPANAF591/2016:anexa4.pct.1.1'],
        reads: [`vat@${month}`, `vatEu@${month}`],
        derives: [],
        run(read, emit) {
          const vat = read(`vat@${month}`);
          if (vat.state === 'known' && vat.value !== 'normal_vat') {
            emit.obligation({
              kind: 'D390',
              deadline: null,
              period: month,
              deadlinePeriod: null,
              state: 'unsupported',
              blockers: [
                emit.unsupported({
                  trigger: 'EU_SERVICES_NON_VAT',
                  message: `Servicii intracomunitare în ${month} ale unei firme neînregistrate în scopuri de TVA: înregistrarea după art. 317, D301 și D390 nu sunt acoperite.`,
                  missingCapabilities: ['VAT_ART317', 'D301', 'D390'],
                  evidenceIds: [],
                  resolution:
                    'Acoperire revizuită pentru art. 317 sau tratarea acestor operațiuni în afara aplicației, atribuită explicit.',
                }),
              ],
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
        // A quarterly filer declares each month after the quarter, except the months with sick
        // leave or a contract ended (art. 147 alin. (11)).
        const quarterly = period.value === 'quarterly' && !books.payrollEventMonths.includes(month);
        emit.obligation({
          kind: 'D112',
          deadline: quarterly ? 'D112.quarterly' : 'D112',
          period: month,
          deadlinePeriod: quarterly ? quarterLabel(month) : null,
          state: 'applies',
          blockers: [],
        });
      },
    });
    if (isQuarterEnd(month))
      rules.push({
        id: `obligation.income_tax@${month}`,
        clauses: [`${CODE}:art.56(1)`],
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
            const trigger = emit.unsupported({
              trigger: 'PROFIT_TAX',
              message:
                'Impozitul pe profit (plățile trimestriale, D101 și registrul de evidență fiscală) nu este încă acoperit.',
              missingCapabilities: ['PROFIT_TAX', 'D101'],
              evidenceIds: [],
              resolution: 'Modulul impozitului pe profit (P1) sau ținerea lui în afara aplicației.',
            });
            if (month.endsWith('-12'))
              emit.obligation({
                kind: 'D101',
                deadline: null,
                period: month.slice(0, 4),
                deadlinePeriod: null,
                state: 'unsupported',
                blockers: [trigger],
              });
          }
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
      if (books.dividendMonths.some((item) => item.startsWith(String(year))))
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
          if ((sources?.count ?? 0) > 1)
            emit.unsupported({
              trigger: 'PFA_SOURCES_MULTIPLE',
              message: `Mai multe surse de venit în ${year}: registrul de evidență fiscală și D212 pentru mai multe surse nu sunt acoperite.`,
              missingCapabilities: ['PIT_SOURCES_MULTIPLE'],
              evidenceIds: [],
              resolution: 'Acoperirea mai multor surse (PF) sau ținerea lor în afara aplicației.',
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
              system.state !== 'known'
                ? system
                : system.value === 'single'
                  ? { state: 'known', value: 'none', basis: 'partidă simplă' }
                  : yearlySlot(input, emit, 'size.category', month, 'Categoria de mărime'),
            );
          },
        });
        rules.push({
          id: `obligation.statements@${year}`,
          clauses: ['L82/1991:art.36(1)(a)', 'OMF2036/2025:anexa1.pct.2.1-2.3'],
          reads: [`size@${year}`],
          derives: [],
          run(read, emit) {
            const size = read(`size@${year}`);
            const period = String(year);
            if (size.state === 'known' && size.value === 'none') return;
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
              emit.obligation({
                kind: 'SF.small',
                deadline: 'S1005',
                period,
                deadlinePeriod: null,
                state: 'unsupported',
                blockers: [
                  emit.unsupported({
                    trigger: 'SMALL_ENTITY_STATEMENTS',
                    message: `În ${year} compania este entitate mică: situațiile financiare ale entităților mici nu sunt încă acoperite.`,
                    missingCapabilities: ['ANNUAL_STATEMENTS_SMALL'],
                    evidenceIds: [],
                    resolution:
                      'Modulul situațiilor entităților mici (Y2) sau întocmirea lor în afara aplicației.',
                  }),
                ],
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
    }
  }

  // Cases the engine does not cover, from the books and the determinations.
  for (const year of years) {
    const inYear = months.filter((month) => month.startsWith(String(year)));
    rules.push({
      id: `scope.income_tax.transition@${year}`,
      clauses: [`${CODE}:art.52(1),(5)`],
      reads: inYear.map((month) => `incomeTax@${month}`),
      derives: [],
      run(read, emit) {
        const values = new Set(
          inYear
            .map((month) => read(`incomeTax@${month}`))
            .flatMap((slot) => (slot.state === 'known' ? [slot.value] : [])),
        );
        const exit = input.determinations.find(
          (item) => item.axis === 'income_tax' && item.year === year && item.changes.length,
        );
        if ((values.has('micro') && values.has('profit')) || exit)
          emit.unsupported({
            trigger: 'MICRO_PROFIT_TRANSITION',
            message: `În ${year} compania trece de la impozitul micro la impozitul pe profit în cursul anului: calculul impozitului pe profit de la trimestrul ieșirii nu este acoperit.`,
            missingCapabilities: ['MICRO_PROFIT_TRANSITION', 'PROFIT_TAX'],
            evidenceIds: [],
            resolution: 'Modulul trecerii de la micro la profit (P2).',
          });
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
        clauses: [`${CODE}:art.317`],
        reads: [`vat@${month}`],
        derives: [],
        run(read, emit) {
          const vat = read(`vat@${month}`);
          if (vat.state === 'known' && vat.value === 'normal_vat') return;
          emit.unsupported({
            trigger: 'FOREIGN_SERVICE_PURCHASE',
            message: `Achiziții de la furnizori din afara României în ${month} (${[...new Set(purchases.map((item) => item.country))].join(', ')}) ale unei firme neînregistrate în scopuri de TVA: înregistrarea după art. 317, D301 și D390 nu sunt acoperite.`,
            missingCapabilities: ['VAT_ART317', 'D301', 'D390'],
            evidenceIds: purchases.map((item) => item.documentId),
            resolution:
              'Acoperire revizuită sau procesarea acestor facturi în afara aplicației, atribuită explicit.',
          });
        },
      });
  }
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
          message: `Registrele au conturi de stocuri (clasa 3) în ${books.stockMonths.join(', ')}: gestiunea stocurilor nu este încă acoperită.`,
          missingCapabilities: ['STOCK'],
          evidenceIds: [],
          resolution: 'Modulul stocurilor (G1).',
        });
      if (books.sponsorshipMonths.length)
        emit.unsupported({
          trigger: 'SPONSORSHIP',
          message: `Sponsorizări (6582) în ${books.sponsorshipMonths.join(', ')}: creditul fiscal pentru sponsorizare și declarația 107 nu sunt acoperite.`,
          missingCapabilities: ['SPONSORSHIP_CREDIT', 'D107'],
          evidenceIds: [],
          resolution: 'Modulul impozitului pe profit (P1) sau ținerea lor în afara aplicației.',
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
      else if (goods === 'yes')
        emit.unsupported({
          trigger: 'GOODS_STOCK',
          message:
            'Firma declară că lucrează cu bunuri: gestiunea stocurilor nu este încă acoperită.',
          missingCapabilities: ['STOCK'],
          evidenceIds: [],
          resolution: 'Modulul stocurilor (G1).',
        });
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
