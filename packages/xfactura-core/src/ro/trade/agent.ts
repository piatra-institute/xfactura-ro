import type { AgentDocumentType, AgentQuestion } from '../determinations/agent';

/*
 * What an agent needs to drive EU goods, imports and exports (G3; docs/ROADMAP.md, "agent-ready
 * by construction"): the documents it brings in, the questions people answer with their
 * evidence, the worklist items its detectors raise and the rules they enforce, and the fields a
 * booking template sets.
 */

export const documentTypes: readonly AgentDocumentType[] = [
  {
    id: 'intra_eu.supply.invoice',
    title: 'Factura emisă pentru o livrare intracomunitară de bunuri (categoria K, VATEX-EU-IC)',
    summary:
      'An exempt supply of goods to a business with a VAT code of another Member State (art. 294 alin. (2) lit. a)): recognized with `goods.euSupply`, its goods out of stock, D300 rd. 1 and D390 L at the art. 283 tax point.',
    evidenceFor: ['goods.euSupply'],
  },
  {
    id: 'vies.check',
    title:
      'Verificarea VIES a codului de TVA al cumpărătorului (răspunsul serviciului sau pagina VIES)',
    summary:
      "The buyer's code valid on the supply's date: `parties.checkVies` asks VIES and records it (a `vies.check` document); a VIES page saved by a person is recorded with `documents.record` (kind `vies.check`).",
    evidenceFor: ['goods.euSupply', 'documents.record'],
  },
  {
    id: 'transport.document',
    title:
      'Documentele transportului în alt stat membru: CMR semnat, conosament, factura transportatorului, asigurarea, plata transportului, chitanța antrepozitarului, declarația cumpărătorului',
    summary:
      'Two non-contradictory items from independent issuers, one of them the transport’s own, presume the dispatch (Regulation (EU) No 282/2011 art. 45a); the buyer’s statement too when it transported. Given in `goods.euSupply.transport` or later in the answer to `goods.proof`, within 90 days (OMFP 103/2016 art. 1 alin. (4)).',
    evidenceFor: ['goods.euSupply', 'goods.proof'],
  },
  {
    id: 'intra_eu.acquisition.invoice',
    title:
      'Factura furnizorului din alt stat membru pentru bunuri (fără TVA, cu codul RO al firmei)',
    summary:
      'An intra-community acquisition of goods: recognized with `goods.euAcquisition`, the goods into stock (the NIR), the VAT self-assessed 4426 = 4427 at the invoice or the 15th of the next month (art. 284), D300 rd. 5 and 20, D390 A.',
    evidenceFor: ['goods.euAcquisition'],
  },
  {
    id: 'customs.import',
    title: 'Declarația vamală de import (DVI) cu MRN, valoarea în vamă, taxele vamale și TVA',
    summary:
      'Recorded with `documents.record` (kind `customs.declaration`, procedure import, each field cited); read by `goods.import` with the supplier’s invoice: duties into the goods’ cost, import VAT paid at customs or deferred.',
    evidenceFor: ['documents.record', 'goods.import'],
  },
  {
    id: 'vat.deferral.certificate',
    title: 'Certificatul de amânare de la plata în vamă a TVA (art. 326 alin. (4) lit. a))',
    summary:
      'The certificate of OMFP nr. 4.121/2015 behind a DVI whose VAT was not paid at customs: `goods.import.certificateEvidenceId`; the VAT is then collected and deducted in the D300 (rd. 7 and 22).',
    evidenceFor: ['goods.import'],
  },
  {
    id: 'import.invoice',
    title: 'Factura furnizorului din afara Uniunii (de regulă în valută)',
    summary:
      'The goods’ price, at the BNR rate of its date: booked with its DVI by `goods.import`.',
    evidenceFor: ['goods.import'],
  },
  {
    id: 'export.invoice',
    title: 'Factura emisă pentru un export de bunuri (categoria G, VATEX-EU-G)',
    summary:
      'An exempt export (art. 294 alin. (1) lit. a)–b)): recognized with `goods.export`, its goods out of stock, D300 rd. 14.',
    evidenceFor: ['goods.export'],
  },
  {
    id: 'customs.export',
    title: 'Declarația vamală de export cu certificarea ieșirii (MRN, notificarea de ieșire)',
    summary:
      'Recorded with `documents.record` (kind `customs.declaration`, procedure export, with `exit`); justifies the export’s exemption (OMFP 103/2016 art. 2 alin. (2)) in `goods.export.declarationId` or the answer to `goods.proof`.',
    evidenceFor: ['documents.record', 'goods.export', 'goods.proof'],
  },
  {
    id: 'intrastat.notice',
    title:
      'Notificarea INS privind obligația de raportare Intrastat; recipisa declarației Intrastat',
    summary:
      'INS’s notice that the company provides Intrastat data (the `intrastat.arrivals` or `intrastat.dispatches` fact, confirmed with `determination.confirm`), and the receipt of a filed declaration for `obligation.filed`.',
    evidenceFor: ['determination.confirm', 'obligation.filed'],
  },
  {
    id: 'etransport.confirmation',
    title: 'Confirmarea RO e-Transport cu codul UIT, sau documentul de transport care îl poartă',
    summary:
      'The UIT code of a transport of goods of high fiscal risk (OUG 41/2022 art. 8, 11), for the answer to `etransport.uit`.',
    evidenceFor: ['etransport.uit'],
  },
];

export const questions: readonly AgentQuestion[] = [
  {
    kind: 'goods.proof',
    answeredBy: 'owner',
    evidence: ['transport.document', 'customs.export'],
    summary:
      'The proof an exempt supply booked without it gets within 90 days: the transport’s documents (art. 45a) or the customs export declaration with its exit certified.',
  },
  {
    kind: 'etransport.uit',
    answeredBy: 'owner',
    evidence: ['etransport.confirmation'],
    summary:
      'The UIT code RO e-Transport gave a transport of the books, with the date declared and the start; or why none was needed (goods not of high fiscal risk).',
  },
  {
    kind: 'determination.confirm',
    answeredBy: 'owner',
    evidence: ['the computation itself (kept with the answer)', 'intrastat.notice'],
    summary:
      'Confirm or correct the year’s Intrastat status per flow (`intrastat.arrivals`, `intrastat.dispatches`: provider from a month, or none).',
  },
  {
    kind: 'year.figures',
    answeredBy: 'owner',
    evidence: ['the previous year’s D390s or Intrastat declarations'],
    summary:
      'For a previous year the books do not keep: its intra-Union acquisitions and supplies of goods (`intrastatArrivals`, `intrastatDispatches`).',
  },
  {
    kind: 'obligation.filed',
    answeredBy: 'owner',
    evidence: ['intrastat.notice'],
    summary: 'The Intrastat declaration of a month filed with INS: its receipt.',
  },
];

/** A worklist item kind the module raises, and the rule or check it stands for. */
export interface AgentDetector {
  kind:
    | 'document.unproposed'
    | 'goods.proof'
    | 'etransport.uit'
    | 'threshold.approaching'
    | 'obligation.due';
  summary: string;
  rules: readonly string[];
  next: readonly { operation: string; by: 'agent' | 'human' }[];
}

export const detectors: readonly AgentDetector[] = [
  {
    kind: 'document.unproposed',
    summary:
      'An issued invoice in category K proposed as `goods.euSupply`, one in G as `goods.export`; a received invoice in K from another Member State as `goods.euAcquisition`, one from outside the Union as `goods.import` (or services, `invoices.crossBorder`).',
    rules: ['ro.vat.intra_eu.supply', 'ro.vat.intra_eu.acquisition', 'ro.vat.import'],
    next: [{ operation: 'proposals.propose', by: 'agent' }],
  },
  {
    kind: 'goods.proof',
    summary:
      'A posted intra-community supply or export whose proof is pending: warning while its 90 days run, blocking once they passed (the VAT is collected from the chargeable event, OMFP 103/2016 art. 1 alin. (7)).',
    rules: ['ro.vat.intra_eu.supply', 'ro.vat.export.proof', 'ro.vat.intra_eu.transport'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
  {
    kind: 'etransport.uit',
    summary:
      'A transport of goods across the border in the books (acquisition, supply, import, export) without its UIT code or a stated reason for none, with its declaration window.',
    rules: ['ro.etransport'],
    next: [
      { operation: 'questions.ask', by: 'agent' },
      { operation: 'questions.answer', by: 'human' },
    ],
  },
  {
    kind: 'threshold.approaching',
    summary:
      'The year’s intra-Union arrivals or dispatches at 80% of INS’s Intrastat threshold (warning) or over it (blocking) while the company is not recorded as a provider.',
    rules: ['ro.intrastat.thresholds'],
    next: [{ operation: 'determinations.propose', by: 'agent' }],
  },
  {
    kind: 'obligation.due',
    summary:
      'D390 for each month with intra-community supplies or acquisitions of goods; the Intrastat declaration of each month the company provides data, filed with INS by the 15th.',
    rules: ['ro.deadline.D390', 'ro.deadline.Intrastat'],
    next: [
      { operation: 'declarations.prepare', by: 'agent' },
      { operation: 'questions.ask', by: 'agent' },
    ],
  },
];

/** The fields a booking template sets: none. Each supply needs its VIES check and transport, each
 * import its declaration. */
export const templates: readonly string[] = [];
