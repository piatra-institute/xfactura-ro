import type {
  AgentDetector as DeterminationDetector,
  AgentDocumentType,
  AgentQuestion,
} from '../determinations/agent';

/*
 * What an agent needs to drive the annual statements (docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it may bring in, the questions people answer, the worklist items
 * its detector raises and the rules they enforce, and the fields a booking template sets (none:
 * the statements book nothing).
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'annual.signed',
    title: 'Situațiile financiare semnate (prima pagină) și documentele însoțitoare semnate',
    summary:
      'The signed first page of the statements and each accompanying document signed by the administrator and the accountant: explanatory notes, administrators’ report, profit distribution proposal, the art. 30 declaration.',
    evidenceFor: ['annual.document'],
  },
  {
    id: 'aga.decision',
    title:
      'Hotărârea adunării generale a asociaților (aprobarea situațiilor, repartizarea profitului)',
    summary:
      'The shareholders’ decision approving the statements (bifa_aprob) and the distribution of the profit or the coverage of the loss.',
    evidenceFor: ['annual.document'],
  },
  {
    id: 'audit.report',
    title: 'Raportul de audit sau raportul comisiei de cenzori',
    summary: 'The auditor’s or the censors’ report, when the statements are audited or verified.',
    evidenceFor: ['annual.document'],
  },
  {
    id: 'shareholders.register',
    title: 'Registrul asociaților / acționarilor',
    summary: 'The holders of the paid-in capital, by category, for F30 chapter XII.',
    evidenceFor: ['annual.informative'],
  },
  {
    id: 'contracts',
    title: 'Contracte de concesiune, închiriere, finanțare, subvenții',
    summary:
      'Concessions, land rents, royalties, loans to or from other companies, subsidies received: the F30 rows the books do not tell.',
    evidenceFor: ['annual.informative'],
  },
  {
    id: 'tax.statement',
    title: 'Fișa sintetică a contribuabilului (ANAF)',
    summary: 'The taxes and contributions unpaid at their term at year end (F30 chapter II).',
    evidenceFor: ['annual.informative'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'annual.informative',
    answeredBy: 'owner',
    evidence: ['shareholders.register', 'contracts', 'tax.statement'],
    summary:
      'A chapter of F30 the books do not hold: the rows asked, or that there is nothing to report.',
  },
  {
    kind: 'annual.disclosures',
    answeredBy: 'owner',
    evidence: ['contracts', 'aga.decision'],
    summary:
      'What the explanatory notes and the declaration state: parent company, commitments, advances to management, exceptional items, long-term and secured debts, subsequent events, related parties, going concern.',
  },
  {
    kind: 'annual.document',
    answeredBy: 'owner',
    evidence: ['annual.signed', 'aga.decision', 'audit.report'],
    summary:
      'An accompanying document, signed: the engine drafts the notes, the administrators’ report, the profit distribution proposal and the declaration; a person supplies the signed file.',
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['annual.signed'],
    summary:
      'Whether the company has carried out no activity since it was set up (`activity.none`): it then files the inactivity declaration (S1046) instead of the statements.',
  },
];

export interface AgentDetector extends Omit<DeterminationDetector, 'kind'> {
  kind: 'annual.input';
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'annual.input',
    summary:
      'A financial year whose statements (S1005, S1003) or inactivity declaration (S1046) wait on a person: an F30 chapter or the disclosures unanswered, an accompanying document not supplied, the books showing no activity with `activity.none` unknown, or a half-year report owed that the engine does not prepare.',
    rules: [
      'ro.deadline.S1005',
      'ro.deadline.S1003',
      'ro.deadline.S1046',
      'ro.halfyear.report',
      'ro.size.thresholds',
    ],
    next: [
      { operation: 'annual.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'declarations.prepare', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: none, the statements book nothing. */
export const templates: readonly string[] = [];
