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
  {
    id: 'RO-GOODS-01',
    title: 'Comerț cu mărfuri, gestiunea stocurilor pe articole (G1)',
    defined: 'docs/CONFORMANCE.md (fațetă)',
  },
  {
    id: 'RO-GOODS-EU',
    title: 'Bunuri în Uniune, importuri și exporturi (G3)',
    defined: 'docs/CONFORMANCE.md (fațetă)',
  },
  {
    id: 'RO-RETAIL',
    title: 'Comerț cu amănuntul: case de marcat, rapoarte Z, preț cu amănuntul și B2C (G2)',
    defined: 'docs/CONFORMANCE.md (fațetă)',
  },
  {
    id: 'RO-PRODUCTION',
    title: 'Producție: fișe tehnice, comenzi, producție în curs, cost standard și efectiv (G4)',
    defined: 'docs/CONFORMANCE.md (fațetă)',
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
  'ro.payroll.mandate.deduction': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY', 'RO-TAX-MICRO'],
      basis:
        'Small companies whose administrator is paid under a mandate, often instead of an employee.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The personal deduction lowers the wage tax withheld each month.',
    },
    obligations: ['D112'],
  },
  'ro.garnishment.limits': {
    reach: {
      estimate: 1,
      profiles: ['RO-PAY'],
      basis: 'Employers who receive a garnishment order on an employee’s salary.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'Withholding more than the code allows is void (the sanction after the limits), and the employer answers for it.',
    },
    obligations: ['D112'],
  },
  'ro.sick.codes': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY'],
      basis:
        'Employers with an employee on medical leave; isolation certificates are the case in question.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The day paid or not changes the indemnity FNUASS bears, what the employer recovers and section D of D112.',
    },
    obligations: ['D112'],
  },
  'ro.sick.accident': {
    reach: {
      estimate: 1,
      profiles: ['RO-PAY'],
      basis:
        'Employers with a work accident or an occupational disease the pension house confirmed.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The indemnity paid, what the employer recovers from the pension house, and D112 B3 and C3.',
    },
    obligations: ['D112'],
  },
  'ro.payroll.voucher.limits': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY'],
      basis: 'Employers who grant meal or holiday vouchers, most of those with employees.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'CAS and CAM on what exceeds the law, and D112 E3_44.',
    },
    obligations: ['D112'],
  },
  // REGES-ONLINE is not a tax return: no obligation's deadline ranks the key.
  'ro.deadline.reges.change': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY'],
      basis:
        'Every employer who changes a salary, often by an addendum signed before or after it applies.',
    },
    risk: {
      kind: 'filing_rejection',
      basis:
        'A change transmitted late is a contravention (HG nr. 295/2025 art. 9 alin. (3)), fined 5,000 to 8,000 lei.',
    },
  },
  'ro.payroll.correction.retroactive': {
    reach: {
      estimate: 1,
      profiles: ['RO-PAY'],
      basis: 'Employers who raise a salary for a month already closed.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The tax and the deduction of the difference, and which D112 declares it.',
    },
    obligations: ['D112'],
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
  'ro.inventory.accounts': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-06'],
      basis: 'Every company whose annual inventory finds a cash difference or a missing asset.',
    },
    risk: {
      kind: 'presentation',
      basis: "The account decides the statements' row; the imputed amount is taxable either way.",
    },
    obligations: ['S1005', 'S1003'],
  },
  'ro.impairment.accounts': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-SRV-06'],
      basis: 'Every company with customers overdue, in litigation or insolvent at the year end.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The base of the impairment sets the expense and its deductible 30% or 100% (art. 26).',
    },
    obligations: ['D101', 'S1005', 'S1003'],
  },
  'ro.stock.accounts': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-01'],
      basis:
        'Every company keeping goods or materials in the register, at each count; no pilot company keeps stock yet.',
    },
    risk: {
      kind: 'presentation',
      basis:
        "The account decides the result's presentation (cost of goods or other revenue); the result is the same.",
    },
    obligations: ['S1005', 'S1003', 'D406'],
  },
  'ro.retail.zreport': {
    reach: {
      estimate: 2,
      profiles: ['RO-RETAIL'],
      basis:
        'Every company with a fiscal cash register, each day it sells: the Z report is booked by its means of payment.',
    },
    risk: {
      kind: 'presentation',
      basis:
        'The account tickets wait on (5328 or a claim on their issuer) moves the balance sheet, not the result or the VAT.',
    },
    obligations: ['D406'],
  },
  'ro.stock.retail.coefficient': {
    reach: {
      estimate: 1,
      profiles: ['RO-RETAIL'],
      basis:
        'Shops keeping goods at their retail price: every month, the markup discharged on the goods sold.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The coefficient sets the cost of the goods sold each month, so the taxable profit of the quarter.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'D406'],
  },
  'ro.efactura.b2c': {
    reach: {
      estimate: 2,
      profiles: ['RO-RETAIL', 'RO-SRV-02'],
      basis:
        'Every invoice to an individual, and the invoices a shop issues at a buyer’s request for a receipt.',
    },
    risk: {
      kind: 'filing_rejection',
      basis:
        'An invoice not transmitted within the deadline is fined (OUG nr. 120/2021 art. 13^2).',
    },
    obligations: ['D394'],
  },
  'ro.deadline.efactura': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-RETAIL'],
      basis: 'Every invoice issued to a buyer in Romania.',
    },
    risk: {
      kind: 'filing_rejection',
      basis: 'The worklist dates each invoice’s transmission from it.',
    },
  },
  'ro.stock.methods': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-01'],
      basis:
        'Every company keeping stock: its output method values each exit; no pilot company keeps stock yet.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The cost of goods sold, so the taxable profit of the period, depends on the method.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'D406'],
  },
  'ro.stock.returns': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-01'],
      basis:
        'Companies keeping stock at the weighted average after each receipt that return goods to a supplier or reverse a receipt; no pilot company keeps stock yet.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The difference against the average goes to the stock left or to the cost of goods sold, so the taxable profit of the period.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'D406'],
  },
  'ro.provisions.accounts': {
    reach: {
      estimate: 2,
      profiles: ['RO-PAY', 'RO-SRV-06'],
      basis: 'Every employer with untaken leave at the year end, and companies with lawsuits.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'A provision is added back (art. 26); a debt to the staff is deductible when its expense is incurred.',
    },
    obligations: ['D101', 'S1005', 'S1003'],
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
  'ro.vat.distance.threshold': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-03'],
      basis:
        'A VAT-registered company selling e-books, courses, software or goods at a distance to consumers in other Member States.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'Which state’s VAT a sale owes: Romanian VAT (D300 rd. 17) or the consumer state’s (D398).',
    },
    obligations: ['D300', 'D398'],
  },
  'ro.vat.oss.declarations': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-03'],
      basis: 'A company registered in the Union scheme (OSS).',
    },
    risk: { kind: 'presentation', basis: 'D300 rd. 3 holds the OSS sales or not; no VAT changes.' },
    obligations: ['D300'],
  },
  'ro.vat.oss.payable_account': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-03'],
      basis: 'A company registered in the Union scheme (OSS).',
    },
    risk: {
      kind: 'presentation',
      basis: 'The account of the VAT owed through D398; the amount does not change.',
    },
    obligations: ['D398'],
  },
  'ro.vat.oss.return': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-03'],
      basis:
        'A company registered in the Union scheme refunding a sale of a quarter already declared.',
    },
    risk: {
      kind: 'filing_rejection',
      basis:
        'A refund reducing the quarter’s operations may make them negative, which ANAF’s structure refuses.',
    },
    obligations: ['D398'],
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
      basis:
        'A company with fixed assets entering or leaving the normal VAT regime, or whose asset changes use (part of a building leased exempt), is sold or ceases to exist.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The VAT adjusted on the capital goods, once or each year of the adjustment period.',
    },
    obligations: ['D300', 'D406'],
  },
  // Exempt supplies and the pro-rata (V2): a company with exempt rent, financial or medical
  // supplies beside its taxable ones.
  'ro.vat.prorata': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-02'],
      basis:
        'A VAT payer with supplies exempt without the right of deduction (rent of property, financial, medical, education) beside taxable ones: its overheads deduct by the pro-rata, adjusted each December.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The year-end adjustment of the VAT deducted on every purchase for both kinds of operations.',
    },
    obligations: ['D300', 'D406'],
  },
  'ro.vat.stock_adjustment': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02'],
      basis:
        'A company entering or leaving the normal VAT regime with stock, assets in progress, unused intangibles or open advances.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The VAT adjusted on them in the first or the last return.',
    },
    obligations: ['D300', 'D406'],
  },
  'ro.vat.capital_goods.minimum': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-05'],
      basis:
        'Small adjustments of capital goods: each year a good is used otherwise than deducted.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'Whether an adjustment under 1.000 lei is made at all.',
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
  'ro.d406.oss': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-SRV-03'],
      basis:
        'A company registered in the Union scheme (OSS): every D406 of a period with its sales.',
    },
    risk: {
      kind: 'presentation',
      basis:
        "The validator takes either code and country; ANAF's analyses read the code, the rate and the VAT.",
    },
    obligations: ['D406'],
  },
  'ro.d406.conversion': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-03'],
      basis:
        'A company invoicing in euro: every D406 with an invoice whose VAT is at another rate than its revenue, or a credit note in euro.',
    },
    risk: {
      kind: 'presentation',
      basis:
        "The validator takes either reading (S.AM.1); ANAF's consistency tests read each TaxBase against its VAT.",
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
  'ro.vat.simplified_invoice.limit_eur': {
    reach: {
      estimate: 3,
      profiles: ['RO-SRV-02', 'RO-SRV-03', 'RO-SRV-04', 'RO-SRV-05'],
      basis:
        'Fuel, parking and small purchases on fiscal receipts: every VAT payer deducts their VAT only within the limit and with its code printed (receipts.recognize).',
    },
    risk: { kind: 'tax_amount', basis: "The limit decides whether a receipt's VAT is deducted." },
    obligations: ['D300', 'D394', 'D406'],
  },
  'ro.vat.reverse_charge.domestic': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02'],
      basis:
        'VAT payers buying or selling the goods of art. 331 (waste, timber, cereals, energy to traders, real estate taxed, gold, phones and electronics from 22,500 lei).',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'Reverse charge or not decides who collects the VAT and whether it is deductible.',
    },
    obligations: ['D300', 'D394'],
  },
  // The special VAT schemes (V4): margin schemes and the agricultural flat rate.
  'ro.vat.margin.travel': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02'],
      basis:
        'Travel agencies and tour operators selling single services in their own name (margin.travel each VAT period).',
    },
    risk: { kind: 'tax_amount', basis: "The period's margin sets the VAT collected on rd. 9." },
    obligations: ['D300', 'D394'],
  },
  'ro.vat.margin.goods': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02'],
      basis:
        'Dealers in second-hand goods, works of art, collectors items and antiques reselling under the scheme (margin.sale).',
    },
    risk: { kind: 'tax_amount', basis: "Each item's margin sets the VAT collected on rd. 9." },
    obligations: ['D300', 'D394'],
  },
  'ro.vat.flat_rate.agriculture': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-02', 'RO-PFA'],
      basis:
        'VAT payers buying agricultural products or services from farmers in the register (invoices.flatRate); farmers (PFA, II, IF) invoicing the compensation.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The percent sets the compensation paid and deducted on rd. 27.',
    },
    obligations: ['D300', 'D394', 'D406'],
  },
  // Withholding (O1): rent and intellectual property paid to individuals, non-residents.
  'ro.dividend.tax_rate': {
    reach: {
      estimate: 2,
      profiles: ['RO-OWN-01', 'RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO'],
      basis:
        'Every dividend paid, interim ones included (dividends.withhold), and those paid to non-residents (nonresidents.withhold).',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The tax withheld on dividends, declared in D100 and D205.',
    },
    obligations: ['D100.dividends', 'D205'],
  },
  'ro.rent.tax_rate': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO'],
      basis:
        'A company renting its office or a car from an individual (often its associate) withholds at every payment (payees.withhold).',
    },
    risk: { kind: 'tax_amount', basis: 'The tax withheld and declared in D100 (628) and D205.' },
    obligations: ['D100.withholding', 'D205'],
  },
  'ro.rent.expense_rate': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-01', 'RO-SRV-02', 'RO-TAX-MICRO'],
      basis: 'The net income every rent withholding is computed on.',
    },
    risk: { kind: 'tax_amount', basis: 'The base of the tax withheld on rent.' },
    obligations: ['D100.withholding', 'D205'],
  },
  'ro.ip.tax_rate': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-01', 'RO-SRV-02'],
      basis: 'Intellectual property paid to individual authors.',
    },
    risk: { kind: 'tax_amount', basis: 'The tax withheld, declared in D112.' },
    obligations: ['D112'],
  },
  'ro.ip.expense_rate': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-01', 'RO-SRV-02'],
      basis: 'Intellectual property paid to individual authors.',
    },
    risk: { kind: 'tax_amount', basis: 'The base of the tax withheld on intellectual property.' },
    obligations: ['D112'],
  },
  'ro.nonresident.tax_rate': {
    reach: {
      estimate: 2,
      profiles: ['RO-SRV-02', 'RO-SRV-03', 'RO-SRV-04'],
      basis:
        'Software licences, interest and services paid abroad: a services company buying from foreign suppliers meets it once a payment is a royalty.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The tax withheld from non-residents, declared in D100 (632–636) and D207.',
    },
    obligations: ['D100.withholding', 'D207'],
  },
  'ro.vat.intra_eu.vies': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-EU'],
      basis:
        'Every intra-community supply of goods: the buyer’s code checked in VIES some days before or after the supply.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'A supply whose code was not valid when the VAT became chargeable is taxable in Romania at the standard rate.',
    },
    obligations: ['D300', 'D390'],
  },
  'ro.vat.intra_eu.transport': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-EU'],
      basis:
        'Intra-community supplies whose transport is shown by one document only, or by the seller’s own truck.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'Without the exemption, the supply owes Romanian VAT from its chargeable event.',
    },
    obligations: ['D300', 'D390'],
  },
  'ro.vat.import': {
    reach: {
      estimate: 1,
      profiles: ['RO-GOODS-EU', 'RO-SRV-03'],
      basis: 'Every import of goods invoiced in a currency, with the customs declaration later.',
    },
    risk: {
      kind: 'presentation',
      basis:
        'The rate the goods enter at moves their cost and the exchange difference of the payable; the VAT is the declaration’s.',
    },
    obligations: ['S1005', 'S1003', 'D406'],
  },
  'ro.production.accounts': {
    reach: {
      estimate: 1,
      profiles: ['RO-PRODUCTION', 'RO-PAY'],
      basis:
        'Every manufacturer with employees, each month: the labour each work order takes decides its work in progress and its products’ cost.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The labour capitalized in the work in progress and in the stock of products moves the month’s result, so the taxable profit.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'S1003', 'D406'],
  },
  'ro.production.costing': {
    reach: {
      estimate: 1,
      profiles: ['RO-PRODUCTION'],
      basis: 'Every manufacturer with a work order open at a month’s end.',
    },
    risk: {
      kind: 'tax_amount',
      basis: 'The work in progress (331 against 711) is part of the period’s result.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'S1003', 'D406'],
  },
  'ro.production.coefficient': {
    reach: {
      estimate: 1,
      profiles: ['RO-PRODUCTION'],
      basis:
        'Manufacturers at the standard cost: every month, the price differences spread over the products sold.',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The coefficient sets the cost of the products sold each month, so the taxable profit of the quarter.',
    },
    obligations: ['D101', 'D100.profit', 'S1005', 'D406'],
  },
  'ro.nonresident.certificate_days': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-04'],
      basis: 'Payments to non-residents in the first days of a year.',
    },
    risk: { kind: 'tax_amount', basis: 'Whether the treaty rate or the domestic one applies.' },
    obligations: ['D100.withholding', 'D207'],
  },
  'ro.fx.adjustment.vat': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-03', 'RO-SRV-02'],
      basis:
        'Every credit note in a currency, issued or received, on an invoice taxed in Romania (invoices.credit, invoices.euConsumer at the place of origin).',
    },
    risk: {
      kind: 'tax_amount',
      basis:
        'The rate sets the VAT a credit note reduces in the VAT return, by the rate difference between the invoice and the note.',
    },
    obligations: ['D300', 'D394', 'D406'],
  },
  'ro.fx.adjustment.books': {
    reach: {
      estimate: 1,
      profiles: ['RO-SRV-03'],
      basis: 'Every credit note in a currency, issued or received (invoices.credit).',
    },
    risk: {
      kind: 'presentation',
      basis:
        'The rate splits the same lei between the revenue or expense the note reduces and the exchange difference; the VAT and the partner’s item do not change.',
    },
    obligations: ['D406', 'S1005'],
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
  'D100.withholding': ['month'],
  D205: ['year'],
  D207: ['year'],
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
  D398: ['quarter'],
  Intrastat: ['month'],
};
