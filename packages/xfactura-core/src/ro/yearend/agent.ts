import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive the year-end in full (docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it may bring in (the inventory's lists, the commission's
 * proces-verbal and the administrator's decision, the partners' confirmations, the evaluator's
 * report), the questions people answer, the worklist items its detector raises with the rules
 * they enforce, and the fields a booking template sets (none: every year-end booking is a
 * person's judgment on evidence).
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'inventory.list',
    title: 'Liste de inventariere (imobilizări, casă, bănci, terți, stocuri)',
    summary:
      "The annual inventory's signed lists at the financial year's last day (OMF 2861/2009 pct. 18, 28–35): fixed assets by inventory number found or missing with the commission's value, cash counted, bank balances on the year-end statements, partners' confirmed balances, stock by quantity. Transcribed with documents.record (kind inventory.list), every amount cited; inventory.compare sets them against the books.",
    evidenceFor: ['inventory.differences', 'impairment.assets', 'inventory.compare'],
  },
  {
    id: 'inventory.decision',
    title:
      'Decizia de numire a comisiei de inventariere, procesul-verbal al comisiei și decizia administratorului asupra propunerilor',
    summary:
      "The commission's appointment (pct. 6), its proces-verbal of the results (pct. 42) and the administrator's decision on its proposals within 7 working days (pct. 43): the evidence `inventory.differences`, `impairment.*` and the imputations cite.",
    evidenceFor: ['inventory.differences', 'impairment.receivables', 'impairment.assets'],
  },
  {
    id: 'partner.confirmation',
    title: 'Extrase de cont confirmate de clienți și furnizori (cod 14-6-3)',
    summary:
      "A partner's statement of its balance at the year end, confirmed or disputed (pct. 28): its balance is a row of the list's partners section.",
    evidenceFor: ['inventory.compare'],
  },
  {
    id: 'collectibility.evidence',
    title:
      'Documente despre încasarea creanțelor: hotărâri de deschidere a insolvenței sau a falimentului, cereri de chemare în judecată, corespondență',
    summary:
      "What shows a customer's receivables are doubtful, in litigation, in insolvency or in a bankruptcy declared: the answer to receivable.collectibility cites it, and art. 26 alin. (1) lit. j) needs the court decision.",
    evidenceFor: ['receivable.collectibility'],
  },
  {
    id: 'valuation.report',
    title: 'Raportul evaluatorului autorizat sau lista comisiei cu valoarea de inventar',
    summary:
      'The value of a fixed asset at the year end set by the commission or an authorized evaluator (OMFP 1802/2014 pct. 85): the evidence of impairment.assets.',
    evidenceFor: ['impairment.assets'],
  },
  {
    id: 'leave.computation',
    title:
      'Calculul concediilor de odihnă neefectuate (evidența concediilor și statele de salarii)',
    summary:
      "The untaken leave per employee at the year end, at each contract's daily average, with the employer's contributions: the evidence of leave.untaken.",
    evidenceFor: ['leave.untaken'],
  },
  {
    id: 'provision.evidence',
    title:
      'Documentele obligațiilor provizionate (acțiuni în instanță și opinia avocatului, contracte de garanție, decizii de restructurare sau de acordare a primelor)',
    summary:
      'What shows a current obligation at the year end and its best estimate (OMFP 1802/2014 pct. 369–388): the evidence of provisions.review and provisions.record.',
    evidenceFor: ['provisions.review', 'provisions.record'],
  },
  {
    id: 'impairment.policy',
    title: 'Politica contabilă privind ajustările pentru deprecierea creanțelor',
    summary:
      'The written accounting policy for testing receivables at the year end: each one individually, or every one overdue beyond a number of days; the evidence of the `policy.impairment.receivables` fact.',
    evidenceFor: ['policy.impairment.receivables'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'receivable.collectibility',
    answeredBy: 'owner',
    evidence: ['collectibility.evidence'],
    summary:
      "How collectible a customer's receivables are at the year end (status, the share recoverable, guaranteed, affiliated): asked for every customer the policy tests or a person flags; it decides the impairment on 491 and its deductible part.",
  },
  {
    kind: 'leave.untaken',
    answeredBy: 'owner',
    evidence: ['leave.computation'],
    summary:
      "The employees' untaken annual leave at the year end and its cost: asked of every employer; a debt on 4281 when measured on the payroll records, else a provision on 1518.",
  },
  {
    kind: 'provisions.review',
    answeredBy: 'owner',
    evidence: ['provision.evidence'],
    summary:
      'The obligations at the year end a provision is recognized for (lawsuits, warranties, restructuring, bonuses, others), or none: asked of every company keeping double entry.',
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['impairment.policy'],
    summary:
      "The company's policy for testing receivables (`policy.impairment.receivables`: individual, overdue_90, overdue_180, overdue_270 or overdue_365), asked when receivables are overdue at the year end.",
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'yearend.review';
  /** The review's item (`details.check`). */
  check: string;
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'yearend.review',
    check: 'inventory.lists',
    summary:
      "The financial year's annual inventory is not recorded, or its lists leave out an asset, a cash desk or a bank account the books hold (OMF 2861/2009 pct. 2, 4, 29, 34).",
    rules: ['OMF2861/2009:pct.1-2', 'OMF2861/2009:pct.4', 'OMF2861/2009:pct.29'],
    next: [
      { operation: 'documents.record', by: 'agent' },
      { operation: 'inventory.compare', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'inventory.differences',
    summary:
      "The inventory found cash or fixed-asset differences that no `inventory.differences` posting of its date books; a bank's balance differs from its statement; stock is held (not covered until G1).",
    rules: ['ro.inventory.accounts', 'OMF2861/2009:pct.39-40', 'OMF2861/2009:pct.44-45'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'assets.dispose', by: 'human' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'inventory.partners',
    summary:
      'A partner disputed its balance or did not reply to the confirmation (pct. 28): investigated, never booked from the list; a person disposes of it with the explanation.',
    rules: ['OMF2861/2009:pct.28'],
    next: [{ operation: 'inventory.compare', by: 'agent' }],
  },
  {
    kind: 'yearend.review',
    check: 'impairment.receivables',
    summary:
      "Receivables overdue at the year end without the company's testing policy, a tested customer without the answer about its receivables, or an impairment the answers call for that no `impairment.receivables` posting books.",
    rules: ['ro.impairment.accounts', 'OMFP1802/2014:pct.331-332', 'OMFP1802/2014:pct.353'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'proposals.propose', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'provisions',
    summary:
      'An employer without the answer about the untaken leave, a company without the review of its obligations, or a provision the answers state that no posting books at their amount.',
    rules: ['ro.provisions.accounts', 'OMFP1802/2014:pct.335,338', 'OMFP1802/2014:pct.369-377'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'proposals.propose', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'cutoff',
    summary:
      "The cut-off at the year's last day: accruals (408, 418) still open, deferrals (471, 472) whose balance is not the part of later years, foreign-currency monetary items not at the closing rate or held where fx.revalue does not reach, e-Factura invoices dated in the year and not booked.",
    rules: ['OMFP1802/2014:pct.94', 'OMFP1802/2014:pct.325', 'OMFP1802/2014:pct.351'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'inventory.stock',
    summary:
      'Stock held on class 3 or listed in the inventory: UNSUPPORTED until the stock module (G1); its differences are booked outside the engine.',
    rules: ['OMF2861/2009:pct.39-40'],
    next: [],
  },
  {
    kind: 'yearend.review',
    check: 'result',
    summary:
      "The year's result: for a profit payer the year's profit tax, after the impairments and provisions (OMFP 1802/2014 pct. 388 alin. (3)); then the revenue and expenses closed into 121.",
    rules: ['OMFP1802/2014:pct.387-388'],
    next: [
      { operation: 'yearend.profitDeterminations', by: 'agent' },
      { operation: 'proposals.propose', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    check: 'year.opening',
    summary:
      "A closed year's next year opens otherwise than the recorded closing snapshot (an account, open item, asset or carried balance), or an opening entry counts the balances twice.",
    rules: ['OMF2861/2009:pct.44-45'],
    next: [{ operation: 'years.opening', by: 'agent' }],
  },
  {
    kind: 'yearend.review',
    check: 'year.close',
    summary:
      "The year's last month is closed and the year is not: request the reviewed year close, which records the itemized closing snapshot and locks the year; once the next year's books open, their opening is checked against it.",
    rules: ['OMF2861/2009:pct.44-45', 'OMFP1802/2014:pct.82-84'],
    next: [{ operation: 'years.close.request', by: 'agent' }],
  },
];

/** The fields a booking template sets: none (each year-end booking is a judgment on evidence). */
export const templates: readonly string[] = [];
