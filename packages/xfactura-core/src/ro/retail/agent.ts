import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive retail and B2C (G2; docs/ROADMAP.md, "agent-ready by
 * construction"): the documents it brings in, the questions people answer and the evidence they
 * cite, the worklist items its detectors raise with the rules they enforce, and the fields a
 * booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'retail.zreport',
    title: 'Raport fiscal de închidere zilnică (raport Z) al casei de marcat',
    summary:
      "A register's daily closing report (OUG nr. 28/1999 art. 4 alin. (6)–(7)): from the register's XML export (A4203, OPANAF nr. 146/2018 anexa nr. 2 secțiunea II.7), `retail.importZ`; from a printout or a PDF, `documents.record` kind `zreport` with every amount cited; booked with `retail.zReport`.",
    evidenceFor: ['retail.zReport', 'retail.importZ', 'documents.record'],
  },
  {
    id: 'retail.articles',
    title: 'Raportul pe articole al casei de marcat sau raportul de gestiune',
    summary:
      'What the day sold, item by item: the Z report’s `items` when printed with it (mapped to the catalogue in `retail.zReport` `stock`), or the answer to `retail.goods` when the report gives only totals and goods are kept by quantity at cost.',
    evidenceFor: ['retail.zReport', 'retail.goods'],
  },
  {
    id: 'retail.acquirer.statement',
    title: 'Extrasul de cont cu decontarea încasărilor cu cardul și raportul acceptatorului',
    summary:
      "The acquirer's settlement of card takings, net of its fee: `bank.settle` with `cards`, each Z report's amount settled out of 5125 and the fee on 627.",
    evidenceFor: ['bank.settle'],
  },
  {
    id: 'retail.nir',
    title: 'Notă de recepție la preț de vânzare cu amănuntul (NIR)',
    summary:
      'Goods received into a warehouse kept at retail price: the purchase invoice recognized with `retail`, its parts on the warehouse’s goods accounts (`371.<code>-<rate>`) and each account’s value at sale price, VAT included; the markup (378) and the VAT included (4428) follow.',
    evidenceFor: ['invoices.recognize'],
  },
  {
    id: 'retail.price.change',
    title: 'Proces-verbal de modificare a prețurilor de vânzare',
    summary: 'A change of sale prices in a warehouse at retail price: `retail.reprice`.',
    evidenceFor: ['retail.reprice'],
  },
  {
    id: 'retail.inventory.list',
    title: 'Lista de inventariere la preț de vânzare, pe cote de TVA, cu decizia administratorului',
    summary:
      'A count of a warehouse at retail price (the year-end one included): `retail.count`, the value counted per rate, the cause of a shortage and its proof; the takeover of a warehouse’s goods (`retail.opening`) cites it too.',
    evidenceFor: ['retail.count', 'retail.opening'],
  },
  {
    id: 'retail.register.records',
    title:
      'Documentele casei de marcat: fișa de fiscalizare, înregistrarea în registrul ANAF, contractul de service, cartea de intervenții',
    summary:
      'A fiscal cash register recorded with `retail.registers.record` (its unique number and fiscal series, the location, the warehouse it sells from), and each event (`retail.registers.event`: fiscalization, the ANAF registration, the service contract, the fiscal memory replaced, the register taken out of use) with its document. The engine never talks to the device.',
    evidenceFor: ['retail.registers.record', 'retail.registers.event'],
  },
  {
    id: 'retail.policy',
    title: 'Politicile contabile: mărfurile la cost sau la preț cu amănuntul',
    summary:
      'The administrator’s written policy (OMFP 1802/2014 pct. 286 alin. (8)): `policy.stock.retail` (cost or retail) and `policy.stock.inventory` (permanent for the retail method), recorded as `profile.fact`, the document as evidence.',
    evidenceFor: ['policy.stock.retail', 'policy.stock.inventory'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'retail.goods',
    answeredBy: 'owner',
    evidence: ['retail.articles'],
    summary:
      "The goods a Z report sold when it gives only totals and goods are kept by quantity at cost: the warehouse and each item with its quantity; the report's booking is revised citing the answer.",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['retail.policy'],
    summary:
      'The goods kept at cost or at retail price (`policy.stock.retail`) and the inventory method (`policy.stock.inventory`), which decide how a Z report discharges the goods it sold.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind:
    | 'close.finding'
    | 'question.needed'
    | 'document.unproposed'
    | 'efactura.due'
    | 'retail.register';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'close.finding',
    summary:
      "The month close: ZREPORT_GAP (a register's report numbers skip one: a day not booked), ZREPORT_DAY (a day between two reports without one, the shop closed or a report missing), ZREPORT_CUMULATIVE (the fiscal memory's running total does not follow from the reports), ZREPORT_UNBOOKED; RETAIL_DISCHARGE_MISSING (a warehouse at retail price with exits and no discharge of their markup and VAT), RETAIL_COUNT_MISSING (the financial year's last month without the count at sale price), CARDS_IN_TRANSIT (card takings not settled by the next month's end).",
    rules: ['ro.retail.zreport', 'ro.stock.retail.coefficient'],
    next: [
      { operation: 'retail.importZ', by: 'agent' },
      { operation: 'documents.record', by: 'agent' },
      { operation: 'retail.discharge.propose', by: 'agent' },
      { operation: 'retail.count.propose', by: 'agent' },
      { operation: 'bank.settle.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      'A Z report with only totals while goods are kept by quantity at cost (ZREPORT_GOODS, `retail.goods`), or without the stock policies it reads (POLICY_MISSING).',
    rules: ['ro.retail.zreport'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
  {
    kind: 'document.unproposed',
    summary:
      'A Z report nobody booked: `retail.zReport`; an invoice issued for fiscal receipts is recognized with `retail.receiptInvoice` by `sales.issue` itself.',
    rules: ['ro.retail.zreport'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'efactura.due',
    summary:
      'An issued invoice to a buyer in Romania, B2B or B2C, not yet transmitted to RO e-Factura: due within the working days of `ro.deadline.efactura` from its issue (OUG nr. 120/2021 art. 10 alin. (7), art. 10^1 alin. (2^1)); overdue it blocks.',
    rules: ['ro.deadline.efactura', 'ro.efactura.b2c'],
    next: [{ operation: 'spv.submit', by: 'human' }],
  },
  {
    kind: 'retail.register',
    summary:
      "A fiscal cash register's external obligations (OUG nr. 28/1999 art. 3^1, 4, 5 alin. (3)): its fiscalization and ANAF registration not recorded, its service contract, the archive of its reports, journal and fiscal memory; tracked, never performed by the engine.",
    rules: ['ro.retail.zreport'],
    next: [{ operation: 'retail.registers.event', by: 'human' }],
  },
];

/** The fields a booking template sets: none yet. A register's Z reports repeat their accounts
 * day after day, but templates do not cover `retail.zReport`; a posting policy can post them. */
export const templates: readonly string[] = [];
