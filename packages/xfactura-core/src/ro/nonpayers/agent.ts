import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive the non-payers' module (docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it may bring in, the questions people answer and the evidence
 * they cite, the worklist items its detectors raise with the rules they enforce, and the fields a
 * booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'vat.registration.certificate',
    title: 'Certificatul de înregistrare în scopuri de TVA (art. 316) sau decizia de înregistrare',
    summary:
      "ANAF's registration for VAT and the date it is valid from: the threshold's crossing date (art. 316 alin. (1^1) lit. b), f)), the request date for an option, or the communication date of an ex officio decision.",
    evidenceFor: ['vat.status', 'determination.confirm', 'vat.lateRegistration'],
  },
  {
    id: 'vat.art317.certificate',
    title: 'Certificatul de înregistrare în scopuri de TVA după art. 317 (cod special)',
    summary:
      'The special VAT code of a company outside VAT, for services bought from or supplied to the EU, valid from the request (norme pct. 90 alin. (4)).',
    evidenceFor: ['vat.eu', 'determination.confirm'],
  },
  {
    id: 'vat.deregistration.decision',
    title: 'Decizia de anulare a înregistrării în scopuri de TVA (scoaterea din evidență)',
    summary:
      'The cancellation for the small-enterprise exemption (art. 310 alin. (7), art. 316 alin. (11) lit. g)), valid from its communication: it starts the last D300.',
    evidenceFor: ['vat.status', 'determination.confirm', 'vat.capitalGoods'],
  },
  {
    id: 'anaf.vat.decision',
    title: 'Decizia de impunere ANAF pentru TVA (înregistrare întârziată)',
    summary:
      'The VAT difference ANAF established for the period the normal regime should have applied (art. 310 alin. (6^1)), with its due date and accessories: booked by the tax account from the decision (`tax.decision`, an assessment expensed on 635).',
    evidenceFor: ['tax.decision'],
  },
  {
    id: 'consideration.statement',
    title: 'Declarația pe propria răspundere privind nerecuperarea TVA de la clienți',
    summary:
      "The company's statement that it cannot recover from its customers the VAT it should have charged: the price is then taken to include it (norme pct. 36 lit. b) pct. 4).",
    evidenceFor: ['vat.lateRegistration'],
  },
  {
    id: 'inventory.list',
    title: 'Listele de inventariere la data schimbării regimului de TVA',
    summary:
      'The inventory at the registration or the cancellation: stock, assets in progress, unused services and capital goods (norme pct. 83 alin. (7), (11)).',
    evidenceFor: ['vat.capitalGoods'],
  },
  {
    id: 'foreign.invoice',
    title: 'Facturi de servicii de la prestatori din străinătate (Meta, Google, AWS, furnizori AI)',
    summary:
      'Services bought under the general rule (art. 278 alin. (2)): outside VAT, the VAT is owed at the standard rate and declared in D301 (art. 307 alin. (2), art. 324).',
    evidenceFor: ['invoices.crossBorder'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: [
      'the computation itself (kept with the answer)',
      'vat.registration.certificate',
      'vat.art317.certificate',
      'vat.deregistration.decision',
    ],
    summary:
      'Confirm or correct the VAT status the threshold or the recorded deregistration gives (`vat.status`), or the art. 317 code the EU services require (`vat.eu`); a correction cites the registration or the decision with its date.',
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['vat.registration.certificate', 'vat.art317.certificate'],
    summary:
      'The VAT status (`vat.status`) or the art. 317 code (`vat.eu`) when nothing is recorded yet.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'determination.missing' | 'threshold.approaching' | 'obligation.due';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'threshold.approaching',
    summary:
      'The small-enterprise threshold at 80% (warning) or crossed (blocking): registration is due by the crossing day.',
    rules: ['ro.vat.exemption.threshold'],
    next: [{ operation: 'determinations.propose', by: 'agent' }],
  },
  {
    kind: 'determination.missing',
    summary:
      'A `vat.status` the threshold or a deregistration changes, or a `vat.eu` the EU services require, that the recorded facts contradict: the returns that depend on it are blocked until a person confirms or corrects it; `vat.registration` shows the VAT owed for registering late.',
    rules: ['ro.vat.exemption.threshold', 'ro.vat.late_registration'],
    next: [
      { operation: 'determinations.propose', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'vat.registration', by: 'agent' },
    ],
  },
  {
    kind: 'obligation.due',
    summary:
      'D301 for a month with services bought from abroad outside VAT, D390 for the art. 317 code holder, the last D300 after a cancellation: listed by the calendar.',
    rules: ['ro.deadline.D301', 'ro.deadline.D390', 'ro.deadline.D300'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
];

/** The fields a booking template sets: none. A service bought from abroad is recognized with
 * `invoices.crossBorder`, which templates do not cover yet; the VAT paid to the budget settles
 * the authority's 4423 item through `bank.settle`'s own template fields. */
export const templates: readonly string[] = [];
