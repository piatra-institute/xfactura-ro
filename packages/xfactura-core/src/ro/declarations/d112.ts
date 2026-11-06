import { DomainError } from '../../errors';
import type { LocalDate } from '../../time';
import { element, serializeXml } from '../../xml/write';
import { workingDaysBetween } from '../calendar';
import { counties } from '../geo';
import { isValidCnp, isValidCui } from '../identifiers';
import { minimumExemptions, type MinimumExemption } from '../payroll/calculate';

/**
 * The monthly return of social contributions, income tax and the nominal record of insured
 * persons (D112, "Declarația privind obligațiile de plată a contribuțiilor sociale, impozitului pe
 * venit și evidența nominală a persoanelor asigurate") for reporting months 01/2026–12/2026, after
 * ANAF's XML structure D112_A7.2.6 v7: of 07.09.2026 (structura_D112_0726_070926) from 07/2026,
 * and of 30.03.2026 (structura_D112_0126_300326) for 01–06/2026, which differs only in its
 * parameters and in the medical-leave fields 07/2026 added.
 *
 * The structures' parameters are their months': the minimum wage of 4050 lei and the 300 lei OUG
 * 156/2024 leaves out of the bases in 01–06/2026, 4325 lei and 200 lei (OUG 89/2025) in 07–12/2026,
 * and the working days (NZL) of 2026. The payroll's own (`ro.payroll.minimum_wage`,
 * `ro.payroll.minimum_wage_relief`) are given with the model and must be the structure's. ANAF's
 * validator (DUKIntegrator, D112Validator J27.0.8 of 03.11.2026) applies the 07/2026 table to
 * months after 12/2026 too, for which none is published; J26.0.3 of 22.04.2026 validates 01–06/2026
 * as ANAF published it for them. Medical leave and work accidents in 01–06/2026 are refused: their
 * fields there (without D_9a–D_21a, B3_7D, C2_155–C2_156) are not written.
 * Where the XSD of 14.08.2026 and the validator differ, this module follows the validator: the
 * XSD types A_1, A_sal1 and A_sal2 as 1–30, lacks obligations 458 and 459, and allows asigExc only
 * 0–1.
 *
 * Covered: an employer owing CAM (datCAM 1), with no secondary establishments, whose insured are
 * employees under an individual employment contract (Nomenclator 5 types 1 and 51), at their main
 * job or elsewhere, in normal working conditions: section A of each insured person, with E1 or E2
 * and one E3. The structure lets the rest be absent: the insured's sections B for several
 * contracts or special or particular conditions, C (other categories), det1 (seconded employees)
 * and E4 (redirected tax); the employer's C3 (work accidents), C5 (construction), D and E1–E4
 * (other categories, and the unemployed whom the employment agencies declare), F1–F2 (secondary
 * establishments) and G; non-residents and exemptions from income tax (asigScu).
 *
 * Medical leave for ordinary illness (indemnity code 01) is declared per certificate in the
 * insured's section D, which may not stand beside section A (p. 36, 56): an employee with
 * certificates is declared in section B instead, one contract in normal conditions, B1 (the
 * contract), B2 (days worked and their CAS base), B3 (the indemnity days and bases) and B4 (the
 * totals), then D; the employer adds C2 (the cases, days and amounts by payer and percentage, and
 * what FNUASS owes back) and C1_12 (the indemnities' CAS base). The structure's E1–E4 of the
 * employer are for the unemployed (C_1 = 2), declared by the employment agencies, not for
 * employees. Other indemnity codes, section B with the minimum-contribution difference, and
 * type 51 with medical leave are refused until sourced. Where the structure (p. 56–62) and the
 * validator differ, this module follows the validator: D_14a, the employer's days, includes the
 * day left unpaid under OUG 91/2025 (the validator caps the paid D_14 at 5, not D_14a); D_19 is
 * D_17 / D_18 rounded to two decimals; the limit sum of section B counts the days worked (B4_1),
 * not the days worked and the medical-leave days of p. 3.
 *
 * The minimum-wage relief is A_13S of insured type 51, with A_13C = A_13 + A_13S; C1_11 adds it
 * back. Meal and holiday vouchers are in the gross income E3_8 (E3_60, E3_10, E3_75), A_sal2 and
 * the CASS base A_11, not in the CAS (A_13) or CAM (A_5) bases.
 *
 * Amounts are whole lei, N(15), never negative. Contributions are rounded arithmetically, a
 * nonzero amount below one leu becoming one leu.
 */

export const d112InsuredTypes = [
  ['1', 'Salariat (exclusiv 1.1)'],
  [
    '51',
    'Salariat (are CIM cu normă întreagă), beneficiar al măsurii „200 de lei din salariul minim, sumă netaxabilă” cf. OUG nr. 89/2025',
  ],
  ['6', 'Administratori ai SC/CN/SN/RA, membri CA/CS/CC și reprezentanții lor în AGA/CA'],
] as const;
/** A_1, E3_2: the Nomenclator 5 types covered. */
export type D112InsuredType = (typeof d112InsuredTypes)[number][0];

/** A_3, Nomenclator 12: N full time, Pn part time of n hours a day. */
export const d112ContractTypes = ['N', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const;
export type D112ContractType = (typeof d112ContractTypes)[number];

/** tip_rec, the reason a declaration is filed. */
export const d112Reasons = [
  [
    '2',
    'Declarație depusă ca urmare a acordării unor drepturi bănești stabilite prin lege sau în baza unor hotărâri judecătorești definitive și irevocabile/definitive și executorii, ori prin care s-a dispus reîncadrarea în muncă, potrivit art. 147 alin. (3) și (3^1) și art. 169 alin. (3) și (3^2) din Codul fiscal',
  ],
  [
    '3',
    'Declarație depusă ca urmare a unei inspecții fiscale sau a stabilirii obligațiilor fiscale din oficiu',
  ],
  [
    '4',
    'Declarație depusă după anularea rezervei verificării ulterioare, art. 105 alin. (6) lit. a) din Codul de procedură fiscală',
  ],
  [
    '5',
    'Declarație depusă după anularea rezervei verificării ulterioare, art. 105 alin. (6) lit. b) din Codul de procedură fiscală',
  ],
  [
    '7',
    'Declarație depusă ca urmare a acordării cumulat de sume potrivit art. 146 alin. (10) și (11) din Codul fiscal',
  ],
  [
    '8',
    'Declarație depusă ca urmare a unor hotărâri judecătorești prin care s-a dispus reîncadrarea activității în condiții deosebite sau speciale de muncă pentru perioade anterioare, potrivit art. 147 alin. (3^2) din Codul fiscal',
  ],
  ['9', 'Declarație depusă ca urmare a unei notificări de conformare'],
] as const;
export type D112Reason = (typeof d112Reasons)[number][0];

/** The obligations (Nomenclator 3) this module computes, in the form's order: code, budget code
 * (A_codBugetar) and label. */
export const d112Obligations = [
  ['602', '5503XXXXXX', 'Impozit pe veniturile din salarii și asimilate salariilor'],
  ['412', '5503XXXXXX', 'CAS datorată de asigurați'],
  ['432', '5503XXXXXX', 'CASS datorată de asigurați'],
  ['480', '20470300XX', 'Contribuția asiguratorie pentru muncă (CAM)'],
  [
    '458',
    '5503XXXXXX',
    'CAS suportată de angajator/plătitorul de venit (art. 146 alin. (5^9) din Codul fiscal)',
  ],
  [
    '459',
    '5503XXXXXX',
    'CASS suportată de angajator/plătitorul de venit (art. 168 alin. (6^1) din Codul fiscal)',
  ],
] as const;
export type D112ObligationCode = (typeof d112Obligations)[number][0];

/**
 * casaAng, casaSn (Nomenclator 2): a county health insurance house by its ISO 3166-2:RO code
 * (RO-GL, RO-B), or OPSNAJ, the house of the defence, public order, national security and judicial
 * authority sector, which insures some employees and no employer.
 */
export type D112HealthFund = `RO-${string}` | 'OPSNAJ';

/** D_9 (p. 59), Nomenclator 9 (p. 89): the indemnity codes declared, those the payroll computes
 * (`ro.sick.codes`). The work-accident codes (02–04), the reduced working time (10), the transfer
 * to other work (11) and the supervision of a child in quarantine (92) are refused. */
export const d112SickCodes = [
  '01',
  '05',
  '06',
  '07',
  '08',
  '09',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '51',
  '91',
] as const;
/** The C2 row of a code (Nomenclator 10): incapacity (Rd.1, isolation also Rd.1.1), prevention
 * (Rd.2, quarantine also Rd.2.2), maternity (Rd.3), child care (Rd.4), care of an oncological
 * patient (Rd.4.1), maternal risk (Rd.5). */
const sickGroup = (code: string) =>
  code === '07'
    ? 'quarantine'
    : code === '08'
      ? 'maternity'
      : code === '09' || code === '91'
        ? 'child_care'
        : code === '17'
          ? 'oncology_care'
          : code === '15'
            ? 'maternal_risk'
            : 'incapacity';
/** The codes FNUASS alone bears: D_20 is 0 (p. 61). */
const fundOnlyCodes = ['07', '08', '09', '91', '15', '17', '51'];

/** D_10 (p. 59), Nomenclator 8 (p. 88–89), in its order: who prescribed the certificate. The
 * validator also accepts 5, CEX, which the XSD's 1–4 does not. */
export const d112PrescriptionPlaces = ['family_doctor', 'hospital', 'ambulatory', 'cas'] as const;
export type D112PrescriptionPlace = (typeof d112PrescriptionPlaces)[number];

/** D_28 (p. 61–62): the percentage of the base applied to a code 01 certificate (OUG 158/2005
 * art. 17). */
export const d112SickPercents = ['55', '65', '75'] as const;
export type D112SickPercent = (typeof d112SickPercents)[number];

/** One medical certificate of the month (asiguratD, p. 56–62), as the payroll paid it. */
export type D112SickCertificate = {
  /** D_1 (C(5)), D_2 (C(10)), p. 57: series and number, unique in the declaration. */
  series: string;
  number: string;
  /** D_3, D_4 (p. 57): the certificate it continues, without interruption; Data_CMI (p. 57): the
   * first day of the episode's initial certificate. D_20a and D_21a (p. 61), the differences
   * recalculated for a continuation, are written as 0: the payroll does not recalculate. */
  continues?: { series: string; number: string; initialFrom: string };
  /** D_5 (p. 57–58): the day it was issued, YYYY-MM-DD. */
  issued: string;
  /** D_6, D_7 (p. 57–58): its first and last day, both within the reporting month. */
  from: string;
  to: string;
  /** D_9 (p. 59) */
  code: string;
  /** D_10 (p. 59) */
  place: D112PrescriptionPlace;
  /** D_23 (p. 61): the diagnosis code written on the certificate, C(3). */
  diagnosis: string;
  /** D_9b (p. 59), and D_14a less D_14 (p. 60): the episode's first working day, left unpaid
   * under OUG 91/2025 art. II for certificates issued from 1 February 2026 to 31 December 2027
   * (p. 5). D_9a, patients of the national health programmes, is not written: the payroll does
   * not know them. */
  unpaidDays: number;
  /** D_14 (p. 60): the working days the employer pays; D_15a, D_15: those FNUASS pays. D_16a and
   * D_16 add them up. */
  employerDays: number;
  fundDays: number;
  /** D_17, D_18 (p. 60): the insured income of the base, whole lei, and its working days; D_19
   * (p. 60–61) is computed from them. */
  base: { income: number; days: number };
  /** D_28 (p. 61–62): only for code 01. */
  percent: D112SickPercent | null;
  /** D_8, D_8a (p. 58): the child's CNP for codes 09 and 91, the patient's for 17. */
  careCnp?: string;
  /** D_11 (p. 59): the medical-surgical emergency of code 06; D_12: the infectious disease of
   * codes 05 and 51. */
  urgencyCode?: string;
  infectiousCode?: string;
  /** D_20, D_21 (p. 61): the indemnity borne by the employer and by FNUASS, whole lei. */
  employer: number;
  fund: number;
};

export type D112Minimum =
  /** asigExc 1, with motivExc: the minimum contribution does not apply (art. 146 alin. (5^7)). */
  | { kind: 'exempt'; reason: MinimumExemption }
  /** asigExc 2: CAS and CASS are due at least on `base`, the limit sum (rd. 8.1, 9.1) of art. 146
   * alin. (5^6) and art. 168 alin. (6^1) Cod fiscal, the difference borne by the employer. The
   * structure computes it as (4325 − 200) × A_8 / NZL rounded; ANAF's validator accepts any value
   * from round(4125 × A_8 / NZL) − 1 up, so it is an input, checked against the structure. */
  | { kind: 'due'; base: number };

export type D112Insured = {
  /** cnpAsig */
  cnp: string;
  /** numeAsig */
  lastName: string;
  /** prenAsig */
  firstName: string;
  /** dataAng: the date the person became insured with the employer, YYYY-MM-DD. */
  from: string;
  /** dataSf: the date the person stopped being insured, within or before the period. */
  until?: string;
  /** casaSn */
  healthFund: D112HealthFund;
  /** asigCI: insured for medical leave and benefits (concedii și indemnizații). */
  sickLeaveInsured: boolean;
  /** asigSO: insured in the unemployment insurance system. */
  unemploymentInsured: boolean;
  /** asigExc, motivExc; absent when the CAS base reaches the minimum wage for the days worked. */
  minimum?: D112Minimum;
  /** asiguratA, or with medical leave asiguratB1–B4 (in brackets) */
  employment: {
    /** A_1 (B1_1) */
    type: D112InsuredType;
    /** A_2 (B1_2) */
    pensioner: boolean;
    /** A_3 (B1_3) */
    contract: D112ContractType;
    /** A_4 (B1_4): the daily norm of the workplace, 6, 7 or 8 hours. */
    normHours: number;
    /** A_sal1 (B1_sal1): the monthly gross base salary of the contract. */
    baseSalary: number;
    /** A_6 (B1_6): hours actually worked in the month. */
    hoursWorked: number;
    /** A_7 (B1_7): hours the contract was suspended in the month, medical leave included. */
    hoursSuspended: number;
    /** A_8 (B1_15, B2_2, B4_1): days worked. */
    daysWorked: number;
    /** A_9 (B1_10, B4_3): the base for the unemployment benefit; the structure gives no formula. */
    unemploymentBase: number;
    /** A_5 (B1_5, B4_14): the CAM base. */
    camBase: number;
    /** A_11 (B4_5): the CASS base, vouchers and sick pay included. */
    cassBase: number;
    /** A_12 (B4_6): CASS withheld. */
    cass: number;
    /** A_13 (B4_7): the CAS base, without vouchers, sick pay included. */
    casBase: number;
    /** A_14 (B4_8): CAS withheld. */
    cas: number;
    /** A_13S: the minimum-wage amount left out of the bases (OUG 89/2025), type 51 only. */
    relief: number;
  };
  /** asiguratD: the month's medical certificates; with any, the insured is declared in section B. */
  sickLeave?: D112SickCertificate[];
  /** The month's work accidents and occupational diseases the pension house confirmed (Legea nr.
   * 346/2002), declared in B3 and C3, not in section D: cases (certificates), their working days,
   * those borne by the state social insurance budget, and the amounts by payer, whole lei. */
  accidents?: { cases: number; days: number; fundDays: number; employer: number; fund: number };
  /** asiguratE3, and E1 or E2 */
  income: {
    /** E3_3: 1 at the main job (funcția de bază), 2 elsewhere. */
    mainJob: boolean;
    /** The salary paid in money; E3_8 adds the vouchers. */
    cash: number;
    /** E3_10: meal vouchers, within E3_60. */
    mealVouchers: number;
    /** E3_75: holiday vouchers, within E3_60. */
    holidayVouchers: number;
    /** E3_11: dependents, main job only. */
    dependents: number;
    /** E3_121, E3_1221, E3_1222: the basic personal deduction and the supplementary ones of art. 77
     * alin. (10) lit. a) (under 26) and lit. b) (children in school), main job only; whole lei,
     * rounded arithmetically. */
    deduction: { basic: number; young: number; children: number };
    /** E3_13: other deductions (union dues, voluntary pension and health contributions). */
    otherDeductions: number;
    /** E3_14 */
    taxBase: number;
    /** E3_15 */
    tax: number;
    /** E3_16: the amount paid to the person. */
    paid: number;
    /** Benefits in kind (art. 76 alin. (3)–(4^1)): the taxable ones in E3_44 (any other in kind)
     * and E3_58 (insurance premiums), within E3_60; those left out of income in E3_86 (gifts,
     * within E3_69), E3_78 (housing) and E3_71 (health insurance), within E3_90. Whole lei. */
    benefits?: Partial<Record<'E3_44' | 'E3_58' | 'E3_86' | 'E3_78' | 'E3_71', number>>;
  };
};

export type D112 = {
  /** luna_r, an_r */
  period: { year: number; month: number };
  /** d_rec: corrects the declaration already filed for the period. */
  correction: boolean;
  /** tip_rec */
  reason?: D112Reason;
  declarant: {
    /** nume_declar */
    lastName: string;
    /** prenume_declar */
    firstName: string;
    /** functie_declar */
    role: string;
  };
  employer: {
    /** cif: digits only, without the RO prefix. */
    cui: string;
    /** cifS: the successor, for a declaration filed under art. 90 alin. (4) Cod procedură fiscală. */
    successorCui?: string;
    /** rgCom */
    tradeRegister?: string;
    /** caen: a class of Nomenclator 1. */
    caen: string;
    /** den */
    name: string;
    /** adrSoc, telSoc, faxSoc, mailSoc */
    registeredOffice: { address: string; phone?: string; fax?: string; email?: string };
    /** adrFisc, telFisc, faxFisc, mailFisc */
    fiscalDomicile?: { address?: string; phone?: string; fax?: string; email?: string };
    /** casaAng */
    healthFund: D112HealthFund;
  };
  insured: D112Insured[];
  /** The payroll's minimum wage and the relief of the minimum wage for the month, whole lei, from
   * the rule register: they must be the structure's (salMin, Suma300 or Suma200). The structure's
   * own when absent. */
  parameters?: { minimumWage: number; relief: number };
};

/** The structure's computed fields of one insured person. */
export type D112InsuredCalculation = {
  /** idAsig */
  id: number;
  /** E3_8, A_sal2: income in money and vouchers. */
  income: bigint;
  /** E3_60: the vouchers and the taxable benefits in kind. */
  benefits: bigint;
  /** E3_69: income art. 76 alin. (4) leaves out (gifts); E3_90: what alin. (4^1) caps. */
  exemptIncome: bigint;
  capped: bigint;
  /** A_13C: the CAS base plus the amount left out, for type 51. */
  reliefIncome: bigint;
  /** A_13P, A_14P, A_11P, A_12P: the limit sums and the contributions due on them. */
  limit: { casBase: bigint; cas: bigint; cassBase: bigint; cass: bigint };
  /** A_14D, A_12D: the difference borne by the employer. */
  employer: { cas: bigint; cass: bigint };
  /** E3_9: CAS and CASS withheld. */
  contributions: bigint;
  /** E3_12, E3_122 */
  deduction: { total: bigint; supplementary: bigint };
  /** Timp_E3 */
  tax: bigint;
  /** Section B's medical-leave fields, for an insured with certificates. */
  sick?: D112SickCalculation;
};

/** The structure's computed fields of one certificate. */
export type D112CertificateCalculation = {
  /** D_14a: the employer's working days, the unpaid one included. */
  employerDays: number;
  /** D_16a, D_16: all the certificate's working days, and those paid. */
  days: number;
  paidDays: number;
  /** D_19: D_17 / D_18 in bani, rounded half up as the validator checks it. */
  dailyAverage: bigint;
};

export type D112SickCalculation = {
  /** B3_1, B3_6: the paid working days of medical leave, ΣD_16. */
  days: number;
  /** B3_12, B3_13: ΣD_20, ΣD_21. */
  employer: bigint;
  fund: bigint;
  /** B3_7: the CAS base of the indemnities, B3_12 + B3_13. */
  base: bigint;
  /** B2_5: the CAS base of the days worked, B4_7 − B3_7. */
  workBase: bigint;
  certificates: D112CertificateCalculation[];
  /** B3_8, B3_4, B3_10, B3_9: a work accident's working days, those borne by the state social
   * insurance budget, and the amounts by payer (B3_11 their sum). */
  accident: { cases: number; days: number; fundDays: number; employer: bigint; fund: bigint };
};

/** One row of the employer's C2: cases (certificates), paid working days, of them the employer's
 * and FNUASS's, and the amounts by payer. */
export type D112MedicalLeaveRow = {
  cases: number;
  days: number;
  employerDays: number;
  fundDays: number;
  employer: bigint;
  fund: bigint;
};

export type D112MedicalLeave = {
  /** Rd.1, C2_11–C2_16: temporary incapacity for work; Rd.1.1, C2_111–C2_116: of it, infectious
   * diseases with isolation (code 51). */
  incapacity: D112MedicalLeaveRow;
  isolation: D112MedicalLeaveRow;
  /** Rd.2, C2_21–C2_26: prevention; Rd.2.2, C2_211–C2_216: of it, quarantine (07). */
  prevention: D112MedicalLeaveRow;
  quarantine: D112MedicalLeaveRow;
  /** Rd.3, Rd.4, Rd.4.1, Rd.5: maternity (08), child care (09, 91), care of an oncological patient
   * (17), maternal risk (15), all borne by FNUASS. */
  maternity: D112MedicalLeaveRow;
  childCare: D112MedicalLeaveRow;
  oncologyCare: D112MedicalLeaveRow;
  maternalRisk: D112MedicalLeaveRow;
  /** Rd.1.2–1.4, C2_121–C2_146: code 01 at 55, 65 and 75% of the base. */
  byPercent: Record<D112SickPercent, D112MedicalLeaveRow>;
  /** C2_T6, C2_10, C2_140: borne by FNUASS, which the employer paid and recovers. */
  recoverable: bigint;
};

export type D112Obligation = {
  code: D112ObligationCode;
  budgetCode: string;
  /** A_datorat, A_deductibil, A_scutit, A_plata */
  owed: bigint;
  deductible: bigint;
  exempt: bigint;
  payable: bigint;
};

export type D112Calculation = {
  namespace: string;
  /** NZL: the working days of the month. */
  workingDays: number;
  insured: D112InsuredCalculation[];
  /** angajatorA: every obligation with an amount, or the income tax alone when none has. */
  obligations: D112Obligation[];
  /** angajatorB */
  counts: {
    /** B_cnp: insured for unemployment. */
    unemployment: number;
    /** B_sanatate: insured for medical leave and benefits. */
    sickLeave: number;
    /** B_pensie: insured owing CAS. */
    pension: number;
    /** B_sal: employees. */
    employees: number;
  };
  /** B_brutSalarii: the CASS bases of those insured for medical leave. */
  grossSalaries: bigint;
  /** C1_11, C1_T1: income in normal working conditions. */
  normalIncome: bigint;
  /** C1_12, C1_T2: the CAS base of the medical-leave indemnities, ΣB3_7. */
  sickLeaveBase: bigint;
  /** angajatorC2, with any medical certificate. */
  medicalLeave?: D112MedicalLeave;
  /** angajatorC3 rd. 1 and C1_7, with any work accident: cases, working days, the total and the
   * part borne by the state social insurance budget, which the employer recovers. */
  accidents?: { cases: number; days: number; total: bigint; fund: bigint };
  /** C4_baza, C4_ct */
  cam: { base: bigint; amount: bigint };
  /** totalPlata_A */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
// pCAM, Cipens, Cisan: the same in both structures of 2026.
const camRate = 225n; // basis points
const casRate = 2500n;
const cassRate = 1000n;

const periodIndex = (year: number, month: number) => year * 12 + month - 1;

/** A structure of ANAF's for a range of reporting months: its salMin, the relief it leaves out of
 * the bases (Suma300, Suma200) and the NZL of its months, as the structure and the validator
 * count them. */
type Structure = {
  first: number;
  last: number;
  /** Months, for the messages. */
  label: string;
  minimumWage: bigint;
  relief: bigint;
  /** The text granting the relief. */
  reliefText: string;
  workingDays: Readonly<Record<number, number>>;
  /** The medical-leave fields 07/2026 added are written. */
  sickLeave: boolean;
};
const structures: readonly Structure[] = [
  // structura_D112_0126_300326: salMin 4050, Suma300 (OUG 156/2024 as OUG 89/2025 kept it).
  {
    first: periodIndex(2026, 1),
    last: periodIndex(2026, 6),
    label: 'ianuarie–iunie 2026',
    minimumWage: 4050n,
    relief: 300n,
    reliefText: 'OUG nr. 156/2024',
    workingDays: { 1: 18, 2: 20, 3: 22, 4: 20, 5: 20, 6: 21 },
    sickLeave: false,
  },
  // structura_D112_0726_070926: salMin 4325, Suma200 (OUG 89/2025).
  {
    first: periodIndex(2026, 7),
    last: periodIndex(2026, 12),
    label: 'iulie–decembrie 2026',
    minimumWage: 4325n,
    relief: 200n,
    reliefText: 'OUG nr. 89/2025',
    workingDays: { 7: 23, 8: 21, 9: 22, 10: 22, 11: 20, 12: 21 },
    sickLeave: true,
  },
];

/** The structure of a reporting month, or undefined outside 01/2026–12/2026. */
function structureOf(period: D112['period']): Structure | undefined {
  if (!Number.isInteger(period.year) || !Number.isInteger(period.month)) return undefined;
  if (period.month < 1 || period.month > 12) return undefined;
  const index = periodIndex(period.year, period.month);
  return structures.find((item) => item.first <= index && index <= item.last);
}

const periodMessage =
  'Declarația D112 se scrie pentru lunile ianuarie–decembrie 2026, în structurile ANAF publicate pentru ele.';

/** The structure's namespace for a reporting month of 01/2026–12/2026. */
export function d112Namespace(period: D112['period']): string {
  if (!structureOf(period)) throw new DomainError('D112_PERIOD', periodMessage);
  return 'mfp:anaf:dgti:declaratie_unica:declaratie:v7';
}

/** casaAng/casaSn for a health fund, or undefined when it is not in Nomenclator 2. */
function healthFundCode(fund: string): string | undefined {
  if (fund === 'OPSNAJ') return '_A';
  if (!counties[fund]) return undefined;
  return fund === 'RO-B' ? '_B' : fund.slice(3);
}

/** amount × basis points / 10000, rounded half up; a nonzero amount below one leu is one leu. */
function contribution(base: bigint, rate: bigint): bigint {
  const product = base * rate;
  const whole = product / 10_000n;
  const rounded = 2n * (product % 10_000n) >= 10_000n ? whole + 1n : whole;
  return rounded === 0n && product > 0n ? 1n : rounded;
}

/** The structure's limit sum: (salMin − Suma300 or Suma200) × A_8 / NZL, rounded; the validator
 * truncates. */
function structureLimit(structure: Structure, daysWorked: number, workingDays: number) {
  const product = (structure.minimumWage - structure.relief) * BigInt(daysWorked);
  const days = BigInt(workingDays);
  const floor = product / days;
  return { rounded: 2n * (product % days) >= days ? floor + 1n : floor, floor };
}

const contractHours = (contract: D112ContractType, normHours: number) =>
  contract === 'N' ? normHours : Number(contract.slice(1));

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 999_999_999_999_999;

/** The inputs calculateD112 cannot use: amounts, counts and nomenclature codes. */
function inputProblems(model: D112): Problem[] {
  const problems: Problem[] = [];
  const amount = (path: string, value: unknown, label: string) => {
    if (!isAmount(value))
      problems.push({
        code: 'D112_AMOUNT',
        path,
        message: `${label}: o sumă în lei, fără zecimale, nenegativă, de cel mult 15 cifre.`,
      });
  };
  const count = (path: string, value: unknown, label: string, max: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
      problems.push({
        code: 'D112_COUNT',
        path,
        message: `${label} este un număr natural de cel mult ${max}.`,
      });
  };
  model.insured.forEach((insured, index) => {
    const path = `insured.${index}`;
    const { employment: work, income, minimum } = insured;
    if (!d112InsuredTypes.some(([type]) => type === work.type))
      problems.push({
        code: 'D112_TYPE',
        path: `${path}.employment.type`,
        message: `Tipul de asigurat ${work.type} nu este acoperit; se declară salariați cu contract individual de muncă (tipurile 1 și 51).`,
      });
    if (!(d112ContractTypes as readonly string[]).includes(work.contract))
      problems.push({
        code: 'D112_CONTRACT',
        path: `${path}.employment.contract`,
        message: `Tipul de contract ${work.contract} nu există în Nomenclatorul 12.`,
      });
    if (![6, 7, 8].includes(work.normHours))
      problems.push({
        code: 'D112_CONTRACT',
        path: `${path}.employment.normHours`,
        message: 'Norma zilnică a locului de muncă este de 6, 7 sau 8 ore.',
      });
    count(`${path}.employment.hoursWorked`, work.hoursWorked, 'Numărul orelor lucrate', 999);
    count(
      `${path}.employment.hoursSuspended`,
      work.hoursSuspended,
      'Numărul orelor suspendate',
      999,
    );
    count(`${path}.employment.daysWorked`, work.daysWorked, 'Numărul zilelor lucrate', 99);
    for (const [key, label] of [
      ['baseSalary', 'Salariul de bază'],
      ['unemploymentBase', 'Baza indemnizației de șomaj'],
      ['camBase', 'Baza CAM'],
      ['cassBase', 'Baza CASS'],
      ['cass', 'CASS'],
      ['casBase', 'Baza CAS'],
      ['cas', 'CAS'],
      ['relief', 'Suma neimpozabilă'],
    ] as const)
      amount(`${path}.employment.${key}`, work[key], label);
    for (const [key, label] of [
      ['cash', 'Venitul în bani'],
      ['mealVouchers', 'Valoarea tichetelor de masă'],
      ['holidayVouchers', 'Valoarea voucherelor de vacanță'],
      ['otherDeductions', 'Alte deduceri'],
      ['taxBase', 'Baza de calcul a impozitului'],
      ['tax', 'Impozitul'],
      ['paid', 'Suma încasată'],
    ] as const)
      amount(`${path}.income.${key}`, income[key], label);
    for (const key of ['basic', 'young', 'children'] as const)
      amount(`${path}.income.deduction.${key}`, income.deduction[key], 'Deducerea personală');
    count(`${path}.income.dependents`, income.dependents, 'Numărul persoanelor în întreținere', 99);
    const certificates = insured.sickLeave ?? [];
    // B2_5 = B4_7 − B3_7: the CAS base holds the indemnities.
    const indemnities = certificates.reduce((total, item) => total + item.employer + item.fund, 0);
    if (isAmount(work.casBase) && work.casBase < indemnities)
      problems.push({
        code: 'D112_SICK_BASE',
        path: `${path}.employment.casBase`,
        message: `Baza CAS (${work.casBase}) nu cuprinde indemnizațiile de concediu medical (${indemnities}).`,
      });
    certificates.forEach((certificate, at) => {
      const where = `${path}.sickLeave.${at}`;
      for (const [key, label] of [
        ['unpaidDays', 'Numărul zilelor neplătite'],
        ['employerDays', 'Numărul zilelor plătite de angajator'],
        ['fundDays', 'Numărul zilelor plătite din FNUASS'],
      ] as const)
        count(`${where}.${key}`, certificate[key], label, 31);
      count(`${where}.base.days`, certificate.base.days, 'Numărul zilelor bazei de calcul', 999);
      amount(`${where}.base.income`, certificate.base.income, 'Veniturile bazei de calcul');
      amount(`${where}.employer`, certificate.employer, 'Indemnizația suportată de angajator');
      amount(`${where}.fund`, certificate.fund, 'Indemnizația suportată din FNUASS');
      if (
        certificate.code === '01' &&
        !(d112SickPercents as readonly string[]).includes(certificate.percent ?? '')
      )
        problems.push({
          code: 'D112_SICK_PERCENT',
          path: `${where}.percent`,
          message: 'Procentul aplicat bazei de calcul este 55, 65 sau 75.',
        });
      if (!(d112PrescriptionPlaces as readonly string[]).includes(certificate.place))
        problems.push({
          code: 'D112_SICK_PLACE',
          path: `${where}.place`,
          message: `Locul de prescriere ${certificate.place} nu există în Nomenclatorul 8.`,
        });
    });
    if (!minimum) return;
    if (minimum.kind === 'due')
      amount(`${path}.minimum.base`, minimum.base, 'Suma limită de calcul');
    else if (minimum.kind !== 'exempt' || !minimumExemptions.includes(minimum.reason))
      problems.push({
        code: 'D112_MINIMUM',
        path: `${path}.minimum`,
        message:
          'Excepția de la contribuția minimă are unul dintre motivele art. 146 alin. (5^7) Cod fiscal.',
      });
  });
  return problems;
}

const sum = <T>(items: readonly T[], value: (item: T, index: number) => bigint) =>
  items.reduce((total, item, index) => total + value(item, index), 0n);
const big = (value: number) => BigInt(value);

/** `numerator / denominator`, rounded half up. */
const halfUp = (numerator: bigint, denominator: bigint) =>
  (2n * numerator + denominator) / (2n * denominator);

function sickCalculation(insured: D112Insured): D112SickCalculation | undefined {
  const certificates = insured.sickLeave ?? [];
  const accidents = insured.accidents;
  if (!certificates.length && !accidents?.cases) return undefined;
  const employer = sum(certificates, (certificate) => big(certificate.employer));
  const fund = sum(certificates, (certificate) => big(certificate.fund));
  return {
    accident: {
      cases: accidents?.cases ?? 0,
      days: accidents?.days ?? 0,
      fundDays: accidents?.fundDays ?? 0,
      employer: big(accidents?.employer ?? 0),
      fund: big(accidents?.fund ?? 0),
    },
    days: certificates.reduce((days, item) => days + item.employerDays + item.fundDays, 0),
    employer,
    fund,
    base: employer + fund,
    workBase: big(insured.employment.casBase) - employer - fund,
    certificates: certificates.map((certificate) => ({
      employerDays: certificate.unpaidDays + certificate.employerDays,
      days: certificate.unpaidDays + certificate.employerDays + certificate.fundDays,
      paidDays: certificate.employerDays + certificate.fundDays,
      dailyAverage: certificate.base.days
        ? halfUp(big(certificate.base.income) * 100n, big(certificate.base.days))
        : 0n,
    })),
  };
}

function insuredCalculation(insured: D112Insured, index: number): D112InsuredCalculation {
  const { employment: work, income, minimum } = insured;
  const inKind = income.benefits ?? {};
  const field = (key: keyof typeof inKind) => big(inKind[key] ?? 0);
  // E3_60: the vouchers and the taxable benefits; E3_69 and E3_90: what art. 76 alin. (4) and
  // (4^1) leave out of income, declared within the gross (E3_8 >= E3_60 + E3_69 + E3_90).
  const exemptIncome = field('E3_86');
  const capped = field('E3_78') + field('E3_71');
  const benefits =
    big(income.mealVouchers) + big(income.holidayVouchers) + field('E3_44') + field('E3_58');
  const sick = sickCalculation(insured);
  let limit = { casBase: 0n, cas: 0n, cassBase: 0n, cass: 0n };
  if (minimum?.kind === 'due') {
    const base = big(minimum.base);
    // Section B compares the base of the days worked, B2_5, for both (B4_7P, B4_5P).
    const casBase = (sick?.workBase ?? big(work.casBase)) < base ? base : 0n;
    const cassBase = (sick?.workBase ?? big(work.cassBase)) < base ? base : 0n;
    limit = {
      casBase,
      cas: contribution(casBase, casRate),
      cassBase,
      cass: contribution(cassBase, cassRate),
    };
  }
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  const supplementary = big(income.deduction.young) + big(income.deduction.children);
  return {
    id: index + 1,
    income: big(income.cash) + benefits + exemptIncome + capped,
    benefits,
    exemptIncome,
    capped,
    reliefIncome: work.relief > 0 ? big(work.casBase) + big(work.relief) : 0n,
    limit,
    employer: {
      cas: positive(limit.cas - big(work.cas)),
      cass: positive(limit.cass - big(work.cass)),
    },
    contributions: big(work.cas) + big(work.cass),
    deduction: { total: big(income.deduction.basic) + supplementary, supplementary },
    tax: big(income.tax),
    ...(sick ? { sick } : {}),
  };
}

const emptyRow = (): D112MedicalLeaveRow => ({
  cases: 0,
  days: 0,
  employerDays: 0,
  fundDays: 0,
  employer: 0n,
  fund: 0n,
});

/** angajatorC2 (p. 15–22) from the certificates: each certificate is a case of its group's row,
 * a code 01 one also of the row of its percentage, an isolation one of Rd.1.1 and a quarantine one
 * of Rd.2.2; nothing is recalculated for continuations (Rd.1.5). */
function medicalLeave(people: readonly D112Insured[]): D112MedicalLeave | undefined {
  const certificates = people.flatMap((person) => person.sickLeave ?? []);
  if (!certificates.length) return undefined;
  const leave: Omit<D112MedicalLeave, 'recoverable'> = {
    incapacity: emptyRow(),
    isolation: emptyRow(),
    prevention: emptyRow(),
    quarantine: emptyRow(),
    maternity: emptyRow(),
    childCare: emptyRow(),
    oncologyCare: emptyRow(),
    maternalRisk: emptyRow(),
    byPercent: { '55': emptyRow(), '65': emptyRow(), '75': emptyRow() },
  };
  for (const certificate of certificates) {
    const group = sickGroup(certificate.code);
    const rows =
      group === 'incapacity'
        ? [
            leave.incapacity,
            ...(certificate.code === '51' ? [leave.isolation] : []),
            ...(certificate.percent ? [leave.byPercent[certificate.percent]] : []),
          ]
        : group === 'quarantine'
          ? [leave.prevention, leave.quarantine]
          : group === 'maternity'
            ? [leave.maternity]
            : group === 'child_care'
              ? [leave.childCare]
              : group === 'oncology_care'
                ? [leave.oncologyCare]
                : [leave.maternalRisk];
    for (const row of rows) {
      row.cases += 1;
      row.days += certificate.employerDays + certificate.fundDays;
      row.employerDays += certificate.employerDays;
      row.fundDays += certificate.fundDays;
      row.employer += big(certificate.employer);
      row.fund += big(certificate.fund);
    }
  }
  const recoverable =
    leave.incapacity.fund +
    leave.prevention.fund +
    leave.maternity.fund +
    leave.childCare.fund +
    leave.maternalRisk.fund +
    leave.oncologyCare.fund;
  return { ...leave, recoverable };
}

/**
 * The structure's derived fields of a declaration: per insured person the limit sums, the
 * difference borne by the employer and the E1/E2/E3 totals; for the employer the counts, the CAM
 * base and amount, the obligations and totalPlata_A. Throws when an amount, count or code is not
 * one the declaration accepts; checkD112 lists those without throwing.
 */
export function calculateD112(model: D112): D112Calculation {
  const namespace = d112Namespace(model.period);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);

  const insured = model.insured.map(insuredCalculation);
  const people = model.insured;
  const camBase = sum(people, (person) => big(person.employment.camBase));
  const cam = { base: camBase, amount: contribution(camBase, camRate) };
  const amounts: Record<D112ObligationCode, bigint> = {
    '602': sum(insured, (person) => person.tax),
    '412': sum(people, (person) => big(person.employment.cas)),
    '432': sum(people, (person) => big(person.employment.cass)),
    '480': cam.amount,
    '458': sum(insured, (person) => person.employer.cas),
    '459': sum(insured, (person) => person.employer.cass),
  };
  const due = d112Obligations.filter(([code]) => amounts[code] > 0n);
  const obligations = (due.length ? due : d112Obligations.slice(0, 1)).map(
    ([code, budgetCode]) => ({
      code,
      budgetCode,
      owed: amounts[code],
      deductible: 0n,
      exempt: 0n,
      payable: amounts[code],
    }),
  );
  const unemploymentBase = (person: D112Insured) =>
    person.unemploymentInsured && !person.employment.pensioner;
  const leave = medicalLeave(people);
  return {
    namespace,
    workingDays: structureOf(model.period)!.workingDays[model.period.month]!,
    insured,
    obligations,
    counts: {
      unemployment: people.filter(unemploymentBase).length,
      sickLeave: people.filter((person) => person.sickLeaveInsured).length,
      pension: people.filter((person) => person.employment.cas > 0).length,
      employees: people.length,
    },
    // B_brutSalarii = (C3_13 − C3_14) + ΣA_11 + ΣB4_5: the employer's days of a work accident
    // are in the salary fund (OPANAF nr. 605/2026 anexa nr. 6, secțiunea B rd. 4).
    grossSalaries:
      sum(
        people.filter((person) => person.sickLeaveInsured),
        (person) => big(person.employment.cassBase),
      ) + sum(insured, (person) => person.sick?.accident.employer ?? 0n),
    // C1_11 = ΣA_13 + ΣB2_5 + ΣA_13S (p. 13); C1_12 = ΣB3_7 (p. 14).
    normalIncome: sum(
      insured,
      (person, index) =>
        (person.sick?.workBase ?? big(people[index]!.employment.casBase)) +
        big(people[index]!.employment.relief),
    ),
    sickLeaveBase: sum(insured, (person) => person.sick?.base ?? 0n),
    ...(leave ? { medicalLeave: leave } : {}),
    ...(insured.some((person) => person.sick?.accident.cases)
      ? {
          accidents: {
            cases: insured.reduce((total, person) => total + (person.sick?.accident.cases ?? 0), 0),
            days: insured.reduce((total, person) => total + (person.sick?.accident.days ?? 0), 0),
            total: sum(
              insured,
              (person) =>
                (person.sick?.accident.employer ?? 0n) + (person.sick?.accident.fund ?? 0n),
            ),
            fund: sum(insured, (person) => person.sick?.accident.fund ?? 0n),
          },
        }
      : {}),
    cam,
    controlSum: sum(obligations, (obligation) => obligation.payable),
  };
}

const flag = (value: boolean) => (value ? '1' : '0');
const text = (value: bigint | number) => value.toString();

/** YYYY-MM-DD as the structure's dd.mm.yyyy. */
function structureDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new DomainError('D112_DATE', `Data ${date} se scrie în forma AAAA-LL-ZZ.`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function fundCode(fund: string): string {
  const code = healthFundCode(fund);
  if (!code)
    throw new DomainError(
      'D112_HEALTH_FUND',
      `Casa de asigurări de sănătate ${fund} nu există în Nomenclatorul 2.`,
    );
  return code;
}

/**
 * Writes the declaration as one `declaratieUnica` element: the employer with its obligations
 * (angajatorA), counts (B), income in normal working conditions (C1), medical leave (C2) and CAM
 * (C4), then each insured person with section A, or B and D with medical leave, E1 or E2, and E3,
 * attributes in the XSD's order. Every field the structure computes is computed; the others are
 * the model's.
 */
export function writeD112(model: D112): string {
  const calculation = calculateD112(model);
  const { employer, declarant } = model;
  const office = employer.registeredOffice;
  const fiscal = employer.fiscalDomicile;
  return serializeXml(
    element(
      'declaratieUnica',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D112.xsd`,
        luna_r: String(model.period.month),
        an_r: String(model.period.year),
        d_rec: flag(model.correction),
        tip_rec: model.reason,
        nume_declar: declarant.lastName,
        prenume_declar: declarant.firstName,
        functie_declar: declarant.role,
      },
      element(
        'angajator',
        {
          cif: employer.cui,
          cifS: employer.successorCui,
          rgCom: employer.tradeRegister,
          caen: employer.caen,
          den: employer.name,
          adrSoc: office.address,
          telSoc: office.phone,
          faxSoc: office.fax,
          mailSoc: office.email,
          adrFisc: fiscal?.address,
          telFisc: fiscal?.phone,
          faxFisc: fiscal?.fax,
          mailFisc: fiscal?.email,
          casaAng: fundCode(employer.healthFund),
          datCAM: '1',
          totalPlata_A: text(calculation.controlSum),
        },
        calculation.obligations.map((obligation) =>
          element('angajatorA', {
            A_codOblig: obligation.code,
            A_codBugetar: obligation.budgetCode,
            A_datorat: text(obligation.owed),
            A_deductibil: text(obligation.deductible),
            A_scutit: text(obligation.exempt),
            A_plata: text(obligation.payable),
          }),
        ),
        element('angajatorB', {
          B_cnp: text(calculation.counts.unemployment),
          B_sanatate: text(calculation.counts.sickLeave),
          B_pensie: text(calculation.counts.pension),
          B_sal: text(calculation.counts.employees),
          B_brutSalarii: text(calculation.grossSalaries),
        }),
        // Special conditions and exemptions have no amounts here.
        element('angajatorC1', {
          C1_11: text(calculation.normalIncome),
          C1_12: text(calculation.sickLeaveBase),
          C1_13: '0',
          C1_21: '0',
          C1_22: '0',
          C1_23: '0',
          C1_31: '0',
          C1_32: '0',
          C1_33: '0',
          C1_T1: text(calculation.normalIncome),
          C1_T2: text(calculation.sickLeaveBase),
          C1_T: '0',
          C1_T3: '0',
          C1_5: '0',
          // C1_7: what the employer recovers from the pension houses, C3_suma.
          C1_7: calculation.accidents ? text(calculation.accidents.fund) : undefined,
        }),
        calculation.medicalLeave && medicalLeaveElement(calculation.medicalLeave),
        // angajatorC3 (p. 22–23): rd. 1, temporary incapacity after a work accident or an
        // occupational disease; the other rows (transfer, reduced time, courses) are not built.
        calculation.accidents &&
          element('angajatorC3', {
            C3_11: text(calculation.accidents.cases),
            C3_12: text(calculation.accidents.days),
            C3_13: text(calculation.accidents.total),
            C3_14: text(calculation.accidents.fund),
            C3_21: '0',
            C3_22: '0',
            C3_23: '0',
            C3_24: '0',
            C3_31: '0',
            C3_32: '0',
            C3_33: '0',
            C3_34: '0',
            C3_41: '0',
            C3_42: '0',
            C3_43: '0',
            C3_44: '0',
            C3_total: text(calculation.accidents.total),
            C3_suma: text(calculation.accidents.fund),
          }),
        element('angajatorC4', {
          C4_baza: text(calculation.cam.base),
          C4_ct: text(calculation.cam.amount),
        }),
      ),
      model.insured.map((insured, index) => insuredElement(insured, calculation.insured[index]!)),
    ),
  );
}

/** angajatorC2 (p. 15–22): every row, those of the other indemnity codes at zero. */
function medicalLeaveElement(leave: D112MedicalLeave) {
  const row = (prefix: string, values: D112MedicalLeaveRow) => ({
    [`${prefix}1`]: text(values.cases),
    [`${prefix}2`]: text(values.days),
    [`${prefix}3`]: text(values.employerDays),
    [`${prefix}4`]: text(values.fundDays),
    [`${prefix}5`]: text(values.employer),
    [`${prefix}6`]: text(values.fund),
  });
  const zero = (...names: string[]) => Object.fromEntries(names.map((name) => [name, '0']));
  const fund = (prefix: string, suffix: string, values: D112MedicalLeaveRow) => ({
    [`${prefix}1${suffix}`]: text(values.cases),
    [`${prefix}2${suffix}`]: text(values.days),
    [`${prefix}4${suffix}`]: text(values.fundDays),
    [`${prefix}6${suffix}`]: text(values.fund),
  });
  const recoverable = text(leave.recoverable);
  return element('angajatorC2', {
    ...row('C2_1', leave.incapacity),
    // Rd.1.1: infectious diseases with isolation (code 51).
    ...row('C2_11', leave.isolation),
    ...row('C2_12', leave.byPercent['55']),
    ...row('C2_13', leave.byPercent['65']),
    ...row('C2_14', leave.byPercent['75']),
    // Rd.1.5: the differences recalculated for continuations (D_20a, D_21a), none here.
    ...zero('C2_155', 'C2_156'),
    // Rd.2 and 2.2: prevention, of it quarantine. Rd.3–5: maternity, child and patient care,
    // maternal risk, borne by FNUASS alone: cases, days, FNUASS's days and amount.
    ...row('C2_2', leave.prevention),
    ...row('C2_21', leave.quarantine),
    ...fund('C2_3', '', leave.maternity),
    ...fund('C2_4', '', leave.childCare),
    ...fund('C2_4', 'a', leave.oncologyCare),
    ...fund('C2_5', '', leave.maternalRisk),
    // Rd.6–8: C2_T6 = C2_16 + C2_26 + C2_36 + C2_46 + C2_56 + C2_46a, to recover from FNUASS.
    C2_T6: recoverable,
    C2_10: recoverable,
    C2_140: recoverable,
  });
}

function insuredElement(insured: D112Insured, calculation: D112InsuredCalculation) {
  const { employment: work, income, minimum } = insured;
  const optional = (value: bigint | number) => (value ? text(value) : undefined);
  const main = income.mainJob;
  const contributions = text(calculation.contributions);
  const sick = calculation.sick;
  return element(
    'asigurat',
    {
      cnpAsig: insured.cnp,
      idAsig: String(calculation.id),
      numeAsig: insured.lastName,
      prenAsig: insured.firstName,
      dataAng: structureDate(insured.from),
      dataSf: insured.until === undefined ? undefined : structureDate(insured.until),
      casaSn: fundCode(insured.healthFund),
      asigCI: insured.sickLeaveInsured ? '1' : '2',
      asigSO: insured.unemploymentInsured ? '1' : '2',
      asigExc: minimum ? (minimum.kind === 'exempt' ? '1' : '2') : undefined,
      motivExc:
        minimum?.kind === 'exempt'
          ? String(minimumExemptions.indexOf(minimum.reason) + 1)
          : undefined,
      Timp_E3: text(calculation.tax),
    },
    sick
      ? sectionB(insured, calculation, sick)
      : element('asiguratA', {
          A_1: work.type,
          A_sal1: text(work.baseSalary),
          A_sal2: text(calculation.income - calculation.exemptIncome),
          A_2: flag(work.pensioner),
          A_3: work.contract,
          A_4: String(work.normHours),
          A_5: text(work.camBase),
          A_6: String(work.hoursWorked),
          A_7: String(work.hoursSuspended),
          A_8: String(work.daysWorked),
          A_9: text(work.unemploymentBase),
          A_11: text(work.cassBase),
          A_12: text(work.cass),
          A_13: text(work.casBase),
          A_14: text(work.cas),
          A_13P: text(calculation.limit.casBase),
          A_14P: text(calculation.limit.cas),
          A_11P: text(calculation.limit.cassBase),
          A_12P: text(calculation.limit.cass),
          A_14D: text(calculation.employer.cas),
          A_12D: text(calculation.employer.cass),
          A_13S: text(work.relief),
          A_13C: text(calculation.reliefIncome),
        }),
    sick &&
      (insured.sickLeave ?? []).map((certificate, index) =>
        certificateElement(certificate, sick.certificates[index]!),
      ),
    main
      ? element('asiguratE1', {
          E1_1: text(calculation.income),
          E1_2: contributions,
          E1_3: String(income.dependents),
          E1_4: text(calculation.deduction.total),
          E1_41: text(income.deduction.basic),
          E1_42: text(calculation.deduction.supplementary),
          E1_421: text(income.deduction.young),
          E1_422: text(income.deduction.children),
          E1_5: text(income.otherDeductions),
          E1_6: text(income.taxBase),
          E1_7: text(income.tax),
        })
      : element('asiguratE2', {
          E2_1: text(calculation.income),
          E2_2: contributions,
          E2_3: text(income.taxBase),
          E2_4: text(income.tax),
        }),
    element('asiguratE3', {
      E3_1: sick ? 'B' : 'A',
      E3_2: work.type,
      E3_3: main ? '1' : '2',
      E3_4: 'P',
      E3_8: text(calculation.income),
      E3_60: optional(calculation.benefits),
      E3_10: optional(income.mealVouchers),
      E3_75: optional(income.holidayVouchers),
      E3_58: optional(income.benefits?.E3_58 ?? 0),
      E3_44: optional(income.benefits?.E3_44 ?? 0),
      E3_69: optional(calculation.exemptIncome),
      E3_86: optional(income.benefits?.E3_86 ?? 0),
      E3_90: optional(calculation.capped),
      E3_71: optional(income.benefits?.E3_71 ?? 0),
      E3_78: optional(income.benefits?.E3_78 ?? 0),
      E3_9: contributions,
      E3_19: '0',
      E3_11: String(income.dependents),
      E3_12: text(calculation.deduction.total),
      E3_121: text(income.deduction.basic),
      E3_122: text(calculation.deduction.supplementary),
      E3_1221: text(income.deduction.young),
      E3_1222: text(income.deduction.children),
      E3_13: text(income.otherDeductions),
      E3_14: text(income.taxBase),
      E3_15: text(income.tax),
      E3_16: text(income.paid),
    }),
  );
}

/** asiguratB1–B4 (p. 42–51) of one contract in normal working conditions with medical leave:
 * the days worked and their CAS base in B2, the indemnities' days and CAS base in B3. */
function sectionB(
  insured: D112Insured,
  calculation: D112InsuredCalculation,
  sick: D112SickCalculation,
) {
  const work = insured.employment;
  const relief = big(work.relief);
  const days = String(work.daysWorked);
  // The validator asks the totals with the relief (B2_5C, B3_7C, B4_7C) of every type 51.
  const withRelief = (value: bigint) => text(work.type === '51' ? value : 0n);
  return [
    // B1 (p. 42–45): the contract, as section A's.
    element('asiguratB1', {
      B1_1: work.type,
      B1_sal1: text(work.baseSalary),
      B1_sal2: text(calculation.income - calculation.exemptIncome),
      B1_2: flag(work.pensioner),
      B1_3: work.contract,
      B1_4: String(work.normHours),
      B1_5: text(work.camBase),
      B1_6: String(work.hoursWorked),
      B1_7: String(work.hoursSuspended),
      // B1_8, B1_9, B1_16, B1_17: technical unemployment and sports indemnities (types 31, 42).
      B1_8: '0',
      B1_9: '0',
      B1_10: text(work.unemploymentBase),
      B1_15: days,
      B1_16: '0',
      B1_17: '0',
    }),
    // B2 (p. 45–46): B4_1 = B2_2 and B4_7 = B2_5 + B3_7. B2_1, the indicator of special or
    // particular conditions, is left out for normal ones.
    element('asiguratB2', {
      B2_2: days,
      B2_3: '0',
      B2_4: '0',
      B2_5: text(sick.workBase),
      B2_6: '0',
      B2_7: '0',
      B2_5P: text(calculation.limit.casBase),
      B2_6P: '0',
      B2_7P: '0',
      B2_5S: text(relief),
      B2_5C: withRelief(sick.workBase + relief),
      B2_6S: '0',
      B2_6C: '0',
      B2_7S: '0',
      B2_7C: '0',
    }),
    // B3 (p. 46–48): B3_1 = B3_6 = ΣD_16, B3_7 = B3_12 + B3_13. B3_4, B3_8–B3_11: work
    // accidents; B3_5: unpaid childcare leave; B3_7D: last month's recalculated difference, none.
    // A work accident: B3_8 its working days (B3_1 = B3_6 + B3_8), B3_4 and B3_9 the state
    // budget's days and amount, B3_10 the employer's, B3_11 their sum.
    element('asiguratB3', {
      B3_1: String(sick.days + sick.accident.days),
      B3_2: '0',
      B3_3: '0',
      B3_4: String(sick.accident.fundDays),
      B3_5: '0',
      B3_6: String(sick.days),
      B3_7: text(sick.base),
      B3_7D: '0',
      B3_7S: '0',
      B3_7C: withRelief(sick.base),
      B3_8: String(sick.accident.days),
      B3_9: text(sick.accident.fund),
      B3_10: text(sick.accident.employer),
      B3_11: text(sick.accident.employer + sick.accident.fund),
      B3_12: text(sick.employer),
      B3_13: text(sick.fund),
    }),
    // B4 (p. 48–51): the totals, as section A's; the limit sums of art. 146 alin. (5^6).
    element('asiguratB4', {
      B4_1: days,
      B4_2: '0',
      B4_3: text(work.unemploymentBase),
      B4_5: text(work.cassBase),
      B4_6: text(work.cass),
      B4_7: text(work.casBase),
      B4_8: text(work.cas),
      B4_7P: text(calculation.limit.casBase),
      B4_8P: text(calculation.limit.cas),
      B4_18: '0',
      B4_20: '0',
      B4_5P: text(calculation.limit.cassBase),
      B4_6P: text(calculation.limit.cass),
      B4_7S: text(relief),
      B4_7C: withRelief(big(work.casBase) + relief),
      B4_8D: text(calculation.employer.cas),
      B4_6D: text(calculation.employer.cass),
      B4_14: text(work.camBase),
    }),
  ];
}

/** Bani as lei with two decimals. */
const decimal = (bani: bigint) => `${bani / 100n}.${String(bani % 100n).padStart(2, '0')}`;

/** asiguratD (p. 56–62) of one code 01 certificate. */
function certificateElement(
  certificate: D112SickCertificate,
  calculation: D112CertificateCalculation,
) {
  const { continues } = certificate;
  return element('asiguratD', {
    Data_CMI: continues && structureDate(continues.initialFrom),
    D_1: certificate.series,
    D_2: certificate.number,
    D_3: continues?.series,
    D_4: continues?.number,
    D_5: structureDate(certificate.issued),
    D_6: structureDate(certificate.from),
    D_7: structureDate(certificate.to),
    D_8: certificate.code === '09' || certificate.code === '91' ? certificate.careCnp : undefined,
    D_8a: certificate.code === '17' ? certificate.careCnp : undefined,
    D_9: certificate.code,
    // D_9a, patients of the national health programmes, is not known to the payroll.
    D_9b: flag(certificate.unpaidDays > 0),
    D_10: String(d112PrescriptionPlaces.indexOf(certificate.place) + 1),
    D_11: certificate.code === '06' ? certificate.urgencyCode : undefined,
    D_12:
      certificate.code === '05' || certificate.code === '51'
        ? certificate.infectiousCode
        : undefined,
    D_14a: String(calculation.employerDays),
    D_14: String(certificate.employerDays),
    D_15a: String(certificate.fundDays),
    D_15: String(certificate.fundDays),
    D_16a: String(calculation.days),
    D_16: String(calculation.paidDays),
    D_17: text(certificate.base.income),
    D_18: String(certificate.base.days),
    D_19: decimal(calculation.dailyAverage),
    D_20: text(certificate.employer),
    // D_20a, D_21a: required for a continuation of code 01, the recalculated difference.
    D_20a: continues && certificate.code === '01' ? '0' : undefined,
    D_21: text(certificate.fund),
    D_21a: continues && certificate.code === '01' ? '0' : undefined,
    // D_23 (p. 61): RM for maternal risk.
    D_23: certificate.code === '15' ? 'RM' : certificate.diagnosis,
    D_28: certificate.code === '01' ? (certificate.percent ?? undefined) : undefined,
  });
}

export type D112Check = {
  code: string;
  /** error: ANAF rejects the declaration (E:) or the structure forbids the value; warning: it is
   * accepted, with a notice (A:) or with a value the structure's own formula would not give. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
  /** About sick leave or a work accident (section D, the medical-leave checks): it names a
   * certificate or quotes its codes, health data the engine shows only to who may read it. */
  health?: true;
};

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);

/** The birth month within a CNP, for Romanian citizens (sex digits 1–6). */
function cnpBirth(cnp: string): { year: number; month: number } | undefined {
  const century = { '1': 1900, '2': 1900, '3': 1800, '4': 1800, '5': 2000, '6': 2000 }[cnp[0]!];
  if (century === undefined) return undefined;
  return { year: century + Number(cnp.slice(1, 3)), month: Number(cnp.slice(3, 5)) };
}

/** The last day of a month, YYYY-MM-DD. */
function lastDayOf({ year, month }: D112['period']): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${day}`;
}

function isDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Fast feedback on the structure's validations for the sections written here, as ANAF's
 * validator applies them, in Romanian. The official validator (DUKIntegrator) remains the oracle;
 * it also checks the CAEN list.
 */
export function checkD112(model: D112): D112Check[] {
  const checks: D112Check[] = [];
  const add = (
    severity: D112Check['severity'],
    code: string,
    path: string,
    message: string,
    health = false,
  ) =>
    checks.push({
      code,
      severity,
      path,
      message,
      // A certificate's own checks, its fields' and every medical-leave code's.
      ...(health || code.startsWith('D112_SICK') || /\.sickLeave\b/.test(path)
        ? { health: true as const }
        : {}),
    });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const warning = (code: string, path: string, message: string) =>
    add('warning', code, path, message);
  const textField = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D112_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D112_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { period, declarant, employer } = model;
  const structure = structureOf(period);
  const validPeriod = structure !== undefined;
  if (!structure) error('D112_PERIOD', 'period', periodMessage);
  else if (
    model.parameters &&
    (BigInt(model.parameters.minimumWage) !== structure.minimumWage ||
      BigInt(model.parameters.relief) !== structure.relief)
  )
    error(
      'D112_PARAMETERS',
      'parameters',
      `Salariul minim (${model.parameters.minimumWage} lei) și suma neimpozabilă (${model.parameters.relief} lei) din registrul de reguli diferă de cele ale structurii ANAF pentru ${structure.label} (${structure.minimumWage} lei, ${structure.relief} lei).`,
    );
  if (
    structure &&
    !structure.sickLeave &&
    model.insured.some((insured) => insured.sickLeave?.length || insured.accidents?.cases)
  )
    add(
      'error',
      'D112_SICK_PERIOD',
      'insured',
      `Concediile medicale și accidentele de muncă din ${structure.label} nu sunt acoperite: câmpurile lor în structura acelor luni nu se scriu.`,
      true,
    );

  // d_rec and tip_rec.
  if (model.reason !== undefined) {
    if (!d112Reasons.some(([reason]) => reason === model.reason))
      error('D112_REASON', 'reason', `Tipul declarației ${model.reason} nu există.`);
    else if (model.reason === '7')
      error(
        'D112_REASON',
        'reason',
        'Tipul 7 de declarație se depune doar de AJOFM, CNAS, CNPP sau ANPIS.',
      );
    else if (!model.correction && !['3', '5'].includes(model.reason))
      error(
        'D112_REASON',
        'reason',
        `Tipul ${model.reason} de declarație se depune doar ca declarație rectificativă.`,
      );
  }

  textField('declarant.lastName', declarant.lastName, 'numele declarantului', 75, true);
  textField('declarant.firstName', declarant.firstName, 'prenumele declarantului', 75, true);
  textField('declarant.role', declarant.role, 'funcția declarantului', 50, true);

  if (!isCui(employer.cui))
    error(
      'D112_CUI',
      'employer.cui',
      'Codul de identificare fiscală nu este valid; se scrie fără prefixul RO.',
    );
  if (employer.successorCui !== undefined && !isCui(employer.successorCui))
    error(
      'D112_CUI',
      'employer.successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );
  textField('employer.tradeRegister', employer.tradeRegister, 'numărul de înmatriculare', 14);
  if (!/^\d{4}$/.test(employer.caen))
    error('D112_CAEN', 'employer.caen', 'Codul CAEN are patru cifre.');
  textField('employer.name', employer.name, 'denumirea', 200, true);
  for (const [group, place, required] of [
    ['registeredOffice', 'sediului social', true],
    ['fiscalDomicile', 'domiciliului fiscal', false],
  ] as const) {
    const contact = employer[group];
    textField(`employer.${group}.address`, contact?.address, `adresa ${place}`, 1000, required);
    textField(`employer.${group}.phone`, contact?.phone, `telefonul ${place}`, 15);
    textField(`employer.${group}.fax`, contact?.fax, `faxul ${place}`, 15);
    textField(`employer.${group}.email`, contact?.email, `e-mailul ${place}`, 200);
    if (contact?.email?.trim() && !isEmail(contact.email))
      warning('D112_EMAIL', `employer.${group}.email`, `E-mailul ${place} nu este valid.`);
  }
  if (employer.healthFund === 'OPSNAJ' || !healthFundCode(employer.healthFund))
    error(
      'D112_HEALTH_FUND',
      'employer.healthFund',
      'Casa de sănătate a angajatorului este casa județeană sau a municipiului București.',
    );

  if (model.insured.length === 0)
    error(
      'D112_INSURED',
      'insured',
      'Declarația se depune aici pentru cel puțin un salariat; fără asigurați, perioada de asigurare la sănătate se încheie.',
    );

  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);
  const invalid = new Set(problems.map((problem) => problem.path.split('.').slice(0, 2).join('.')));

  const workingDays = structure ? structure.workingDays[period.month]! : undefined;
  const lastDay = validPeriod ? lastDayOf(period) : undefined;
  const seen = new Set<string>();
  const certificates = new Set<string>();
  model.insured.forEach((insured, index) => {
    const path = `insured.${index}`;
    const { employment: work, income, minimum } = insured;
    if (!/^[1-9]\d{12}$/.test(insured.cnp) || !isValidCnp(insured.cnp))
      error('D112_CNP', `${path}.cnp`, 'CNP-ul asiguratului nu este valid.');
    else {
      if (seen.has(insured.cnp))
        error('D112_CNP', `${path}.cnp`, 'Un asigurat se declară o singură dată (CNP unic).');
      seen.add(insured.cnp);
      const birth = cnpBirth(insured.cnp);
      if (birth && validPeriod) {
        const months =
          periodIndex(period.year, period.month) - periodIndex(birth.year, birth.month);
        if (months < 15 * 12)
          error('D112_CNP', `${path}.cnp`, 'Asiguratul trebuie să aibă cel puțin 15 ani.');
      }
    }
    textField(`${path}.lastName`, insured.lastName, 'numele asiguratului', 75, true);
    textField(`${path}.firstName`, insured.firstName, 'prenumele asiguratului', 75, true);
    if (!isDate(insured.from))
      error('D112_DATE', `${path}.from`, 'Data intrării în categoria de asigurat nu este validă.');
    else if (lastDay && insured.from > lastDay)
      error(
        'D112_DATE',
        `${path}.from`,
        'Data intrării în categoria de asigurat este după luna de raportare.',
      );
    if (insured.until !== undefined) {
      if (!isDate(insured.until))
        error(
          'D112_DATE',
          `${path}.until`,
          'Data ieșirii din categoria de asigurat nu este validă.',
        );
      else if (insured.until < insured.from)
        error('D112_DATE', `${path}.until`, 'Data ieșirii nu poate fi înaintea datei intrării.');
      else if (lastDay && insured.until > lastDay)
        error('D112_DATE', `${path}.until`, 'Data ieșirii nu poate fi după luna de raportare.');
    }
    if (!healthFundCode(insured.healthFund))
      error(
        'D112_HEALTH_FUND',
        `${path}.healthFund`,
        `Casa de asigurări de sănătate ${insured.healthFund} nu există în Nomenclatorul 2.`,
      );
    if (invalid.has(`insured.${index}`) || workingDays === undefined) return;

    const at = `${path}.employment`;
    const hours = contractHours(work.contract, work.normHours);
    const fullDays = workingDays * hours;
    const ajs = insured.unemploymentInsured && !work.pensioner;
    if (work.contract !== 'N' && hours >= work.normHours)
      error(
        'D112_CONTRACT',
        `${at}.contract`,
        'Timpul parțial are mai puține ore decât norma zilnică.',
      );
    if (work.type === '51' && work.contract !== 'N')
      error(
        'D112_TYPE',
        `${at}.type`,
        'Tipul 51 se declară doar pentru contracte cu normă întreagă.',
      );
    if (work.hoursWorked > fullDays)
      error(
        'D112_HOURS',
        `${at}.hoursWorked`,
        `Orele lucrate depășesc ${fullDays}, zilele lucrătoare ale lunii înmulțite cu orele contractului.`,
      );
    else if (work.hoursWorked + work.hoursSuspended > fullDays)
      error(
        'D112_HOURS',
        `${at}.hoursSuspended`,
        `Orele lucrate și cele suspendate depășesc ${fullDays}.`,
      );
    if (work.daysWorked > workingDays)
      error(
        'D112_DAYS',
        `${at}.daysWorked`,
        `Zilele lucrate depășesc cele ${workingDays} zile lucrătoare ale lunii.`,
      );
    if (ajs && work.hoursWorked + work.hoursSuspended === 0)
      error(
        'D112_HOURS',
        `${at}.hoursWorked`,
        'Pentru un asigurat la șomaj se declară ore lucrate sau suspendate.',
      );
    if (!ajs && work.unemploymentBase > 0)
      error(
        'D112_UNEMPLOYMENT',
        `${at}.unemploymentBase`,
        'Baza indemnizației de șomaj se completează doar pentru asigurații la șomaj care nu sunt pensionari.',
      );
    if (ajs && work.hoursWorked > 0 && work.unemploymentBase === 0)
      warning(
        'D112_UNEMPLOYMENT',
        `${at}.unemploymentBase`,
        'Pentru orele lucrate se completează baza indemnizației de șomaj.',
      );
    if (ajs && work.unemploymentBase > 0 && work.hoursWorked === 0)
      warning(
        'D112_UNEMPLOYMENT',
        `${at}.hoursWorked`,
        'Cu bază a indemnizației de șomaj se declară ore lucrate.',
      );
    if (work.baseSalary === 0 && income.cash + income.mealVouchers + income.holidayVouchers === 0)
      warning(
        'D112_SALARY',
        `${at}.baseSalary`,
        'Salariul de bază și venitul brut nu pot fi amândouă zero.',
      );

    if (work.daysWorked > 0 && work.casBase === 0)
      error('D112_CAS', `${at}.casBase`, 'Pentru zilele lucrate se declară baza CAS.');
    if (work.casBase > 0 && work.daysWorked === 0)
      warning('D112_DAYS', `${at}.daysWorked`, 'Cu bază CAS se declară zilele lucrate.');
    if (work.daysWorked > 0 && work.cassBase === 0)
      warning('D112_CASS', `${at}.cassBase`, 'Pentru zilele lucrate se declară baza CASS.');
    if (work.daysWorked > 0 && work.camBase === 0)
      warning('D112_CAM', `${at}.camBase`, 'Pentru zilele lucrate se declară baza CAM.');
    if (work.casBase > work.cassBase)
      warning('D112_CAS', `${at}.casBase`, 'Baza CAS depășește baza CASS.');
    const cas = contribution(big(work.casBase), casRate);
    if (big(work.cas) < cas - 2n || big(work.cas) > cas + 2n)
      error(
        'D112_CAS',
        `${at}.cas`,
        `CAS (${work.cas}) diferă de 25% din bază (${cas}) cu mai mult de 2 lei.`,
      );
    const cass = contribution(big(work.cassBase), cassRate);
    if (big(work.cass) < cass - 1n || big(work.cass) > cass + 2n)
      error('D112_CASS', `${at}.cass`, `CASS (${work.cass}) diferă de 10% din bază (${cass}).`);

    if (work.relief > 0 && work.type !== '51')
      error(
        'D112_RELIEF',
        `${at}.relief`,
        'Suma neimpozabilă din salariul minim se declară doar pentru tipul 51.',
      );
    else if (big(work.relief) > structure!.relief)
      warning(
        'D112_RELIEF',
        `${at}.relief`,
        `Suma neimpozabilă este de cel mult ${structure!.relief} lei în ${structure!.label} (${structure!.reliefText}).`,
      );

    // asigExc, motivExc and the limit sums (S9c1.1, SP1A.3, SP3A).
    const limit = structureLimit(structure!, work.daysWorked, workingDays);
    const formula = `(${structure!.minimumWage} − ${structure!.relief}) lei × ${work.daysWorked} / ${workingDays} zile`;
    if (
      !minimum &&
      work.contract !== 'N' &&
      work.casBase > 0 &&
      big(work.casBase) < limit.floor - 3n
    )
      error(
        'D112_MINIMUM',
        `${path}.minimum`,
        `Baza CAS (${work.casBase}) a contractului cu timp parțial este sub ${limit.floor} lei; se declară dacă salariatul este exceptat sau nu de la contribuția minimă.`,
      );
    if (minimum?.kind === 'due') {
      const base = big(minimum.base);
      if (work.casBase === 0 || big(work.casBase) >= base)
        error(
          'D112_MINIMUM',
          `${path}.minimum.base`,
          'Neexceptarea se declară doar pentru o bază CAS sub suma limită.',
        );
      else if (base < limit.floor - 1n)
        error(
          'D112_MINIMUM',
          `${path}.minimum.base`,
          `Suma limită (${minimum.base}) este sub ${formula} = ${limit.floor} lei.`,
        );
      else if (base !== limit.rounded)
        warning(
          'D112_MINIMUM_BASE',
          `${path}.minimum.base`,
          `Structura ANAF calculează suma limită ca ${formula} = ${limit.rounded} lei, nu ${minimum.base}; validatorul acceptă orice sumă de cel puțin ${limit.floor - 1n} lei.`,
        );
    }

    const tax = `${path}.income`;
    if (work.type === '51' && !income.mainJob)
      error('D112_MAIN_JOB', `${tax}.mainJob`, 'Tipul 51 se declară doar la funcția de bază.');
    if (!income.mainJob) {
      const { basic, young, children } = income.deduction;
      if (income.dependents || basic || young || children || income.otherDeductions)
        error(
          'D112_MAIN_JOB',
          `${tax}.deduction`,
          'Persoanele în întreținere, deducerile personale și celelalte deduceri se completează doar la funcția de bază.',
        );
    }
    if (income.tax > income.taxBase)
      error('D112_TAX', `${tax}.tax`, 'Impozitul nu poate depăși baza de calcul.');
    if (income.taxBase > income.cash + income.mealVouchers + income.holidayVouchers)
      warning('D112_TAX', `${tax}.taxBase`, 'Baza de calcul a impozitului depășește venitul brut.');

    if (insured.sickLeave?.length)
      sickLeaveChecks(
        insured,
        path,
        { period, workingDays, certificates, minimumWage: structure!.minimumWage },
        (severity, code, at, message) => add(severity, code, at, message, true),
      );
  });

  if (problems.length || !validPeriod || model.insured.length === 0) return checks;
  const calculation = calculateD112(model);
  const totals = [
    calculation.controlSum,
    calculation.cam.base,
    calculation.grossSalaries,
    calculation.normalIncome,
    ...calculation.obligations.map((obligation) => obligation.owed),
  ];
  if (totals.some((value) => value > maxAmount))
    error('D112_TOTAL', 'insured', 'Un total al declarației depășește 15 cifre.');
  return checks;
}

/** D_17's ceiling for an initial certificate: 12 minimum wages of the reporting month for each of
 * the six months of the base (p. 4, the validator's S106 on 12 × 6 × 4325 in 07–12/2026). */
const sickBaseCeiling = (minimumWage: bigint) => 12n * 6n * minimumWage;

/** The percentage of C2's rows for a certificate of `days` calendar days (p. 16–20). */
const tierOf = (days: number): D112SickPercent => (days <= 7 ? '55' : days <= 14 ? '65' : '75');

const calendarDays = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * The medical-leave checks of one insured person: section D (p. 56–62) as the validator applies
 * it, the days and bases section B derives from it, and what this module does not declare yet.
 */
function sickLeaveChecks(
  insured: D112Insured,
  path: string,
  context: {
    period: D112['period'];
    workingDays: number;
    certificates: Set<string>;
    minimumWage: bigint;
  },
  add: (severity: D112Check['severity'], code: string, path: string, message: string) => void,
) {
  const error = (code: string, at: string, message: string) => add('error', code, at, message);
  const warning = (code: string, at: string, message: string) => add('warning', code, at, message);
  const work = insured.employment;
  const certificates = insured.sickLeave ?? [];
  const month = `${context.period.year}-${String(context.period.month).padStart(2, '0')}`;
  if (certificates.length > 10)
    error(
      'D112_SICK_CERTIFICATE',
      `${path}.sickLeave`,
      'Se declară cel mult 10 certificate de concediu medical pe asigurat.',
    );
  if (work.type === '51' || work.relief > 0)
    error(
      'D112_SICK_RELIEF',
      `${path}.employment.relief`,
      'Într-o lună cu concediu medical, împărțirea sumei neimpozabile din salariul minim între zilele lucrate (B2_5S) și indemnizații (B3_7S) nu este stabilită: declarați salariatul cu expertul contabil.',
    );
  if (insured.minimum?.kind === 'due')
    error(
      'D112_SICK_MINIMUM',
      `${path}.minimum`,
      'Cu concediu medical, structura ANAF scade din diferența până la contribuția minimă și CAS-ul indemnizației (B4_8D = B4_8P − B4_8), statul de plată doar CAS-ul zilelor lucrate: stabiliți diferența cu expertul contabil.',
    );
  const paid = certificates.reduce((days, item) => days + item.employerDays + item.fundDays, 0);
  if (work.daysWorked + paid > context.workingDays)
    error(
      'D112_DAYS',
      `${path}.employment.daysWorked`,
      `Zilele lucrate și cele de concediu medical plătite depășesc cele ${context.workingDays} zile lucrătoare ale lunii.`,
    );

  certificates.forEach((certificate, index) => {
    const at = `${path}.sickLeave.${index}`;
    const { continues } = certificate;
    if (!(d112SickCodes as readonly string[]).includes(certificate.code))
      error(
        'D112_SICK_CODE',
        `${at}.code`,
        `Concediul medical cu codul de indemnizație ${certificate.code} nu este declarat de aplicație.`,
      );
    if (
      fundOnlyCodes.includes(certificate.code) &&
      (certificate.employer || certificate.employerDays)
    )
      error(
        'D112_SICK_PAYER',
        `${at}.employer`,
        `Indemnizația cu codul ${certificate.code} se suportă doar din FNUASS (D_20 = 0).`,
      );
    const careCnp = ['09', '91', '17'].includes(certificate.code);
    if (careCnp && (!certificate.careCnp || !isValidCnp(certificate.careCnp)))
      error(
        'D112_SICK_CARE',
        `${at}.careCnp`,
        `Pentru codul ${certificate.code} se completează CNP-ul ${certificate.code === '17' ? 'pacientului' : 'copilului'} pentru care s-a acordat certificatul (D_8, D_8a).`,
      );
    if (certificate.code === '06' && !certificate.urgencyCode)
      error(
        'D112_SICK_URGENCY',
        `${at}.urgencyCode`,
        'Pentru codul 06 se completează codul urgenței medico-chirurgicale (D_11).',
      );
    if (['05', '51'].includes(certificate.code) && !certificate.infectiousCode)
      error(
        'D112_SICK_INFECTIOUS',
        `${at}.infectiousCode`,
        `Pentru codul ${certificate.code} se completează codul bolii infectocontagioase (D_12).`,
      );
    for (const [key, value, label, max] of [
      ['series', certificate.series, 'seria certificatului', 5],
      ['number', certificate.number, 'numărul certificatului', 10],
      ['diagnosis', certificate.diagnosis, 'codul de diagnostic', 3],
      ['continues.series', continues?.series, 'seria certificatului continuat', 5],
      ['continues.number', continues?.number, 'numărul certificatului continuat', 10],
    ] as const) {
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > max)
        error('D112_TEXT', `${at}.${key}`, `Completați ${label}, de cel mult ${max} caractere.`);
    }
    const key = `${certificate.series}/${certificate.number}`;
    if (context.certificates.has(key))
      error(
        'D112_SICK_CERTIFICATE',
        at,
        `Certificatul ${certificate.series} ${certificate.number} se declară o singură dată.`,
      );
    context.certificates.add(key);
    if (continues && `${continues.series}/${continues.number}` === key)
      error('D112_SICK_CERTIFICATE', `${at}.continues`, 'Un certificat nu se continuă pe sine.');

    const dates = [certificate.issued, certificate.from, certificate.to, continues?.initialFrom];
    if (!dates.every((date) => date === undefined || isDate(date))) {
      error('D112_DATE', at, 'Datele certificatului se scriu în forma AAAA-LL-ZZ.');
      return;
    }
    if (
      !certificate.from.startsWith(month) ||
      !certificate.to.startsWith(month) ||
      certificate.to < certificate.from
    ) {
      error(
        'D112_SICK_DATES',
        at,
        `Certificatul se declară în luna zilelor lui: prima și ultima zi sunt în ${month}.`,
      );
      return;
    }
    const length = calendarDays(certificate.from, certificate.to);
    if (continues) {
      if (continues.initialFrom! >= certificate.from)
        error(
          'D112_SICK_DATES',
          `${at}.continues.initialFrom`,
          'Episodul începe înaintea certificatului care îl continuă.',
        );
      if (certificate.unpaidDays)
        error(
          'D112_SICK_DAYS',
          `${at}.unpaidDays`,
          'Un certificat în continuare nu mai pierde nicio zi: se diminuează o singură zi pe episod (OUG nr. 91/2025).',
        );
    } else {
      if (certificate.issued < certificate.from)
        error(
          'D112_SICK_DATES',
          `${at}.issued`,
          'Un certificat inițial nu se acordă înainte de prima lui zi.',
        );
      else if (
        calendarDays(certificate.from, certificate.issued) > 2 &&
        certificate.place !== 'hospital' &&
        certificate.place !== 'cas'
      )
        warning(
          'D112_SICK_DATES',
          `${at}.issued`,
          'Un certificat inițial se acordă în prima lui zi sau a doua zi, în afara excepțiilor structurii (internare, aviz al medicului expert).',
        );
      if (certificate.code === '01' && certificate.percent !== tierOf(length))
        warning(
          'D112_SICK_PERCENT',
          `${at}.percent`,
          `Structura ANAF încadrează un certificat de ${length} zile la ${tierOf(length)}%, nu la ${certificate.percent}%.`,
        );
    }
    if (certificate.code === '01' && certificate.place === 'family_doctor' && length > 10)
      error(
        'D112_SICK_DATES',
        `${at}.to`,
        'Medicul de familie acordă pentru boală obișnuită un certificat de cel mult 10 zile calendaristice.',
      );

    const days = workingDaysBetween(certificate.from as LocalDate, certificate.to as LocalDate);
    const declared = certificate.unpaidDays + certificate.employerDays + certificate.fundDays;
    if (declared !== days.length)
      error(
        'D112_SICK_DAYS',
        at,
        `Certificatul are ${days.length} zile lucrătoare, nu ${declared} (neplătite, ale angajatorului și ale FNUASS).`,
      );
    if (certificate.unpaidDays > 1)
      error(
        'D112_SICK_DAYS',
        `${at}.unpaidDays`,
        'Se diminuează cel mult o zi lucrătoare pe episod (OUG nr. 91/2025).',
      );
    if (certificate.employerDays > 5)
      error(
        'D112_SICK_DAYS',
        `${at}.employerDays`,
        'Angajatorul plătește cel mult 5 zile lucrătoare de concediu medical (D_14).',
      );
    if (certificate.unpaidDays && certificate.place === 'hospital')
      warning(
        'D112_SICK_UNPAID',
        `${at}.unpaidDays`,
        'Structura ANAF scutește de diminuare certificatele prescrise de spital (D_10 = 2), OUG nr. 91/2025 doar perioadele de spitalizare: confirmați ziua neplătită cu expertul contabil.',
      );

    const { income, days: baseDays } = certificate.base;
    if (baseDays > 132)
      error(
        'D112_SICK_BASE',
        `${at}.base.days`,
        'Baza de calcul are cel mult 132 de zile lucrătoare, ale celor 6 luni.',
      );
    if (income > 0 !== baseDays > 0)
      error(
        'D112_SICK_BASE',
        `${at}.base`,
        'Veniturile și zilele bazei de calcul sunt amândouă zero sau amândouă pozitive.',
      );
    if (!continues && big(income) > sickBaseCeiling(context.minimumWage))
      error(
        'D112_SICK_BASE',
        `${at}.base.income`,
        `Veniturile bazei de calcul (${income} lei) depășesc 12 salarii minime pe 6 luni, ${sickBaseCeiling(context.minimumWage)} lei.`,
      );
    if (certificate.employer > 0 && certificate.employerDays === 0)
      error(
        'D112_SICK_AMOUNT',
        `${at}.employer`,
        'Indemnizația suportată de angajator cere zile plătite de angajator.',
      );
    if (certificate.fund > 0 && certificate.fundDays === 0)
      error(
        'D112_SICK_AMOUNT',
        `${at}.fund`,
        'Indemnizația suportată din FNUASS cere zile plătite din FNUASS.',
      );
  });
}
