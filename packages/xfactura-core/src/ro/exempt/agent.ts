import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive exempt supplies, the pro-rata and the capital goods' adjustments
 * (docs/ROADMAP.md, "agent-ready by construction"): the documents it may bring in, the questions
 * people answer and the evidence they cite, the worklist items its detectors raise with the rules
 * they enforce, and the fields a booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'exempt.invoice',
    title:
      'Facturi fără TVA pentru operațiuni scutite (asigurări, servicii medicale, financiare, chirii)',
    summary:
      "A purchase whose supply is exempt (category E, or G for goods exported): booked by `invoices.recognize` without VAT, on D300 rd. 29, with the supplier's exemption reason (BT-120/BT-121) carried into the tax entry.",
    evidenceFor: ['invoices.recognize'],
  },
  {
    id: 'option.notification',
    title:
      'Notificarea privind opțiunea de taxare a închirierii sau livrării de bunuri imobile (anexele 1 și 3 la norme)',
    summary:
      'The option to tax a rent or a supply of immovable property (art. 292 alin. (3); norme pct. 57–58): the property or part opted for and the date from which it is taxed. With it a rent is invoiced with VAT (S); without it the rent is exempt (E, art. 292 alin. (2) lit. e)).',
    evidenceFor: ['invoices.recognize', 'capitalGood.use'],
  },
  {
    id: 'prorata.notification',
    title: 'Comunicarea pro ratei provizorii către organul fiscal (până la 25 ianuarie)',
    summary:
      "The provisional pro-rata the company applies in a year and how it was determined (art. 300 alin. (9)–(10)): the previous year's definitive, or an estimate for a new or changed activity. It is the evidence of the `vat.prorata` fact.",
    evidenceFor: ['vat.prorata'],
  },
  {
    id: 'prorata.computation',
    title: 'Documentul cu metoda de calcul a pro ratei definitive',
    summary:
      'The computation of the definitive pro-rata attached to the return of the year-end adjustment (art. 300 alin. (8)): `vat.proRata.compute` gives it; it is the evidence of `vat.proRata`.',
    evidenceFor: ['vat.proRata'],
  },
  {
    id: 'capital.use',
    title:
      'Documentul care arată folosirea unui bun de capital (contract de închiriere, decizie de alocare)',
    summary:
      'From when, and in what share, a capital good is used for operations with the right of deduction (art. 305 alin. (4) lit. a), c)): a lease of part of a building, exempt or with the option to tax, a good moved to an exempt activity.',
    evidenceFor: ['capitalGood.use'],
  },
  {
    id: 'inventory.list',
    title: 'Listele de inventariere la data schimbării regimului de TVA',
    summary:
      'The stock, assets in progress and services not used at a registration or a cancellation, at their value and the VAT rate of their acquisition (norme pct. 78 alin. (13), pct. 83 alin. (7), (11)).',
    evidenceFor: ['vat.capitalGoods'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['prorata.notification'],
    summary:
      'The provisional pro-rata of a year (`vat.prorata`, a whole percent, from 1 January or from the day the first exempt supply made the company mixed): asked when the books show supplies exempt without the right of deduction and none is recorded; `special` for a pro-rata the Ministry approved or imposed, `opted_out` for the option of art. 300 alin. (20).',
  },
  {
    kind: 'capitalGood.use',
    answeredBy: 'owner',
    evidence: ['capital.use', 'option.notification'],
    summary:
      "From when, and in what share, a capital good is used for operations with the right of deduction: the basis of the change-of-use adjustment and of each year's adjustment while the use holds (art. 305 alin. (4) lit. a), c); norme pct. 79 alin. (1)).",
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind: 'vat.prorata' | 'vat.capitalGoods';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'vat.prorata',
    summary:
      'A year with supplies exempt without the right of deduction and no provisional pro-rata recorded (blocking: its purchases for both kinds of operations cannot deduct), or a mixed year whose last VAT period has come without the year-end adjustment to the definitive pro-rata (art. 300 alin. (14)).',
    rules: ['ro.vat.prorata'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'vat.proRata.compute', by: 'agent' },
      { operation: 'vat.proRata.propose', by: 'agent' },
    ],
  },
  {
    kind: 'vat.capitalGoods',
    summary:
      "A capital good whose use (`capitalGood.use`) differs from its initial deduction, in a year of its adjustment period without the year's adjustment, due in the year's last return (norme pct. 79 alin. (1)).",
    rules: ['ro.vat.capital_goods', 'ro.vat.capital_goods.minimum'],
    next: [
      { operation: 'vat.capitalGoods.register', by: 'agent' },
      { operation: 'vat.capitalGoods.propose', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: a purchase part's `deduction` may be `prorata` (both kinds
 * of operations, art. 300 alin. (5)), beside `full` (exclusively with the right of deduction,
 * alin. (3)) and `none` (exclusively without it, alin. (4)). A sale's exemption basis is not a
 * template field: it is stated with the issue (`sales.issue` `exemption`) or the recognition. */
export const templates: readonly string[] = ['invoices.recognize.deduction'];
