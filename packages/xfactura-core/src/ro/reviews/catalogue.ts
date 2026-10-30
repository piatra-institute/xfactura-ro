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
    obligations: ['S1005'],
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
};

/** The periods each return is filed for; urgency takes the earliest next deadline. */
export const obligationCadence: Readonly<
  Record<ObligationKind, readonly ('month' | 'quarter' | 'year')[]>
> = {
  D300: ['month', 'quarter'],
  D390: ['month'],
  D394: ['month', 'quarter'],
  D112: ['month'],
  'D112.quarterly': ['quarter'],
  'D100.micro': ['quarter'],
  'D100.dividends': ['month'],
  D205: ['year'],
  D406: ['month', 'quarter'],
  S1005: ['year'],
  D212: ['year'],
  D204: ['year'],
};
