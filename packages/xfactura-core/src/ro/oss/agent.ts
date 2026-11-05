import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive sales to consumers in other Member States and the One Stop Shop
 * (docs/ROADMAP.md, "agent-ready by construction"): the documents it may bring in, the questions
 * people answer and the evidence they cite, the worklist items its detectors raise with the
 * rules they enforce, and the fields a booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'eu.consumer.invoice',
    title:
      'Factura emisă unui consumator din alt stat membru (vânzare la distanță, serviciu electronic, telecomunicații, radiodifuziune)',
    summary:
      'A sale to a person without a VAT code in another EU state: Romanian VAT below the art. 278^1 threshold, the consumer state’s VAT in the Union scheme above it; recognized with `invoices.euConsumer`.',
    evidenceFor: ['invoices.euConsumer'],
  },
  {
    id: 'customer.location',
    title:
      'Dovezile locului clientului (adresa de facturare, adresa IP, banca, cartela SIM, linia fixă)',
    summary:
      'Two items that agree on the customer’s state, for a telecom, broadcasting or electronic service (norme pct. 21 alin. (4) lit. d), (6); Regulation (EU) No 282/2011 art. 24b, 24f): the order’s geolocation, the payment processor’s card country. One suffices for the customer’s fixed line or SIM the service is supplied through (art. 24b lit. (a)–(b)), or one a third party involved in the supply gave, below €100,000 a year (`thirdParty`, second paragraph; both acknowledged).',
    evidenceFor: ['invoices.euConsumer'],
  },
  {
    id: 'transport.document',
    title: 'Documentul de transport (curier, poștă) al bunurilor expediate clientului',
    summary:
      'Goods dispatched from Romania to a consumer in another state: the distance sale’s proof (art. 266 alin. (1) pct. 35).',
    evidenceFor: ['invoices.euConsumer'],
  },
  {
    id: 'oss.registration',
    title: 'Decizia sau confirmarea ANAF de înregistrare în regimul special Uniune (OSS)',
    summary:
      'The registration in the Union scheme (art. 315 alin. (3)) and the date it applies from: the `vat.oss` fact (`union`), from the first day of the quarter after ANAF was informed, or from the first sale under the scheme when ANAF was informed by the 10th of the next month (Regulation (EU) No 282/2011 art. 57d); also its end or exclusion (alin. (5)).',
    evidenceFor: ['vat.oss', 'determination.confirm'],
  },
  {
    id: 'distance.option',
    title:
      'Declarația de mențiuni (010/700) cu opțiunea pentru locul la destinație (art. 278^1 alin. (3))',
    summary:
      'The option of a supplier below the threshold to tax at the destination, for at least two calendar years: the `vat.distance` fact (`option`).',
    evidenceFor: ['vat.distance', 'determination.confirm'],
  },
  {
    id: 'ecb.rates',
    title: 'Cursurile de referință ale BCE (fișierul XML eurofxref)',
    summary:
      'The ECB’s euro rate for the quarter’s last day, which converts a sale not invoiced in euro in the D398 (art. 315 alin. (12)): recorded with `evidence.record`, named in the return’s options.',
    evidenceFor: ['declarations.prepare'],
  },
  {
    id: 'd398.receipt',
    title: 'Recipisa declarației speciale de TVA (398) depuse',
    summary:
      'ANAF’s receipt of the filed D398, for `declarations.recordSubmission`; a later change is a correction in a later return (alin. (11)), never a rectifying return.',
    evidenceFor: ['declarations.recordSubmission'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'profile.fact',
    answeredBy: 'owner',
    evidence: ['distance.option', 'oss.registration'],
    summary:
      'Where the sales take place (`vat.distance`: origin, destination, option), whether the company applies the Union scheme (`vat.oss`: union, none) and the import scheme (`vat.ioss`), from a date; the crossing of the threshold is asked by the sale that exceeds it.',
  },
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: [
      'the computation itself (kept with the answer)',
      'distance.option',
      'oss.registration',
    ],
    summary:
      'Confirm or correct the year’s place of supply (`vat.distance`: the threshold cumulated over the year’s sales and the previous year’s) and the Union scheme (`vat.oss`).',
  },
  {
    kind: 'year.figures',
    answeredBy: 'owner',
    evidence: ['the previous year’s last D300 (its „Total an curent”)'],
    summary:
      'For a previous year the books do not keep: its distance sales and TBE services to EU consumers (`distanceTurnover`).',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind:
    'threshold.approaching' | 'determination.missing' | 'obligation.due' | 'document.unproposed';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'threshold.approaching',
    summary:
      'The year’s distance sales and TBE services to EU consumers at 80% of the 46.337 lei threshold (warning) or over it (blocking): from the sale that exceeds it the place is the destination.',
    rules: ['ro.vat.distance.threshold'],
    next: [{ operation: 'determinations.propose', by: 'agent' }],
  },
  {
    kind: 'determination.missing',
    summary:
      'A `vat.distance` the books contradict (the threshold crossed while the fact says origin, an option within its two years), or a `vat.oss` the destination needs and nobody recorded.',
    rules: ['ro.vat.distance.threshold', 'ro.vat.distance.option_years'],
    next: [
      { operation: 'determinations.propose', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
  {
    kind: 'obligation.due',
    summary:
      'The D398 of each quarter while registered in the Union scheme, with or without sales, due on the last calendar day of the next month.',
    rules: ['ro.deadline.D398', 'ro.vat.oss.return'],
    next: [{ operation: 'declarations.prepare', by: 'agent' }],
  },
  {
    kind: 'document.unproposed',
    summary:
      'An issued invoice to a customer in another EU state without a VAT code: proposed as `invoices.euConsumer`.',
    rules: ['ro.vat.oss.rates', 'ro.vat.oss.payable_account'],
    next: [{ operation: 'proposals.propose', by: 'agent' }],
  },
];

/** The fields a booking template sets: none. Each sale needs its customer's location or its
 * dispatch, which a template cannot state. */
export const templates: readonly string[] = [];
