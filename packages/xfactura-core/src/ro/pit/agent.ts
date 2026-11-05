import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive the books and the D212 of a PFA, II or IF (docs/PFA_II_IF.md §7):
 * the documents it may bring in, the questions people answer, the worklist items that move the
 * work on, and the fields a booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'pfa.authorization',
    title: 'Certificat de înregistrare / autorizație (PFA, II, IF) și mențiunile lui',
    summary:
      'The registration of each income source: activity (CAEN), place, start, suspension and end; a mention adding an activity outside the nomenclator dates the move from a norm to the real system (norme pct. 8 alin. (13)).',
    evidenceFor: ['entity.form', 'books.system', 'pfa.sources.record'],
  },
  {
    id: 'dgrfp.norms',
    title: 'Normele de venit publicate de DGRFP (decizia, cu data ei)',
    summary:
      "The norm of an activity and place and its correction coefficients; for 2025 the decision's date sets the minimum wage of the floor (art. 69 alin. (3) before Legea nr. 239/2025).",
    evidenceFor: ['pfa.fiscalRegister.norms'],
  },
  {
    id: 'pfa.attribution',
    title: 'Nota de repartizare pe surse (conturi și cheia cheltuielilor comune)',
    summary:
      "The person's statement of which accounts are each source's and how an expense serving several sources is split (by gross income or fixed shares): no text sets a key (`ro.pit.sources`).",
    evidenceFor: ['pfa.fiscalRegister.attribution'],
  },
  {
    id: 'income.statement',
    title: 'Documente pentru veniturile din afara activității (chirii, dividende, dobânzi)',
    summary:
      'Contracts, broker or bank statements and the payer’s certificates of the income the person declares for the CASS of art. 170 alin. (2)–(3), with the CASS and tax withheld.',
    evidenceFor: ['pfa.fiscalRegister.declaredIncome'],
  },
  {
    id: 'pfa.double_entry.option',
    title: 'Opțiunea pentru contabilitatea în partidă dublă',
    summary:
      "The person's choice under OMFP nr. 170/2015 art. 3–4: recorded as stated, reported UNSUPPORTED (PFA_DOUBLE_ENTRY).",
    evidenceFor: ['books.system'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['pfa.authorization', 'pfa.double_entry.option'],
    summary:
      "The person's facts the books cannot compute: the legal form, the books system, the CAS status and the CASS exception at 31 December.",
  },
  {
    kind: 'evidence.missing',
    answeredBy: 'owner',
    evidence: ['pfa.attribution', 'dgrfp.norms', 'income.statement'],
    summary:
      "What the fiscal register needs and only the person has: each source's accounts and the key of shared expenses, a norm and its decision's date, income from outside the books.",
  },
];

/** A worklist item that moves this work on, and the rules it stands for. */
export interface PitDetector {
  /** The worklist kind (`work.list`) the item comes as. */
  kind: 'obligation.due' | 'close.finding' | 'rule.gap';
  /** The issue or check code inside it. */
  code: string;
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly PitDetector[] = [
  {
    kind: 'close.finding',
    code: 'PFA_NATURE_MISSING',
    summary: 'A receipt or payment without a nature: the month does not close (pfa.natures).',
    rules: ['ro.pit.natures'],
    next: [{ operation: 'proposals.propose', by: 'agent' }],
  },
  {
    kind: 'obligation.due',
    code: 'D212',
    summary:
      'The D212 of an income year is due by 25 May of the next: the register is prepared with the attribution per source, the norms and the declared income; a blocking issue (PIT_SOURCE_UNATTRIBUTED, PIT_SHARED_KEY, PIT_NORM_SET_DATE, D212_DECLARED_TAX…) names what to ask.',
    rules: ['ro.deadline.D212', 'ro.pit.sources', 'ro.pit.norma', 'ro.cass.other'],
    next: [
      { operation: 'pfa.fiscalRegister', by: 'agent' },
      { operation: 'declarations.prepare', by: 'agent' },
    ],
  },
  {
    kind: 'rule.gap',
    code: 'RULE_GAP',
    summary:
      'A year without its rules (the 2024 income, 2027): the register and the D212 stop, never computed with a value that may be wrong.',
    rules: ['ro.pit.rate', 'ro.pit.norma', 'ro.cass.independent'],
    next: [],
  },
];

/** The fields a booking template sets: none of its own; a PFA books through the SRL treatments. */
export const templates: readonly string[] = [];
