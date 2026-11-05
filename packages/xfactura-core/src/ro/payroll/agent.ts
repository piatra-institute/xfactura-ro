import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive payroll (docs/ROADMAP.md, "agent-ready by construction"): the D112
 * period of an employer (Codul fiscal art. 80 alin. (2), art. 147 alin. (4)–(11)) and the payroll
 * extras (W1): benefits in kind, the medical-leave codes, corrections of a posted month with the
 * rectifying D112, garnishments, the administrator's mandate and REGES-ONLINE as an external
 * obligation. Payroll operations are a person's: the agent asks, reads and prepares the returns.
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
      "An employee's sick leave, of any indemnity code the register computes (ro.sick.codes): the month's D112 and the quarter's months before it are filed by the 25th after it (art. 147 alin. (11)).",
    evidenceFor: ['payroll.runs.prepare', 'payroll.absences'],
  },
  {
    id: 'benefit.document',
    title:
      'Documentul avantajului în natură (fișa mijlocului fix, contractul de închiriere, polița, factura cadourilor, foaia de parcurs)',
    summary:
      "The value of a benefit in kind (norme pct. 14 alin. (3): attached to the payroll): a car's input value or rent and its private kilometres, the rent of housing, the gifts per person, the premium. Evidence for the benefits of payroll.runs.prepare.",
    evidenceFor: ['payroll.benefits', 'payroll.runs.prepare'],
  },
  {
    id: 'garnishment.order',
    title:
      'Adresa de înființare a popririi (executor judecătoresc, ANAF, instanță) și adresa de ridicare',
    summary:
      'A garnishment on an employee’s salary: the creditor, the kind of debt (maintenance, the state, other), the amount to recover and what to withhold each month. Evidence for payroll.garnishments.record and .release.',
    evidenceFor: ['payroll.garnishments.record', 'payroll.garnishments.release'],
  },
  {
    id: 'mandate.contract',
    title: 'Contractul de mandat (de administrare) și hotărârea AGA de numire și remunerare',
    summary:
      "An administrator's remuneration without an employment contract (art. 76 alin. (2) lit. o)): the monthly remuneration, and whether the person declares the main job there (the personal deduction). Evidence for payroll.contracts.record with kind mandate.",
    evidenceFor: ['payroll.contracts.record'],
  },
  {
    id: 'correction.document',
    title:
      'Documentul corecției unei luni (actul adițional retroactiv, nota de constatare a erorii)',
    summary:
      'Why a posted month is computed again: an error found after posting or filing, or a retroactive change of terms. Evidence for payroll.runs.prepare with correction.',
    evidenceFor: ['payroll.runs.prepare'],
  },
  {
    id: 'reges.receipt',
    title: 'Recipisa REGES-ONLINE',
    summary:
      'The receipt of a transmission to REGES-ONLINE (HG nr. 295/2025): the contract before its start, a change, its end. Evidence for payroll.reges.record.',
    evidenceFor: ['payroll.reges.record'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'payroll.benefits',
    answeredBy: 'owner',
    evidence: ['benefit.document'],
    summary:
      "The month's benefits in kind per employee, with the document of each value, before the payroll is prepared.",
  },
  {
    kind: 'payroll.absences',
    answeredBy: 'owner',
    evidence: ['medical.certificate'],
    summary: "The month's absences, each medical certificate with its indemnity code.",
  },
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: ['vector.payroll'],
    summary:
      "Confirm the year's D112 period computed from the previous year (payroll.period), or state the monthly option with its filed form.",
  },
];

export interface PayrollDetector {
  kind: 'obligation.due' | 'determination.missing' | 'payroll.due';
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
  {
    kind: 'payroll.due',
    code: 'reges',
    summary:
      'A contract, a change of its terms or its end not yet recorded as transmitted to REGES-ONLINE: the start by the day before it (Codul muncii art. 16 alin. (2)); the changes and ends without a sourced deadline (HG nr. 295/2025 to obtain) block.',
    rules: ['ro.deadline.reges.start'],
    next: [{ operation: 'payroll.reges.record', by: 'human' }],
  },
  {
    kind: 'payroll.due',
    code: 'D112.rectifying',
    summary:
      'A month corrected after its D112 was filed: the rectifying D112 (d_rec 1) declares the corrected run in full (OPANAF nr. 605/2026 anexa nr. 6 cap. II pct. 2).',
    rules: ['ro.payroll.correction.retroactive'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
];

export const templates: readonly string[] = [];
