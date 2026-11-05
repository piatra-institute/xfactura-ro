import type {
  AgentDetector as DeterminationDetector,
  AgentDocumentType,
  AgentQuestion,
} from '../determinations/agent';

/*
 * What an agent needs to drive the profit tax module (docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it may bring in, the questions people answer and the evidence
 * they cite, the worklist items its detectors raise with the rules they enforce, and the fields
 * a booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'd101.filed',
    title: 'Declarația 101 depusă pentru anii anteriori (cu recipisa)',
    summary:
      "An annual profit tax return filed before the engine's books: the tax losses it declared (rd. 40^1) and what was recovered, for the vintages carried in.",
    evidenceFor: ['profit.losses'],
  },
  {
    id: 'sponsorship.contract',
    title:
      'Contract de sponsorizare și extrasul din Registrul entităților pentru care se acordă deduceri fiscale',
    summary:
      "A sponsorship under Legea nr. 32/1994 and, for a non-profit beneficiary, its entry in ANAF's register on the contract's date: what lets the sponsorship be deducted from the tax (art. 25 alin. (4) lit. i)).",
    evidenceFor: ['profit.account'],
  },
  {
    id: 'protocol.policy',
    title: 'Documente de protocol sau de reclamă (invitații, programe, campanii)',
    summary:
      'What shows whether an expense on 623 is protocol (limited to 2%) or advertising and publicity (deductible).',
    evidenceFor: ['profit.account'],
  },
  {
    id: 'fine.decision',
    title: 'Decizii de impunere, procese-verbale de contravenție, facturi de penalități',
    summary:
      'Whether an amount on 6581 is owed to an authority (not deductible) or under a contract (deductible).',
    evidenceFor: ['profit.account'],
  },
  {
    id: 'asset.fiscal',
    title: 'Fișa mijlocului fix cu regimul fiscal de amortizare',
    summary:
      "A fixed asset's fiscal method, value and normal life, the decision for the accelerated methods, and what makes an M1 car excepted from the 1,500 lei cap (art. 28).",
    evidenceFor: ['assets.recordFiscal'],
  },
  {
    id: 'legal.reserve',
    title: 'Hotărârea asociaților sau politica de constituire a rezervei legale',
    summary:
      'The decision to set aside the legal reserve (Legea nr. 31/1990 art. 183), whose part within 5% is deducted (art. 26 alin. (1) lit. a)).',
    evidenceFor: ['tax.profit'],
  },
  {
    id: 'd700.receipt',
    title: 'Recipisa declarației 700',
    summary:
      'The filed change of the fiscal vector (entering or leaving the micro-enterprise regime), which the engine does not prepare.',
    evidenceFor: ['obligation.filed'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profit.account',
    answeredBy: 'owner',
    evidence: ['protocol.policy', 'fine.decision', 'sponsorship.contract'],
    summary:
      'What an account whose deductibility depends on facts holds (protocol or advertising, a fine or a contractual penalty, a sponsorship, a vehicle, dividends from a Romanian company).',
  },
  {
    kind: 'vehicle.use',
    answeredBy: 'owner',
    evidence: ['the vehicle log (foaia de parcurs)', 'the registration certificate'],
    summary:
      'Whether a vehicle whose costs an account holds is used only for the business: otherwise half its costs are not deductible (art. 25 alin. (3) lit. l)).',
  },
  {
    kind: 'profit.losses',
    answeredBy: 'owner',
    evidence: ['d101.filed'],
    summary: "The tax losses carried into the books' first year, from the returns filed before it.",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['the form 012 notification', 'registration.certificate'],
    summary:
      'The system of declaring and paying the profit tax (`profit.system`: quarterly, or annual with prepayments).',
  },
  {
    kind: 'obligation.filed',
    answeredBy: 'owner',
    evidence: ['d700.receipt'],
    summary:
      "A D700 the company filed through ANAF's portal, which marks it filed on the calendar.",
  },
];

export interface AgentDetector extends Omit<DeterminationDetector, 'kind'> {
  kind: 'profit.unclassified' | 'asset.fiscalMissing' | 'profit.correction';
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'profit.unclassified',
    summary:
      "An account with turnover in a profit tax year whose deductibility depends on facts and that nobody classified, or one holding a vehicle's costs under another classification: the quarter's tax is blocked until it is.",
    rules: [
      'ro.profit.protocol_limit',
      'ro.profit.social_limit',
      'ro.profit.vehicle_share',
      'ro.profit.sponsorship',
    ],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
  {
    kind: 'asset.fiscalMissing',
    summary:
      'A fixed asset in use in a profit tax year without a fiscal basis on the register: fiscal depreciation cannot replace the book depreciation (art. 28).',
    rules: ['ro.profit.depreciation', 'ro.profit.superaccelerated', 'ro.profit.asset_threshold'],
    next: [{ operation: 'assets.recordFiscal', by: 'agent' }],
  },
  {
    kind: 'profit.correction',
    summary:
      "A prior-year correction on 1174 that changes the corrected year's fiscal result: that year's tax is rectified (tax.profit, rectification) and its D101 too.",
    rules: ['ro.profit.rate', 'ro.profit.loss_carryforward'],
    next: [{ operation: 'tax.profit.propose', by: 'agent' }],
  },
];

/** The fields a booking template sets: none. Each quarter is computed from the books; what a
 * person decides once (an account's nature, a vehicle's use) is an answer every computation
 * cites, not a template. */
export const templates: readonly string[] = [];
