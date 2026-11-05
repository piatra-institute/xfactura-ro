import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive the special VAT schemes (docs/ROADMAP.md, "agent-ready by
 * construction"): the margin schemes of travel agencies (art. 311) and of second-hand goods,
 * works of art, collectors' items and antiques (art. 312), and the agricultural flat rate (art.
 * 315^1): the documents it brings in, the questions people answer and the evidence they cite, the
 * worklist items its detectors raise with the rules they enforce, and the fields a booking
 * template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'margin.travel.invoice',
    title: 'Factură către călător cu mențiunea „regimul marjei - agenții de turism”',
    summary:
      "A travel agency's sale of a single service (art. 311): no VAT shown, the mention in the exemption reason (BT-120). Booked with `margin.sale` (scheme travel) at its price; its VAT comes with the period's margin (`margin.travel`). Issued with `sales.issue` and `margin: { scheme: 'travel' }`.",
    evidenceFor: ['margin.sale'],
  },
  {
    id: 'travel.cost.invoice',
    title: 'Facturile furnizorilor serviciului unic (transport, cazare, masă) pentru călători',
    summary:
      "What other taxable persons supplied for the traveller's direct benefit: booked with `invoices.recognize` and `deduction: none` (art. 311 alin. (6)), or with `margin.purchase` (scheme travel) when bought from another agency under the scheme; each is a cost of a trip in `margin.travel`.",
    evidenceFor: ['invoices.recognize', 'margin.purchase', 'margin.travel'],
  },
  {
    id: 'travel.computation',
    title: 'Situația de calcul a marjei perioadei, cu jurnalele separate de vânzări și cumpărări',
    summary:
      'The working paper of the period (norme pct. 85 alin. (4)): every single service supplied in it, with its sales and costs; the evidence of `margin.travel`.',
    evidenceFor: ['margin.travel'],
  },
  {
    id: 'margin.self.invoice',
    title:
      'Autofactura emisă persoanei fizice de la care se cumpără bunul (norme pct. 86 alin. (6) lit. d))',
    summary:
      'An item bought for resale from a person not taxable: the dealer issues the self-invoice (number and date, the date of the purchase, the parties, its VAT code, the goods and the price), recorded with `documents.record` (kind `invoice.received`) and booked with `margin.purchase` (scheme goods, supplier individual).',
    evidenceFor: ['margin.purchase'],
  },
  {
    id: 'margin.dealer.invoice',
    title:
      'Factura unui revânzător cu mențiunea „regimul marjei - bunuri second-hand” (opere de artă, obiecte de colecție și antichități)',
    summary:
      'An item bought from another dealer that applied the scheme (art. 312 alin. (2) lit. d)), an exempt supply of art. 292 alin. (2) lit. g) or a small enterprise selling a capital good (with the mention of norme pct. 86 alin. (7)): booked with `margin.purchase` into 371, the item its document.',
    evidenceFor: ['margin.purchase'],
  },
  {
    id: 'margin.goods.invoice',
    title: 'Factura de vânzare a bunului, fără TVA înscrisă, cu mențiunea regimului marjei',
    summary:
      "A dealer's sale under the scheme: each item named by its purchase document, its VAT on its own margin (`margin.sale` scheme goods); `regime: normal` for a supply invoiced with VAT on its whole price (art. 312 alin. (7)).",
    evidenceFor: ['margin.sale'],
  },
  {
    id: 'farmer.invoice',
    title:
      'Factura agricultorului în regim special, cu mențiunea regimului, procentul și compensația în cotă forfetară',
    summary:
      'A purchase from a farmer applying art. 315^1: the products and the 8% compensation, no VAT. Booked with `invoices.flatRate`; the compensation is deducted like VAT (D300 rd. 27) once a person answers `farmer.register` with the register extract.',
    evidenceFor: ['invoices.flatRate'],
  },
  {
    id: 'farmer.register.extract',
    title: 'Extrasul din Registrul agricultorilor care aplică regimul special (site-ul ANAF)',
    summary:
      "Whether, and from when, a farmer is in the register (art. 315^1 alin. (5)): the compensation is deducted only for supplies made while it is (norme pct. 87^1 alin. (15)). The evidence of `farmer.register`, and of the company's own `vat.agriculture` when it is the farmer.",
    evidenceFor: ['farmer.register', 'vat.agriculture'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'farmer.register',
    answeredBy: 'owner',
    evidence: ['farmer.register.extract'],
    summary:
      "Whether the supplier of a flat-rate invoice is in ANAF's register of farmers applying the special regime on the supply's day, and from when: without it the compensation is not deducted (norme pct. 87^1 alin. (15)).",
  },
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['registration.certificate', 'farmer.register.extract'],
    summary:
      "The VAT status (`vat.status`) on the operation's date; for a dealer, whether it keeps only individual items under the margin scheme (`activity.goods` margin_goods: no quantity stock until G1); for a PFA, II or IF, whether it is a farmer in the register (`vat.agriculture` special).",
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'margin.travel' | 'document.unproposed' | 'question.needed' | 'obligation.due';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'margin.travel',
    summary:
      "A VAT period with a travel agency's sales under the scheme counted in no posted computation, once the period ended: the margin's VAT is the period's (art. 311 alin. (4), norme pct. 85 alin. (4)); blocking once the period's D300 is due.",
    rules: ['ro.vat.margin.travel'],
    next: [{ operation: 'proposals.propose', by: 'agent' }],
  },
  {
    kind: 'document.unproposed',
    summary:
      "An invoice whose exemption reason states «regimul marjei»: a sale (`margin.sale`) or a purchase (`margin.purchase`), its scheme read from the mention; a farmer's invoice is recognized with `invoices.flatRate` (its mention is a note the parser does not read).",
    rules: ['ro.vat.margin.travel', 'ro.vat.margin.goods', 'ro.vat.flat_rate.agriculture'],
    next: [
      { operation: 'proposals.propose', by: 'agent' },
      { operation: 'work.dispose', by: 'human' },
    ],
  },
  {
    kind: 'question.needed',
    summary:
      "A flat-rate purchase without the farmer's register answer (`FLAT_RATE_REGISTER`), a dealer's item without the statement that only individual items are kept (`MARGIN_STOCK`): asked, then the proposal is revised citing the answer.",
    rules: ['ro.vat.flat_rate.agriculture', 'ro.vat.margin.goods'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
      { operation: 'proposals.revise', by: 'agent' },
    ],
  },
  {
    kind: 'obligation.due',
    summary:
      "D300 and D394 of the period: the margins' VAT on rd. 9 (base and VAT), purchases under the schemes on rd. 29, the compensation on rd. 27 and 31; D394's LS and AS operations and the margins' information fields; the farmer's acquisitions as N.",
    rules: ['ro.deadline.D300', 'ro.deadline.D394'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
];

/** The fields a booking template sets: none. A margin sale names its items and a flat-rate
 * purchase its farmer's answer, which a template cannot fix; a travel cost's template is
 * `invoices.recognize`'s (`account`, `deduction: none`). */
export const templates: readonly string[] = [];
