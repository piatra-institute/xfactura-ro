import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive receipts and the domestic reverse charge (docs/ROADMAP.md,
 * "agent-ready by construction"): the documents it brings in, the questions people answer and
 * the evidence they cite, the worklist items its detectors raise with the rules they enforce,
 * and the fields a booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'receipt',
    title: 'Bon fiscal (cu codul fiscal al companiei, dacă îl are)',
    summary:
      "A fiscal receipt, recorded with `documents.record` (kind `receipt.received`, read with `evidence.read` image mode): with the company's VAT code and at most 100 euro it is a simplified invoice whose VAT is deducted; otherwise its VAT stays in the expense. Booked with `receipts.recognize`.",
    evidenceFor: ['receipts.recognize'],
  },
  {
    id: 'expense.report',
    title: 'Decont de cheltuieli (al salariatului, cu bonurile anexate)',
    summary:
      "An employee's report of what they paid, from an advance (542) or their own money: each receipt is booked with `receipts.recognize` (payment `advance` or `employee`) citing it; expenses without a receipt document go to `cash.expenseReport`.",
    evidenceFor: ['receipts.recognize', 'cash.expenseReport'],
  },
  {
    id: 'vehicle.log',
    title: 'Foaia de parcurs a vehiculului',
    summary:
      'Exclusive business use of a road vehicle (art. 298, norme pct. 68): fuel receipts then deduct their VAT in full; otherwise 50%.',
    evidenceFor: ['vehicle.use'],
  },
  {
    id: 'reverse.charge.invoice',
    title: 'Factură cu mențiunea „taxare inversă” (categoria AE în e-Factura)',
    summary:
      'A domestic supply under art. 331 (waste, timber, cereals, certificates, electricity and gas to traders, real estate taxed, gold, phones and electronics from 22,500 lei): booked with `invoices.reverseCharge`, each part named by its category.',
    evidenceFor: ['invoices.reverseCharge'],
  },
  {
    id: 'trader.declaration',
    title:
      'Declarația pe propria răspundere (formularul 089) și lista ANAF a comercianților de energie electrică și gaze naturale',
    summary:
      'Whether the buyer of electricity or natural gas is a trader whose supplies are reverse-charged (art. 331 alin. (2) lit. e) and l)): the reviewer confirms it when approving (`REVERSE_CHARGE_TRADER`).',
    evidenceFor: ['invoices.reverseCharge'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'vehicle.use',
    answeredBy: 'owner',
    evidence: ['vehicle.log', 'the registration certificate or the contract of an exception'],
    summary:
      "Whether the vehicle a fuel or upkeep receipt concerns is used only for the business: the receipt's VAT is then deducted in full, otherwise 50% (art. 298).",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['registration.certificate'],
    summary:
      'The VAT status (`vat.status`) on the receipt or invoice date: a non-payer deducts nothing and applies no reverse charge.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'document.unproposed' | 'question.needed' | 'obligation.due';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'document.unproposed',
    summary:
      'A receipt without a booking (`receipts.recognize`), or an invoice in category AE (`invoices.reverseCharge`); a receipt that needs none is disposed of by a person.',
    rules: ['ro.vat.simplified_invoice.limit_eur', 'ro.vat.reverse_charge.domestic'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      "A receipt naming a vehicle without an answer about its use (`VEHICLE_USE`), or a date without the company's VAT status: asked, then the proposal is revised citing the answer.",
    rules: ['ro.vat.deduction.limited'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
  {
    kind: 'obligation.due',
    summary:
      "D300 and D394 of the period: receipts deducted on rows 24–25 and in D394's rezumat2 (bazaBFAI, TVABFAI); the reverse charge on D300 rows 12, 13 and 26 and in D394 (V, C).",
    rules: ['ro.deadline.D300', 'ro.deadline.D394'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
];

/** The fields a booking template of `receipts.recognize` sets: the expense account, the
 * deduction or the vehicle whose answer decides it, and how the receipts are paid (card or the
 * cash desk); e.g. the fuel of one station. */
export const templates: readonly string[] = ['account', 'deduction', 'vehicle', 'payment'];
