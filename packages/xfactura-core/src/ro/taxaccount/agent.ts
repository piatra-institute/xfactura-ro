import type {
  AgentDetector as DeterminationDetector,
  AgentDocumentType,
  AgentQuestion,
} from '../determinations/agent';

/*
 * What an agent needs to drive the tax account (docs/ROADMAP.md, "agent-ready by construction"):
 * the documents it may bring in (the statement of the taxpayer's account, ANAF's decisions, the
 * payment orders), the questions people answer, the worklist items its detectors raise with the
 * rules they enforce, and the fields a booking template sets (the destination of a payment).
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'tax.statement',
    title: 'Fișa pe plătitor / Situația sintetică (SPV)',
    summary:
      "ANAF's statement of the taxpayer's account, requested in the SPV (Situație Sintetică, Fișă Rol, Rezumat Fișă Rol): per obligation, what was owed, paid and is left. Transcribed with documents.record (kind tax.statement), every row's balance cited; the engine compares it with the books.",
    evidenceFor: ['taxaccount.reconcile', 'evidence.missing'],
  },
  {
    id: 'tax.decision.accessories',
    title:
      'Decizie referitoare la obligațiile fiscale accesorii (dobânzi și penalități de întârziere)',
    summary:
      'Interest (0.02%/day) and late-payment penalties (0.01%/day) on obligations paid late (OPANAF 967/2017 annex 3), due by the 5th or the 20th of the next month (CPF art. 156): documents.record kind tax.decision, decision accessories, then tax.decision.',
    evidenceFor: ['tax.decision'],
  },
  {
    id: 'tax.decision.assessment',
    title:
      'Decizie de impunere (diferențe stabilite de inspecția fiscală) / decizie de penalitate de nedeclarare',
    summary:
      'Differences of principal obligations established by an inspection, and the non-declaration penalty (CPF art. 181): decision assessment; each difference needs the expense account it is booked on.',
    evidenceFor: ['tax.decision'],
  },
  {
    id: 'tax.decision.refund',
    title: 'Decizie de rambursare a TVA / Decizia privind compensarea obligațiilor fiscale',
    summary:
      'The VAT refund approved on a negative D300 (OPANAF 352/2022 annex 2) and the offsets ANAF makes with it or with sums paid in excess (CPF art. 167): decision refund or offset; the rest arrives through the bank (tax.pay).',
    evidenceFor: ['tax.decision', 'tax.pay'],
  },
  {
    id: 'payment.order',
    title: 'Ordin de plată către Trezorerie',
    summary:
      'Where a payment to the state went (the single account 55.03 or a tax’s own budget account, VAT and the work insurance contribution being paid apart) and the payment record number (NEP) that designates an inspection obligation, a decision’s accessories or a fine.',
    evidenceFor: ['tax.pay'],
  },
  {
    id: 'd710.receipt',
    title: 'Declarația 710 (rectificativă) depusă și recipisa',
    summary:
      'A correction of obligations declared in D100, filed outside the engine: its registration number and receipt mark it filed.',
    evidenceFor: ['obligation.filed'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['the rescheduling or deferral decision', 'the court decision opening insolvency'],
    summary:
      'Whether the company has payment facilities, is in insolvency or restructuring, or has state aid to repay (`tax.facilities`): the single account then follows another order, which the engine does not cover.',
  },
  {
    kind: 'vat.refund',
    answeredBy: 'owner',
    evidence: [],
    summary:
      "Whether a period's negative VAT balance of at least 5,000 lei is claimed back on the D300 (a refund, with ANAF's inspection) or carried forward.",
  },
  {
    kind: 'evidence.missing',
    answeredBy: 'owner',
    evidence: ['tax.statement', 'tax.decision.accessories'],
    summary:
      "ANAF's statement of the account downloaded from the SPV, or a decision communicated there, which the engine cannot fetch itself.",
  },
  {
    kind: 'obligation.filed',
    answeredBy: 'owner',
    evidence: ['d710.receipt'],
    summary: 'A D710 correcting a filed D100, filed outside the engine.',
  },
];

export interface AgentDetector extends Omit<DeterminationDetector, 'kind'> {
  kind: 'taxaccount.differs' | 'taxaccount.undistributed' | 'taxaccount.correction';
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'taxaccount.differs',
    summary:
      "The latest statement of the taxpayer's account differs from the books for an obligation and period: each difference with what explains it (rounding, accessories not booked, an obligation not declared or not booked, a payment distributed otherwise).",
    rules: ['ro.taxaccount.obligations', 'ro.taxaccount.distribution', 'ro.taxaccount.accounts'],
    next: [
      { operation: 'taxaccount.reconcile', by: 'agent' },
      { operation: 'documents.record', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'taxaccount.undistributed',
    summary:
      'A payment to the single account not yet distributed while obligations of the authority are due: it is distributed over them in the legal order.',
    rules: ['ro.taxaccount.distribution', 'ro.taxaccount.advance'],
    next: [{ operation: 'proposals.propose', by: 'agent' }],
  },
  {
    kind: 'taxaccount.correction',
    summary:
      'A filed D100 whose obligations the books now compute otherwise: a D710 corrects them, filed outside the engine and recorded.',
    rules: ['ro.deadline.D100.micro', 'ro.deadline.D100.profit', 'ro.deadline.D100.dividends'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
];

/** The fields a booking template sets: where the payment went (`to`: the single account or a
 * tax's own account); the distribution itself is the engine's, never the template's. */
export const templates: readonly string[] = ['to'];
