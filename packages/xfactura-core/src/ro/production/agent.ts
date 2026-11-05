import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive production (G4; docs/ROADMAP.md, "agent-ready by construction"):
 * the documents it brings in, the questions people answer and the evidence they cite, the
 * worklist items its detectors raise with the rules they enforce, and the fields a booking
 * template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'production.policy',
    title: 'Politicile contabile privind costul produselor (cost standard sau cost efectiv)',
    summary:
      "The administrator's written accounting policy: products at the standard cost with their price differences on 348 (OMFP 1802/2014 pct. 286 alin. (1)–(3)) or at the actual production cost (pct. 8 pct. 7). Recorded as `profile.fact` on `policy.production.cost`, the document as evidence; the stock policies (`policy.stock.*`) apply to products too.",
    evidenceFor: ['policy.production.cost'],
  },
  {
    id: 'production.bom',
    title: 'Fișa tehnică (norma de consum) și antecalculația costului standard',
    summary:
      'A product’s bill of materials: the materials per output quantity, the labour and machine hours, and the standard cost of the output (pct. 286 alin. (2): normal levels, revised periodically). `production.boms.record`, each revision a new dated version.',
    evidenceFor: ['production.boms.record'],
  },
  {
    id: 'production.order',
    title: 'Comanda de producție (fișa de lansare)',
    summary:
      'A work order launched for a product: its number, the BOM version it is costed on, the quantity and the day it opened (`production.orders.open`); its closing, when the last products are delivered or the order is abandoned (`production.orders.close`).',
    evidenceFor: ['production.orders.open', 'production.orders.close'],
  },
  {
    id: 'production.consumption.slip',
    title: 'Bon de consum pe comandă (14-3-4A)',
    summary:
      'Materials given to a work order from a warehouse: `production.consume`, each item and quantity, onto its stock account’s expense tagged with the order.',
    evidenceFor: ['production.consume'],
  },
  {
    id: 'production.handover',
    title: 'Bon de predare a produselor finite (14-3-3A) sau notă de predare',
    summary:
      'Products a work order hands over to a warehouse: `production.output` at the standard cost (residual products at the commission’s net realizable value); under the actual cost, the closing month’s `production.cost` outputs.',
    evidenceFor: ['production.output', 'production.cost'],
  },
  {
    id: 'production.timesheet',
    title: 'Pontajul pe comenzi (orele lucrate de fiecare salariat pe fiecare comandă)',
    summary:
      'The direct labour of the month: each contract’s hours, in total and on each order, for `production.cost` labour `hours` with the month’s payroll run; or the key a person states (`stated`).',
    evidenceFor: ['production.cost'],
  },
  {
    id: 'production.machine.log',
    title: 'Evidența orelor de funcționare a utilajelor pe comenzi',
    summary:
      'The machine hours of each order in the month: the key of the overheads allocated on `machine_hours`.',
    evidenceFor: ['production.cost'],
  },
  {
    id: 'production.capacity',
    title: 'Capacitatea normală de producție (studiul sau decizia administratorului)',
    summary:
      'The normal capacity a fixed overhead pool is absorbed at (pct. 8 pct. 7, pct. 79 alin. (2)): the production expected on average under normal conditions, in the key’s hours; or the statement that the actual level approximates it.',
    evidenceFor: ['production.cost'],
  },
  {
    id: 'production.wip.count',
    title: 'Lista de inventariere a producției în curs de execuție',
    summary:
      'The count of the unfinished production at the month’s end (pct. 288): each open order’s units in progress and their degree of completion, on a work-in-progress item (331) of a warehouse; at the year’s end, the inventory list’s stock section lists the same items.',
    evidenceFor: ['production.cost', 'inventory.stock'],
  },
  {
    id: 'production.loss.record',
    title: 'Procesul-verbal al pierderilor peste normă sau nota tehnologului',
    summary:
      'Why a closed order consumed more than its norm: an abnormal loss left out of the cost (pct. 79) or a normal consumption the norm did not foresee; the evidence of the `production.excess` answer.',
    evidenceFor: ['production.excess'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'production.excess',
    answeredBy: 'owner',
    evidence: ['production.loss.record'],
    summary:
      "Whether the materials a closed work order consumed above its BOM's norm were an abnormal loss (an expense of the period, pct. 79) or a normal consumption (part of the products' cost): asked by `production.cost`, never decided by the engine.",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['production.policy'],
    summary:
      'The cost method `policy.production.cost` (standard or actual) every production treatment reads at its date (POLICY_MISSING otherwise), beside the stock policies `policy.stock.*`.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'close.finding' | 'question.needed' | 'yearend.review' | 'document.unproposed';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'close.finding',
    summary:
      'The month close: PRODUCTION_WIP_REVERSAL_MISSING when the previous month’s work in progress was not taken back on the month’s first day; PRODUCTION_COST_MISSING when a month with production postings or work in progress has no costing; PRODUCTION_DIFFERENCES_MISSING when, at the standard cost, products left the warehouse and their price differences were not spread.',
    rules: ['ro.production.accounts', 'ro.production.costing', 'ro.production.coefficient'],
    next: [
      { operation: 'production.wipReverse.propose', by: 'agent' },
      { operation: 'production.cost.propose', by: 'agent' },
      { operation: 'production.differences.propose', by: 'agent' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      'A production treatment without the cost method (POLICY_MISSING, `profile.fact` on `policy.production.cost`), or a closed order’s excess over its norm (`production.excess`).',
    rules: ['ro.production.costing', 'ro.production.accounts'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    summary:
      'The annual count: products and work in progress are items of the stock register, counted with the rest (`inventory.stock`, their shortages onto 711) and written down to their net realizable value (`impairment.stock`, 393 and 394x).',
    rules: ['ro.stock.accounts', 'ro.production.accounts'],
    next: [
      { operation: 'documents.record', by: 'agent' },
      { operation: 'inventory.stock.propose', by: 'agent' },
      { operation: 'impairment.stock.propose', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: none. Each slip's items, quantities and orders are its
 * own, and the month's costing is computed. */
export const templates: readonly string[] = [];
