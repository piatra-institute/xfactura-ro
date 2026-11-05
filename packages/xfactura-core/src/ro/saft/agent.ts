import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive D406 (docs/ROADMAP.md, "agent-ready by construction"): the
 * documents it may bring in, the questions people answer, the worklist items that raise the
 * returns and the rules they enforce, and the fields a booking template sets (none: D406 books
 * nothing). The periodic file and the annual assets file are prepared with
 * `declarations.prepare` (kind D406, a month or quarter, or the financial year).
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'anaf.category',
    title: 'Încadrarea ANAF în categoria marilor sau mijlociilor contribuabili',
    summary:
      "ANAF's notice or list placing the company among the large or medium taxpayers, with its date: before 2025 it decides from when D406 is filed.",
    evidenceFor: ['taxpayer.category'],
  },
  {
    id: 'asset.disposal',
    title: 'Procesul-verbal de scoatere din funcțiune, de casare, sau factura de vânzare',
    summary:
      'How a fixed asset left the register (sold, scrapped, other): the annual assets file reports the movement under its code (disposals option), a sale with its invoice.',
    evidenceFor: ['assets.dispose'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['anaf.category'],
    summary:
      'The taxpayer category (`taxpayer.category`: large, medium, small) and its date, asked only for months before 1 January 2025, when the category decides whether D406 is filed.',
  },
];

/** A worklist item kind that raises D406, and the rules it enforces. */
export interface AgentDetector {
  kind: 'obligation.due';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'obligation.due',
    summary:
      "A D406 due, overdue or blocked in the obligations calendar: the periodic file of each VAT period (quarterly outside VAT), and the annual assets file of a financial year a company holding fixed assets reports whole, by the statements' deadline; blocked when the taxpayer category before 2025 is unknown or the case is not covered.",
    rules: ['ro.deadline.D406', 'ro.deadline.D406.assets', 'ro.d406.start'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'declarations.prepare', by: 'agent' },
      { operation: 'declarations.authorize.request', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: none, D406 books nothing. */
export const templates: readonly string[] = [];
