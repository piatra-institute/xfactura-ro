import type { ObligationKind } from '../obligations';

/**
 * The review queue's annotations: which profiles a parameter reaches, what a wrong value risks
 * and which returns use it. A key without an annotation is listed as missing, never guessed.
 */

/** The draft profiles of docs/CONFORMANCE.md (and the PFA, II and IF books of PFA_II_IF.md). */
export interface ReviewProfile {
  id: string;
  title: string;
  defined: string;
}

export const reviewProfiles: readonly ReviewProfile[] = [
  {
    id: 'RO-SRV-01',
    title: 'SRL de servicii, în lei, neplătitor de TVA, impozit pe profit',
    defined: 'docs/CONFORMANCE.md',
  },
  {
    id: 'RO-SRV-02',
    title: 'SRL de servicii, în lei, plătitor de TVA (regim normal)',
    defined: 'docs/CONFORMANCE.md',
  },
  { id: 'RO-SRV-03', title: 'Operațiuni și conturi în euro', defined: 'docs/CONFORMANCE.md' },
  { id: 'RO-SRV-04', title: 'Servicii B2B în Uniunea Europeană', defined: 'docs/CONFORMANCE.md' },
  {
    id: 'RO-SRV-05',
    title: 'Imobilizări și amortizare contabilă și fiscală',
    defined: 'docs/CONFORMANCE.md',
  },
  {
    id: 'RO-SRV-06',
    title: 'Impozit pe profit anual, D101 și situații financiare',
    defined: 'docs/CONFORMANCE.md',
  },
  {
    id: 'RO-OWN-01',
    title: 'Împrumuturi de la asociați și dividende',
    defined: 'docs/CONFORMANCE.md',
  },
  {
    id: 'RO-TAX-MICRO',
    title: 'Impozit pe veniturile microîntreprinderilor',
    defined: 'docs/CONFORMANCE.md (fațetă)',
  },
  { id: 'RO-PAY', title: 'Salarii', defined: 'docs/CONFORMANCE.md (fațetă)' },
  {
    id: 'RO-PFA',
    title: 'PFA, II și IF în partidă simplă',
    defined: 'docs/PFA_II_IF.md (identificator introdus de catalogul revizuirilor)',
  },
];

/** What a wrong value costs: a wrong tax amount (3), a rejected filing (2), a presentation (1). */
export type RiskKind = 'tax_amount' | 'filing_rejection' | 'presentation';
export const riskWeight: Record<RiskKind, number> = {
  tax_amount: 3,
  filing_rejection: 2,
  presentation: 1,
};

export interface KeyAnnotation {
  /** An estimate, 1 to 3: 3 reaches nearly every company in scope, 2 a common regime, 1 a
   * specific case; with the profiles it reaches and why. */
  reach?: { estimate: 1 | 2 | 3; profiles: readonly string[]; basis: string };
  risk?: { kind: RiskKind; basis: string };
  /** The returns whose amounts use the key: the next of their deadlines sets the urgency. */
  obligations?: readonly ObligationKind[];
}

export const keyAnnotations: Readonly<Record<string, KeyAnnotation>> = {
  'ro.vat.rate': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-03', 'RO-SRV-04', 'RO-TAX-MICRO', 'RO-PFA'],
      basis:
        'Every recognized invoice, sale or purchase, is checked against the standard rate, payer or not (invoices.recognize, invoices.crossBorder).',
    },
    risk: { kind: 'tax_amount', basis: 'The rate sets the VAT collected and deducted.' },
    obligations: ['D300', 'D394', 'D406'],
  },
  'ro.vat.rate.reduced': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-03', 'RO-TAX-MICRO', 'RO-PFA'],
      basis:
        'Purchases at the reduced rate (water, food, accommodation, restaurants) reach companies that sell none; every invoice not at the standard rate is checked against it.',
    },
    risk: { kind: 'tax_amount', basis: 'The rate sets the VAT collected and deducted.' },
    obligations: ['D300', 'D394', 'D406'],
  },
  'ro.vat.deduction.limited': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-02', 'RO-SRV-03', 'RO-SRV-05'],
      basis:
        'VAT payers with a car: its lease or purchase, fuel and repairs deduct by its use; non-payers deduct nothing.',
    },
    risk: { kind: 'tax_amount', basis: 'The share sets the VAT deducted on every vehicle cost.' },
    obligations: ['D300', 'D406'],
  },
  'ro.micro.rate': {
    reach: {
      estimate: 2,
      profiles: ['RO-TAX-MICRO'],
      basis: 'Every SRL on the micro-enterprise regime, each quarter.',
    },
    risk: { kind: 'tax_amount', basis: 'The rate sets the quarterly tax.' },
    obligations: ['D100.micro'],
  },
  'ro.micro.revenue_limit_eur': {
    reach: {
      estimate: 2,
      profiles: ['RO-TAX-MICRO', 'RO-SRV-06'],
      basis:
        'Every micro-enterprise each quarter; crossing it moves the company to profit tax (RO-SRV-06).',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'Crossing it changes the tax owed from the quarter of crossing.',
    },
    obligations: ['D100.micro'],
  },
  'ro.micro.linked': {
    reach: {
      estimate: 1,
      profiles: ['RO-TAX-MICRO'],
      basis:
        'Micro-enterprises whose shareholders hold more than 25% elsewhere or run an individual enterprise on a norm.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'It decides the quarter from which profit tax is owed instead of micro tax.',
    },
    obligations: ['D100.micro'],
  },
  'ro.payroll.quarterly': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY', 'RO-TAX-MICRO', 'RO-PFA'],
      basis: 'Every small employer: it decides whether D112 is filed monthly or after the quarter.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A D112 filed in the wrong cadence is late or rejected; the tax is paid late.',
    },
    obligations: ['D112', 'D112.quarterly'],
  },
  'ro.deadline.D112.quarterly': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY', 'RO-TAX-MICRO', 'RO-PFA'],
      basis: 'Every quarterly employer with a month of sick leave or a contract ended.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A month filed after its deadline is a late return, with its penalties.',
    },
    obligations: ['D112', 'D112.quarterly'],
  },
  'ro.pit.sources': {
    reach: {
      estimate: 1,
      profiles: ['RO-PFA'],
      basis: 'Individuals with several sources of independent income in one set of books.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The key moves net income, and losses carried, from one source to another.',
    },
    obligations: ['D212'],
  },
  'ro.pit.norma': {
    reach: {
      estimate: 1,
      profiles: ['RO-PFA'],
      basis: 'Family enterprises taxed on a norm, and every norm of 2025 and 2026.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'A member taxed on the whole norm instead of a share pays several times the tax.',
    },
    obligations: ['D212'],
  },
  'ro.size.thresholds': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-06', 'RO-TAX-MICRO'],
      basis: 'Every company keeping double entry: it decides which annual statements it files.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'The wrong category files the wrong statements (S1005 against the small entities’).',
    },
    obligations: ['S1005', 'S1003'],
  },
  'ro.vat.exemption.threshold': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-PFA'],
      basis: 'Every company and PFA outside VAT, all year.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'Crossing it late makes VAT owed on every supply from the day it was crossed.',
    },
    obligations: ['D300', 'D406'],
  },
  'ro.deadline.S1003': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-06'],
      basis: 'Every company keeping double entry files its statements by it.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'Statements filed late are fined (Legea 82/1991 art. 42) and end the micro regime.',
    },
    obligations: ['S1003', 'S1005'],
  },
  'ro.halfyear.report': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-06'],
      basis: 'Companies above 1.000.000 € of net turnover in the previous year.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A half-year report owed and not filed is fined (Legea 82/1991 art. 42).',
    },
  },
  'ro.profit.legal_reserve': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-06'],
      basis:
        'Every profit-tax SRL whose legal reserve is below a fifth of its capital, each quarter.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'Deducting the reserve each quarter or only in the year changes every quarterly payment.',
    },
    obligations: ['D100.profit', 'D101'],
  },
  'ro.profit.social_limit': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-06', 'RO-PAY'],
      basis: 'Profit-tax employers with social expenses (gifts, aid, vouchers for gifts).',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The base sets what part of the social expenses is added back.',
    },
    obligations: ['D101'],
  },
  'ro.profit.sponsorship': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-06'],
      basis: 'Profit-tax companies that sponsor under Legea nr. 32/1994.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'Applying the credit quarterly or only yearly moves tax between the D100 quarters and the D101.',
    },
    obligations: ['D100.profit', 'D101'],
  },
  'ro.profit.loss_carryforward': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-06', 'RO-TAX-MICRO'],
      basis: 'Companies with tax losses, in particular those that were micro-enterprises between.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'A loss counted as expired or still usable changes the taxable profit by up to 70%.',
    },
    obligations: ['D101'],
  },
  'ro.vat.special.payable_account': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-04', 'RO-PFA'],
      basis:
        'Every company outside VAT that buys software, advertising or cloud services from abroad (Meta, Google, AWS, AI providers).',
    },
    risk: {
      kind: 'presentation',
      basis: 'The account holding the VAT owed through D301; the amount owed does not change.',
    },
    obligations: ['D301'],
  },
  'ro.vat.late_registration': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-01', 'RO-SRV-02'],
      basis: 'A company that crossed the small-enterprise threshold and registered late.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The rows and accounts of the VAT owed for the period it should have been registered.',
    },
    obligations: ['D300'],
  },
  'ro.vat.registration.annualized': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02'],
      basis:
        'A company registering for VAT during the year: its VAT period that year and the next.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A monthly or quarterly return filed for the wrong period.',
    },
    obligations: ['D300', 'D394'],
  },
  'ro.vat.capital_goods': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-05'],
      basis: 'A company with fixed assets entering or leaving the normal VAT regime.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The VAT adjusted on the capital goods in the first or the last return.',
    },
    obligations: ['D300'],
  },
  // The tax account (T2): every company that pays taxes to the single account.
  'ro.taxaccount.distribution': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO', 'RO-PAY', 'RO-OWN-01'],
      basis:
        'Every company paying withheld taxes, contributions and income taxes into the single account.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'A payment booked on the wrong obligations leaves others overdue, with interest and penalties.',
    },
    obligations: ['D112', 'D100.micro', 'D100.profit'],
  },
  'ro.taxaccount.advance': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO', 'RO-PAY'],
      basis: 'A payment made before its due date or before the return is filed: the common case.',
    },
    risk: {
      kind: 'presentation',
      basis:
        'When a prepayment settles the obligation in the books; the obligation itself is the same.',
    },
    obligations: ['D112', 'D100.micro'],
  },
  'ro.taxaccount.accounts': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO'],
      basis:
        'Companies with late payments (interest and penalties) or prepayments not yet distributed.',
    },
    risk: {
      kind: 'presentation',
      basis:
        'The expense and claim accounts of the statements; the profit tax treats both as non-deductible.',
    },
    obligations: ['D101', 'S1005'],
  },
  'ro.deadline.D406.assets': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-02', 'RO-SRV-05'],
      basis: 'Every company holding fixed assets files the annual assets file with D406.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A D406 filed late or out of order is fined (procedure code art. 337^1).',
    },
    obligations: ['D406.assets'],
  },
  'ro.d406.start': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-01', 'RO-SRV-02'],
      basis: 'Only months before 2025 depend on the category: books kept from before 2025.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'A D406 owed and not filed, or asked for months before the category files.',
    },
    obligations: ['D406'],
  },
  'ro.d406.assets.presentation': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-05'],
      basis: 'Every annual assets file writes the rate and its disposals.',
    },
    risk: {
      kind: 'presentation',
      basis: "The validator takes either reading; ANAF's analyses read the values.",
    },
    obligations: ['D406.assets'],
  },
};

/** The periods each return is filed for; urgency takes the earliest next deadline. */
export const obligationCadence: Readonly<
  Record<ObligationKind, readonly ('month' | 'quarter' | 'year')[]>
> = {
  D300: ['month', 'quarter'],
  D301: ['month'],
  D390: ['month'],
  D394: ['month', 'quarter'],
  D112: ['month'],
  'D112.quarterly': ['quarter'],
  'D100.micro': ['quarter'],
  'D100.dividends': ['month'],
  D205: ['year'],
  D406: ['month', 'quarter'],
  'D406.assets': ['year'],
  S1005: ['year'],
  S1003: ['year'],
  S1046: ['year'],
  D212: ['year'],
  D204: ['year'],
  'D100.profit': ['quarter'],
  D101: ['year'],
  'D700.micro_entry': ['year'],
  'D700.micro_exit': ['year'],
  'D700.micro_exit_january': ['year'],
};
