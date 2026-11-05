import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive withholding (O1, docs/ROADMAP.md, "agent-ready by construction"):
 * the documents it brings in, the questions people answer, the worklist items that raise the
 * returns and the rules they enforce, and the fields a booking template sets.
 *
 * - Rent and intellectual property paid to a resident individual: `payees.recognize` books what
 *   the contract makes owed (612 or the account of the right, against 462), `payees.withhold`
 *   the tax at each payment; the net goes out through `bank.settle` on the same 462 item.
 * - Interim dividends: `dividends.interim` (463 = 456), the tax at payment with
 *   `dividends.withhold` on the 456 item, `dividends.regularize` (457 = 463) once the annual
 *   dividends are distributed.
 * - Non-residents: `nonresidents.withhold` on the supplier's, lender's or shareholder's item,
 *   once a person has determined what the payments are (`nonresident.payee`); the treaty's rate
 *   needs the certificate (`nonresident.certificate`), without which the domestic rate applies.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'rental.contract',
    title: 'Contract de închiriere (de comodat, de locațiune) cu o persoană fizică',
    summary:
      'The contract under which the company uses a good of an individual: the rent, the period, the currency, who bears the expenses. Evidence for payees.recognize (kind rent).',
    evidenceFor: ['payees.recognize'],
  },
  {
    id: 'ip.contract',
    title:
      'Contract de cesiune sau de licență a drepturilor de autor / de proprietate intelectuală',
    summary:
      'The assignment or licence of a right of an individual author: the remuneration, whether the payer withholds CAS and CASS, the author’s option for the real system. Evidence for payees.recognize (kind royalties) and the facts payees.withhold asks.',
    evidenceFor: ['payees.recognize', 'payees.withhold'],
  },
  {
    id: 'nonresident.contract',
    title: 'Contractul cu nerezidentul (licență de software, împrumut, servicii, comision)',
    summary:
      'What a non-resident is paid for: the rights a software licence grants (a royalty when more than the right to use the program, Codul fiscal art. 7 pct. 36), where a service is performed. Evidence for the nonresident.payee answer.',
    evidenceFor: ['nonresident.payee'],
  },
  {
    id: 'residence.certificate',
    title: 'Certificat de rezidență fiscală (cu traducere autorizată)',
    summary:
      'The certificate of tax residence a non-resident presents at payment (art. 230 alin. (2)): the state and year it attests. Valid in the year presented and the first 60 days of the next.',
    evidenceFor: ['nonresident.certificate'],
  },
  {
    id: 'tax.treaty',
    title: 'Convenția de evitare a dublei impuneri, așa cum a fost publicată',
    summary:
      'The treaty between Romania and the state of residence, as published (Monitorul Oficial or the ratifying law): the article and the rate for the income. Evidence for the nonresident.certificate answer.',
    evidenceFor: ['nonresident.certificate'],
  },
  {
    id: 'interim.statements',
    title: 'Situațiile financiare interimare și hotărârea AGA de repartizare a dividendelor',
    summary:
      'The interim balance sheet and profit and loss account approved by the shareholders, and their decision distributing dividends during the year (OMFP nr. 3.067/2018). Evidence for dividends.interim.',
    evidenceFor: ['dividends.interim'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'nonresident.payee',
    answeredBy: 'owner',
    evidence: ['nonresident.contract'],
    summary:
      'What a non-resident is paid for (dividends, interest, royalties, commissions, services taxable in Romania, or income not taxable in Romania) and whether the beneficiary is a company or an individual: a per-supplier determination, asked when nonresidents.withhold finds none.',
  },
  {
    kind: 'nonresident.certificate',
    answeredBy: 'owner',
    evidence: ['residence.certificate', 'tax.treaty'],
    summary:
      "The non-resident's residence certificate and the treaty's article and rate for the income: asked when a payment is withheld at the domestic rate for want of a valid one.",
  },
];

/** A worklist item kind that raises withholding, and the rules it enforces. */
export interface AgentDetector {
  kind: 'obligation.due' | 'question.needed';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'obligation.due',
    summary:
      'A D100 for each month with tax withheld at source (dividends, interest, rent, non-residents), a D205 for each year with resident beneficiaries, a D207 for each year with non-resident ones; D112 for intellectual property is listed as unsupported.',
    rules: [
      'ro.deadline.D100.dividends',
      'ro.deadline.D100.withholding',
      'ro.deadline.D205',
      'ro.deadline.D207',
    ],
    next: [
      { operation: 'declarations.prepare', by: 'agent' },
      { operation: 'declarations.authorize.request', by: 'agent' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      'A non-resident payment waiting for its determination (nonresident.payee) or withheld at the domestic rate without a valid residence certificate (nonresident.certificate).',
    rules: ['ro.nonresident.tax_rate', 'ro.dividend.tax_rate', 'ro.nonresident.certificate_days'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: none, the withholdings book from contracts and items, not
 * from a document a template predicts. */
export const templates: readonly string[] = [];
