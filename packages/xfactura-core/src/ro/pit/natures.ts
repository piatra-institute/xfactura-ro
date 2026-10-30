import { z } from 'zod';

/**
 * What a receipt or payment is for the income tax of an individual in the real system (Codul
 * fiscal art. 68): its nature in the Registrul-jurnal de încasări și plăți and its row in the
 * Registrul de evidență fiscală.
 *
 * - `income`: gross income (art. 68 alin. (2)).
 * - `expense`: deductible in full, when paid (art. 68 alin. (4)).
 * - `limited`: deductible within a limit (art. 68 alin. (5), alin. (7) lit. k)).
 * - `excluded`: neither income nor a deductible expense (art. 68 alin. (3) and (7)): contributions
 *   and withdrawals of the owner, loans, compensation, donations, fines, personal use.
 * - `asset`: the purchase of a depreciable asset (alin. (7) lit. h)), recovered by depreciation.
 * - `vat`: collected or deducted VAT and VAT settled with the state (OMFP nr. 3.254/2017 art. 4
 *   alin. (3), art. 5 alin. (6)).
 * - `transfer`: money moved between the business's own cash and bank accounts.
 * - `advance`: an advance for expenses paid to a person (542); its expense report is the expense.
 */
export const natureKinds = [
  'income',
  'expense',
  'limited',
  'excluded',
  'asset',
  'vat',
  'transfer',
  'advance',
] as const;
export type NatureKind = (typeof natureKinds)[number];

/** The limits of art. 68 alin. (5) and alin. (7) lit. k), by the parameter field that sets each. */
export const limitKeys = [
  'protocol',
  'scholarship',
  'social',
  'vehicle',
  'professional',
  'employer',
  'association',
  'pension',
  'occupationalPension',
  'pepp',
  'health',
  'sport',
  'etf',
] as const;
export type LimitKey = (typeof limitKeys)[number];

export interface Nature {
  kind: NatureKind;
  /** The explanation the registers show, in Romanian. */
  label: string;
  limit?: LimitKey;
  clauses: readonly string[];
}

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const gross = [code('art.68(2)-(3)'), code('norme.art.68.pct.7(1)-(2)')];
const deductible = [code('art.68(4)'), code('norme.art.68.pct.7(4)-(5)')];
const limited = [code('art.68(5)-(6)')];
const excluded = [code('art.68(7)')];
const registers = ['OMFP3254/2017:art.4-5'];

/** Every nature a catalogue may name. A treasury amount the catalogue does not classify is
 * `unclassified`; a settled invoice whose composition cannot be read is `unattributed`. */
export const natures = {
  'income.activity': { kind: 'income', label: 'Venituri din activitate', clauses: gross },
  'income.interest': { kind: 'income', label: 'Dobânzi', clauses: gross },
  'income.asset_sale': {
    kind: 'income',
    label: 'Venituri din înstrăinarea bunurilor afacerii',
    clauses: gross,
  },
  'income.fx': { kind: 'income', label: 'Diferențe de curs valutar favorabile', clauses: gross },
  'excluded.contribution': {
    kind: 'excluded',
    label: 'Aporturi ale titularului',
    clauses: gross,
  },
  'excluded.withdrawal': {
    kind: 'excluded',
    label: 'Retrageri ale titularului',
    clauses: excluded,
  },
  'excluded.loan': { kind: 'excluded', label: 'Credite și împrumuturi primite', clauses: gross },
  'excluded.repayment': {
    kind: 'excluded',
    label: 'Rambursări de credite și împrumuturi',
    clauses: excluded,
  },
  'excluded.compensation': { kind: 'excluded', label: 'Despăgubiri primite', clauses: gross },
  'excluded.donation_received': {
    kind: 'excluded',
    label: 'Sponsorizări, mecenat și donații primite',
    clauses: gross,
  },
  'excluded.other': {
    kind: 'excluded',
    label: 'Alte sume încasate sau plătite (debitori, creditori diverși)',
    clauses: ['OMFP170/2015:cap.V.14-1-1'],
  },
  'excluded.personal': {
    kind: 'excluded',
    label: 'Cheltuieli în scop personal sau al familiei',
    clauses: excluded,
  },
  'excluded.fines': {
    kind: 'excluded',
    label: 'Amenzi, penalități și majorări de întârziere',
    clauses: excluded,
  },
  'excluded.donation': {
    kind: 'excluded',
    label: 'Donații, sponsorizări și mecenat acordate',
    clauses: excluded,
  },
  'expense.full': { kind: 'expense', label: 'Cheltuieli deductibile', clauses: deductible },
  'expense.salary': { kind: 'expense', label: 'Cheltuieli cu salariile', clauses: deductible },
  'expense.fx': {
    kind: 'expense',
    label: 'Diferențe de curs valutar nefavorabile',
    clauses: deductible,
  },
  'expense.depreciation': {
    kind: 'expense',
    label: 'Amortizare fiscală',
    clauses: [code('art.68(4)'), code('art.28')],
  },
  'expense.employer': {
    kind: 'limited',
    limit: 'employer',
    label: 'Contribuții sociale datorate ca angajator',
    clauses: limited,
  },
  'expense.protocol': {
    kind: 'limited',
    limit: 'protocol',
    label: 'Cheltuieli de protocol',
    clauses: limited,
  },
  'expense.scholarship': {
    kind: 'limited',
    limit: 'scholarship',
    label: 'Burse private',
    clauses: limited,
  },
  'expense.social': {
    kind: 'limited',
    limit: 'social',
    label: 'Cheltuieli sociale',
    clauses: limited,
  },
  'expense.vehicle': {
    kind: 'limited',
    limit: 'vehicle',
    label: 'Cheltuieli cu vehicule neutilizate exclusiv în activitate',
    clauses: [code('art.68(7)'), code('norme.art.68.pct.7(6)-(7)')],
  },
  'expense.professional': {
    kind: 'limited',
    limit: 'professional',
    label: 'Contribuții profesionale obligatorii',
    clauses: limited,
  },
  'expense.association': {
    kind: 'limited',
    limit: 'association',
    label: 'Cotizații la asociații profesionale',
    clauses: limited,
  },
  'expense.pension': {
    kind: 'limited',
    limit: 'pension',
    label: 'Contribuții la fonduri de pensii facultative',
    clauses: limited,
  },
  'expense.occupational_pension': {
    kind: 'limited',
    limit: 'occupationalPension',
    label: 'Contribuții la fonduri de pensii ocupaționale',
    clauses: limited,
  },
  'expense.pepp': {
    kind: 'limited',
    limit: 'pepp',
    label: 'Contribuții la produse paneuropene de pensii personale',
    clauses: limited,
  },
  'expense.health': {
    kind: 'limited',
    limit: 'health',
    label: 'Asigurări voluntare de sănătate și abonamente medicale',
    clauses: limited,
  },
  'expense.sport': {
    kind: 'limited',
    limit: 'sport',
    label: 'Abonamente sportive',
    clauses: limited,
  },
  'expense.etf': {
    kind: 'limited',
    limit: 'etf',
    label: 'Titluri de participare ETF',
    clauses: limited,
  },
  'asset.acquisition': {
    kind: 'asset',
    label: 'Achiziții de bunuri amortizabile din Registrul-inventar',
    clauses: excluded,
  },
  vat: { kind: 'vat', label: 'TVA', clauses: registers },
  transfer: {
    kind: 'transfer',
    label: 'Transfer între conturile proprii',
    clauses: ['OMFP170/2015:cap.V.14-1-1'],
  },
  'advance.expenses': {
    kind: 'advance',
    label: 'Avansuri de trezorerie',
    clauses: ['OMFP170/2015:cap.V.14-1-1'],
  },
} as const satisfies Record<string, Nature>;
export type NatureCode = keyof typeof natures | 'unclassified' | 'unattributed';

export function natureOf(code: NatureCode): Nature | undefined {
  return (natures as Record<string, Nature>)[code];
}

const natureCode = z.string().refine((value) => value in natures, 'Natură necunoscută.');

/**
 * The catalogue: which nature an account's amounts have. `match` is an account prefix (`704`
 * matches 704 and its analytics) or an analytic tag (`*.PROTOCOL` matches 623.PROTOCOL and any
 * account with that segment). Tags win over prefixes, the longest prefix over shorter ones.
 * `outflow` is the nature of money paid out, when it differs from money received (an owner's
 * contribution and withdrawal, a loan received and repaid).
 */
export const natureCatalogue = z
  .array(
    z
      .object({
        match: z.string().regex(/^(\*\.[A-Z0-9_]{2,24}|[1-9]\d{0,3}(\.[A-Z0-9_-]{1,24})*)$/),
        nature: natureCode,
        outflow: natureCode.optional(),
      })
      .strict(),
  )
  .min(1);
export type NatureCatalogue = z.infer<typeof natureCatalogue>;

/** The nature of an amount on an account, money in when `flow` is positive. */
export function classify(catalogue: NatureCatalogue, account: string, flow: bigint): NatureCode {
  const segments = account.split('.').slice(1);
  const tagged = catalogue.find(
    (rule) => rule.match.startsWith('*.') && segments.includes(rule.match.slice(2)),
  );
  const rule =
    tagged ??
    catalogue
      .filter((item) => !item.match.startsWith('*.') && account.startsWith(item.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
  if (!rule) return 'unclassified';
  return ((flow < 0n && rule.outflow) || rule.nature) as NatureCode;
}

/** The catalogue read in the Codul fiscal and OMFP nr. 170/2015, by Romanian chart account. */
export const defaultCatalogue: NatureCatalogue = [
  // Analytic tags the company puts on its expense accounts (6022.VEH50, 623.PROTOCOL, …).
  { match: '*.PROTOCOL', nature: 'expense.protocol' },
  { match: '*.BURSE', nature: 'expense.scholarship' },
  { match: '*.SOCIAL', nature: 'expense.social' },
  { match: '*.VEH50', nature: 'expense.vehicle' },
  { match: '*.CONTRIBPROF', nature: 'expense.professional' },
  { match: '*.ASOCPROF', nature: 'expense.association' },
  { match: '*.PENSIE', nature: 'expense.pension' },
  { match: '*.PENSIEOCUP', nature: 'expense.occupational_pension' },
  { match: '*.PEPP', nature: 'expense.pepp' },
  { match: '*.SANATATE', nature: 'expense.health' },
  { match: '*.SPORT', nature: 'expense.sport' },
  { match: '*.ETF', nature: 'expense.etf' },
  { match: '*.PERSONAL', nature: 'excluded.personal' },
  { match: '*.SPONSOR', nature: 'excluded.donation' },
  { match: '*.TITULAR', nature: 'excluded.contribution', outflow: 'excluded.withdrawal' },
  // Gross income and what is not.
  { match: '70', nature: 'income.activity' },
  { match: '74', nature: 'income.activity' },
  { match: '75', nature: 'income.activity' },
  { match: '7581', nature: 'excluded.compensation' },
  { match: '7582', nature: 'excluded.donation_received' },
  { match: '7583', nature: 'income.asset_sale' },
  { match: '765', nature: 'income.fx' },
  { match: '766', nature: 'income.interest' },
  { match: '76', nature: 'income.activity' },
  { match: '419', nature: 'income.activity' },
  { match: '10', nature: 'excluded.contribution', outflow: 'excluded.withdrawal' },
  { match: '4551', nature: 'excluded.contribution', outflow: 'excluded.withdrawal' },
  { match: '16', nature: 'excluded.loan', outflow: 'excluded.repayment' },
  { match: '519', nature: 'excluded.loan', outflow: 'excluded.repayment' },
  { match: '461', nature: 'excluded.other' },
  { match: '462', nature: 'excluded.other' },
  // Expenses, when paid.
  { match: '30', nature: 'expense.full' },
  { match: '32', nature: 'expense.full' },
  { match: '33', nature: 'expense.full' },
  { match: '34', nature: 'expense.full' },
  { match: '35', nature: 'expense.full' },
  { match: '36', nature: 'expense.full' },
  { match: '37', nature: 'expense.full' },
  { match: '38', nature: 'expense.full' },
  { match: '409', nature: 'expense.full' },
  { match: '60', nature: 'expense.full' },
  { match: '61', nature: 'expense.full' },
  { match: '62', nature: 'expense.full' },
  { match: '63', nature: 'expense.full' },
  { match: '64', nature: 'expense.salary' },
  { match: '645', nature: 'expense.employer' },
  { match: '646', nature: 'expense.employer' },
  { match: '65', nature: 'expense.full' },
  { match: '6581', nature: 'excluded.fines' },
  { match: '6582', nature: 'excluded.donation' },
  { match: '665', nature: 'expense.fx' },
  { match: '66', nature: 'expense.full' },
  { match: '421', nature: 'expense.salary' },
  { match: '423', nature: 'expense.salary' },
  { match: '425', nature: 'expense.salary' },
  { match: '426', nature: 'expense.salary' },
  { match: '427', nature: 'expense.salary' },
  { match: '431', nature: 'expense.salary' },
  { match: '444', nature: 'expense.salary' },
  { match: '436', nature: 'expense.employer' },
  { match: '437', nature: 'expense.employer' },
  { match: '446', nature: 'expense.full' },
  { match: '447', nature: 'expense.full' },
  { match: '20', nature: 'asset.acquisition' },
  { match: '21', nature: 'asset.acquisition' },
  { match: '23', nature: 'asset.acquisition' },
  // Neither: VAT, own transfers, advances for expenses.
  { match: '4423', nature: 'vat' },
  { match: '4424', nature: 'vat' },
  { match: '4426', nature: 'vat' },
  { match: '4427', nature: 'vat' },
  { match: '4428', nature: 'vat' },
  { match: '581', nature: 'transfer' },
  { match: '5121', nature: 'transfer' },
  { match: '5124', nature: 'transfer' },
  { match: '5311', nature: 'transfer' },
  { match: '5314', nature: 'transfer' },
  { match: '542', nature: 'advance.expenses' },
];
