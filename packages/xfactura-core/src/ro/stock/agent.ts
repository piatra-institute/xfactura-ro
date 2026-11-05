import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive the stock register (G1; docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it brings in, the questions people answer and the evidence they
 * cite, the worklist items its detectors raise with the rules they enforce, and the fields a
 * booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'stock.policy',
    title:
      'Politicile contabile privind stocurile (metoda de evaluare, inventarul permanent sau intermitent)',
    summary:
      "The administrator's written accounting policies: the output method (FIFO, LIFO, the weighted average after each receipt or monthly; OMFP 1802/2014 pct. 96), perpetual or periodic inventory (pct. 289–291), whether stock may go negative, goods at cost or at the retail price. Recorded as `profile.fact` on the `policy.stock.*` axes, the document as evidence.",
    evidenceFor: [
      'policy.stock.valuation',
      'policy.stock.inventory',
      'policy.stock.negative',
      'policy.stock.retail',
    ],
  },
  {
    id: 'stock.purchase.invoice',
    title: 'Factura furnizorului de mărfuri sau materiale',
    summary:
      'A purchase of goods: `invoices.recognize` with its parts on the items’ stock accounts (371, 30x, 381) and `stock` naming the warehouse and, for each invoice line (BT-126), the catalogue item and the quantity in its unit; a product not yet mapped is asked as `stock.item`.',
    evidenceFor: ['invoices.recognize', 'stock.item'],
  },
  {
    id: 'stock.nir',
    title: 'Notă de recepție și constatare de diferențe (NIR, 14-3-1A)',
    summary:
      "The reception commission's note: what was received of each line, and the differences, given as each `stock.lines[].received` of the invoice's recognition (a shortage claimed from the supplier on 461, an excess owed on 408, acknowledged RECEIPT_DIFFERENCE); with a delivery note and no invoice yet, the evidence of `stock.receive`.",
    evidenceFor: ['invoices.recognize', 'stock.receive'],
  },
  {
    id: 'stock.delivery.note',
    title: 'Aviz de însoțire a mărfii',
    summary:
      "Goods that arrived before their invoice (OMFP 1802/2014 pct. 284 alin. (2) lit. b)): with the NIR, `stock.receive` at the note's prices against 408; the invoice then settles 408 (`accruals.settle`).",
    evidenceFor: ['stock.receive'],
  },
  {
    id: 'stock.consumption.slip',
    title: 'Bon de consum (14-3-4A)',
    summary:
      'Materials given into consumption from a warehouse: `stock.consume`, each item and quantity, onto its stock account’s expense or the one the slip names.',
    evidenceFor: ['stock.consume'],
  },
  {
    id: 'stock.transfer.slip',
    title: 'Bon de predare, transfer, restituire (14-3-3A)',
    summary: 'Goods moved between two warehouses: `stock.transfer`, register moves only.',
    evidenceFor: ['stock.transfer'],
  },
  {
    id: 'stock.inventory.list',
    title: 'Lista de inventariere a stocurilor (14-3-12), pe gestiuni',
    summary:
      'The count: `documents.record` kind `inventory.list`, its `stock` section each item by its catalogue code, unit and warehouse code, with the commission’s value of a surplus; with the administrator’s decision on the proces-verbal, the evidence of `inventory.stock` (and, with an intermittent inventory, of the period’s stock). The register’s takeover (`stock.opening`) cites it too.',
    evidenceFor: ['inventory.stock', 'stock.opening'],
  },
  {
    id: 'stock.shortage.proof',
    title:
      'Dovada cauzei unei lipse: proces-verbal de calamitate, actele organelor judiciare, procesul-verbal de distrugere, norma de perisabilități',
    summary:
      'Why the deducted VAT of a shortage is not adjusted (Codul fiscal art. 304 alin. (2), norme pct. 78 alin. (10)–(12)): each `inventory.stock` cause other than imputed or unimputable cites it.',
    evidenceFor: ['inventory.stock'],
  },
  {
    id: 'stock.realizable.value',
    title: 'Constatările comisiei sau ale evaluatorului privind valoarea realizabilă netă',
    summary:
      'Stock worth less than its cost (OMFP 1802/2014 pct. 88, 292): `impairment.stock`, each item’s net realizable value.',
    evidenceFor: ['impairment.stock'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'stock.item',
    answeredBy: 'owner',
    evidence: ['stock.purchase.invoice'],
    summary:
      "Which catalogue item a supplier's product is (the subject: the supplier's CUI and the product's name on its invoice) and how many of the item's units one invoice unit holds: asked when an agent cannot map a line with certainty, reused for that product's later invoices.",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['stock.policy'],
    summary:
      'The stock policies (`policy.stock.valuation`, `policy.stock.inventory`, `policy.stock.negative`, `policy.stock.retail`) every stock treatment reads at its date (POLICY_MISSING otherwise), and `activity.goods` yes for the closure.',
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
      'The month close: STOCK_LEDGER_DIFFERS when a stock account holds a balance the register does not explain (a booking without moves, an opening not taken over); STOCK_PERIOD_COST_MISSING when, under the periodic average, the month’s exits have no costing.',
    rules: ['ro.stock.accounts', 'ro.stock.methods'],
    next: [
      { operation: 'stock.register', by: 'agent' },
      { operation: 'stock.opening.propose', by: 'agent' },
      { operation: 'stock.periodCost.propose', by: 'agent' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      'A stock treatment without the policy it reads (POLICY_MISSING, a `profile.fact` question on a `policy.stock.*` axis), or a purchase line whose product the agent cannot map (`stock.item`).',
    rules: ['ro.stock.methods'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
  {
    kind: 'yearend.review',
    summary:
      'The annual count: stock the lists leave out (INVENTORY_STOCK_UNLISTED), differences no `inventory.stock` books, or stock the register does not keep (INVENTORY_STOCK, UNSUPPORTED until taken over).',
    rules: ['ro.stock.accounts', 'ro.inventory.accounts', 'ro.vat.stock_adjustment'],
    next: [
      { operation: 'documents.record', by: 'agent' },
      { operation: 'inventory.stock.propose', by: 'agent' },
    ],
  },
  {
    kind: 'document.unproposed',
    summary:
      'A purchase invoice of goods nobody booked: `invoices.recognize` with `stock`; a sale issued with `sales.issue` and `stock` is recognized with its discharge.',
    rules: ['ro.stock.accounts'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
];

/** The fields a booking template sets: none. Each invoice's quantities, items and receptions are
 * its own; the mapping of a supplier's products is the `stock.item` answers'. */
export const templates: readonly string[] = [];
