import type { QuestionKindId } from '../../questions/kinds';
import { WATCH_PERCENT, yearlyAxes } from './determine';

/*
 * What an agent needs to drive the determinations module (docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it may bring in, the questions people answer, the worklist items
 * its detectors raise, and the fields a booking template sets (none: determinations book nothing).
 */

/** A document that can be brought in, what it proves and which facts or answers cite it. */
export interface AgentDocumentType {
  id: string;
  /** In Romanian, as people name it. */
  title: string;
  summary: string;
  /** The profile axes or question kinds it is evidence for. */
  evidenceFor: readonly string[];
}

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'onrc.extract',
    title: 'Certificat constatator (ONRC)',
    summary:
      "The trade register's certificate: legal form, shareholders and their holdings, activities (CAEN), dissolution or inactivity.",
    evidenceFor: ['entity.form', 'micro.conditions', 'activity.goods', 'regime.excluded'],
  },
  {
    id: 'registration.certificate',
    title: 'Certificat de înregistrare fiscală / vectorul fiscal',
    summary:
      "ANAF's registration and the taxpayer's fiscal vector: VAT registration and its date, the VAT period, VAT on collection, the income tax regime.",
    evidenceFor: ['vat.status', 'vat.period', 'vat.cash', 'vat.eu', 'income_tax'],
  },
  {
    id: 'd700',
    title: 'Declarația 700 (declarație de mențiuni)',
    summary:
      'A filed change of the fiscal vector: entering or leaving the micro-enterprise regime, the VAT period, the D112 option, VAT on collection.',
    evidenceFor: ['income_tax', 'vat.period', 'payroll.period', 'vat.cash'],
  },
  {
    id: 'shareholders.register',
    title: 'Registrul asociaților / acționarilor',
    summary:
      "The shareholders and their holdings, for the linked enterprises and the shareholders' designation of art. 47.",
    evidenceFor: ['micro.conditions'],
  },
  {
    id: 'annual.statements',
    title: 'Situațiile financiare anuale depuse (și recipisa)',
    summary:
      'A filed year: total assets, net turnover, average employees and revenues, for a year the engine does not keep, and the filing date.',
    evidenceFor: ['year.figures', 'size.category', 'micro.conditions'],
  },
];

/** A question the module asks, who answers it and with what evidence. */
export interface AgentQuestion {
  kind: QuestionKindId;
  /** `owner`: an owner or reviewer of the company (a person, never an agent). */
  answeredBy: 'owner';
  evidence: readonly string[];
  summary: string;
}

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: ['the computation itself (kept with the answer)', 'd700', 'registration.certificate'],
    summary:
      'Confirm or correct a computed yearly determination; a correction cites the document that supports it.',
  },
  {
    kind: 'micro.conditions',
    answeredBy: 'owner',
    evidence: ['onrc.extract', 'shareholders.register'],
    summary:
      "The micro-enterprise conditions only the owner knows, and the linked enterprises' revenues.",
  },
  {
    kind: 'year.figures',
    answeredBy: 'owner',
    evidence: ['annual.statements'],
    summary: 'The figures of a year the engine does not keep the books of.',
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['registration.certificate', 'onrc.extract', 'd700'],
    summary:
      'A company fact the books cannot compute: the legal form, the VAT registration, whether it employs, works with goods or is in an excluded regime.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  /** The worklist kind (`work.list`). */
  kind: 'determination.missing' | 'threshold.approaching' | 'closure.need';
  summary: string;
  /** The parameters or clauses whose rule the item enforces. */
  rules: readonly string[];
  /** What moves it on. */
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'determination.missing',
    summary: `A year without a recorded determination on a yearly axis (${yearlyAxes.join(', ')}), or one the books now contradict: the obligations that depend on it are blocked.`,
    rules: [
      'ro.micro.revenue_limit_eur',
      'ro.vat.period.limit_eur',
      'ro.payroll.quarterly',
      'ro.size.thresholds',
    ],
    next: [
      { operation: 'determinations.propose', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
  {
    kind: 'threshold.approaching',
    summary: `A threshold reached at ${WATCH_PERCENT}% (warning) or crossed (blocking) during the year: the micro-enterprise limit, the small-enterprise VAT threshold, the VAT on collection ceiling.`,
    rules: ['ro.micro.revenue_limit_eur', 'ro.vat.exemption.threshold', 'ro.vat.cash.ceiling'],
    next: [{ operation: 'determinations.propose', by: 'agent' }],
  },
  {
    kind: 'closure.need',
    summary:
      'A fact or determination the obligation closure cannot read (NEEDS_EVIDENCE) over the worklist’s months, with the returns it leaves blocked, or none for the scope facts (activity.goods, regime.excluded): a warning, information for a year not begun or waiting for its rules.',
    rules: [],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'determinations.propose', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
];

/** The fields a booking template sets: none, determinations book nothing. */
export const templates: readonly string[] = [];
