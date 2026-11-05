import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs for the D112 period of an employer (Codul fiscal art. 80 alin. (2), art.
 * 147 alin. (4)–(11)): the documents, questions, worklist items and template fields.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'vector.payroll',
    title: 'Vectorul fiscal: perioada D112 (formularele 010, 020, 070, 700)',
    summary:
      'Quarterly or monthly, and "Lunară prin opțiune" (art. 147 alin. (8), by 31 January), as the registration forms of OPANAF nr. 1.699/2021 record it.',
    evidenceFor: ['payroll.period'],
  },
  {
    id: 'medical.certificate',
    title: 'Certificate de concediu medical',
    summary:
      "An employee's sick leave: the month's D112 and the quarter's months before it are filed by the 25th after it (art. 147 alin. (11)).",
    evidenceFor: ['payroll.runs.prepare'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: ['vector.payroll'],
    summary:
      "Confirm the year's D112 period computed from the previous year (payroll.period), or state the monthly option with its filed form.",
  },
];

export interface PayrollDetector {
  kind: 'obligation.due' | 'determination.missing';
  code: string;
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly PayrollDetector[] = [
  {
    kind: 'determination.missing',
    code: 'payroll.period',
    summary:
      "No D112 period for the year: the D112 deadlines and the payment due dates of the payroll's taxes stay unknown.",
    rules: ['ro.payroll.quarterly'],
    next: [{ operation: 'determinations.propose', by: 'agent' }],
  },
  {
    kind: 'obligation.due',
    code: 'D112',
    summary:
      "Each month's D112, due by the 25th after the month, after the quarter for a quarterly employer, or after the month of sick leave or a contract ended and for the quarter's months before it.",
    rules: ['ro.deadline.D112', 'ro.deadline.D112.quarterly'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
];

export const templates: readonly string[] = [];
