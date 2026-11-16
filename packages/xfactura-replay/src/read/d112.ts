import { fieldMap, type FiledDeclaration } from 'xfactura-core/ro/declarations/read';
import { pathCounts, personKey, type PathCount } from './person-key';

/**
 * Source: core's declarations/d112.ts, insuredElement, sectionB, certificateElement and
 * writeD112/medicalLeaveElement, checked against ANAF's 30.03.2026 and 07.09.2026 v7
 * structures (field labels, not inferred tax treatment). Scope is reporting months 01–12/2026.
 * See README's field-name review and primary sources. Null explicitly
 * carries a writer field whose meaning is not established by that writer (usually a zero).
 * No neutral meaning is inferred from a field's value or its spelling on a filed return.
 */
export const d112FieldNames: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  asigurat: {
    Timp_E3: 'incomeTaxTotal',
    Tcota_E4: 'redirectedIncomeTaxPercent',
    Tsuma_E4: 'redirectedIncomeTaxAmount',
  },
  asiguratA: {
    A_sal1: 'baseSalary',
    A_sal2: 'grossContractPay',
    A_5: 'employerContributionBase',
    A_6: 'hoursWorked',
    A_7: 'hoursSuspended',
    A_8: 'daysWorked',
    A_9: 'unemploymentBase',
    A_11: 'cassBase',
    A_12: 'cass',
    A_13: 'casBase',
    A_14: 'cas',
    A_13P: 'minimumCasBase',
    A_14P: 'minimumCas',
    A_11P: 'minimumCassBase',
    A_12P: 'minimumCass',
    A_14D: 'employerCasDifference',
    A_12D: 'employerCassDifference',
    A_13S: 'minimumWageRelief',
    A_13C: 'casBaseWithRelief',
  },
  asiguratB1: {
    B1_sal1: 'baseSalary',
    B1_sal2: 'grossContractPay',
    B1_5: 'employerContributionBase',
    B1_6: 'hoursWorked',
    B1_7: 'hoursSuspended',
    B1_8: null,
    B1_9: null,
    B1_10: 'unemploymentBase',
    B1_15: 'daysWorked',
    B1_16: null,
    B1_17: null,
  },
  asiguratB2: {
    B2_2: 'daysWorked',
    B2_3: null,
    B2_4: null,
    B2_5: 'workedCasBase',
    B2_6: null,
    B2_7: null,
    B2_5P: 'minimumCasBase',
    B2_6P: null,
    B2_7P: null,
    B2_5S: 'minimumWageRelief',
    B2_5C: 'workedCasBaseWithRelief',
    B2_6S: null,
    B2_6C: null,
    B2_7S: null,
    B2_7C: null,
  },
  asiguratB3: {
    B3_1: 'indemnityDays',
    B3_2: null,
    B3_3: null,
    B3_4: 'accidentFundDays',
    B3_5: 'unpaidChildcareDays',
    B3_6: 'medicalLeaveDays',
    B3_7: 'medicalLeaveCasBase',
    B3_7D: 'medicalLeaveRecalculatedDifference',
    B3_7S: 'medicalLeaveRelief',
    B3_7C: 'medicalLeaveCasBaseWithRelief',
    B3_8: 'accidentDays',
    B3_9: 'accidentFundAmount',
    B3_10: 'accidentEmployerAmount',
    B3_11: 'accidentAmount',
    B3_12: 'medicalLeaveEmployerAmount',
    B3_13: 'medicalLeaveFundAmount',
  },
  asiguratB4: {
    B4_1: 'daysWorked',
    B4_2: null,
    B4_3: 'unemploymentBase',
    B4_5: 'cassBase',
    B4_6: 'cass',
    B4_7: 'casBase',
    B4_8: 'cas',
    B4_7P: 'minimumCasBase',
    B4_8P: 'minimumCas',
    B4_18: null,
    B4_20: null,
    B4_5P: 'minimumCassBase',
    B4_6P: 'minimumCass',
    B4_7S: 'minimumWageRelief',
    B4_7C: 'casBaseWithRelief',
    B4_8D: 'employerCasDifference',
    B4_6D: 'employerCassDifference',
    B4_14: 'employerContributionBase',
  },
  asiguratD: {
    D_14a: 'employerDaysIncludingUnpaid',
    D_14: 'employerPaidDays',
    D_15a: 'fundDays',
    D_15: 'fundPaidDays',
    D_16a: 'medicalLeaveDays',
    D_16: 'medicalLeavePaidDays',
    D_17: 'medicalLeaveBaseIncome',
    D_18: 'medicalLeaveBaseDays',
    D_19: 'medicalLeaveDailyAverage',
    D_20: 'medicalLeaveEmployerAmount',
    D_20a: 'medicalLeaveEmployerRecalculatedDifference',
    D_21: 'medicalLeaveFundAmount',
    D_21a: 'medicalLeaveFundRecalculatedDifference',
    D_28: 'medicalLeavePercent',
  },
  asiguratE1: {
    E1_1: 'grossPay',
    E1_2: 'employeeContributions',
    E1_3: 'dependents',
    E1_4: 'personalDeduction',
    E1_41: 'basicDeduction',
    E1_42: 'supplementaryDeduction',
    E1_421: 'youngDeduction',
    E1_422: 'childrenDeduction',
    E1_5: 'otherDeductions',
    E1_6: 'incomeTaxBase',
    E1_7: 'incomeTax',
  },
  asiguratE2: {
    E2_1: 'grossPay',
    E2_2: 'employeeContributions',
    E2_3: 'incomeTaxBase',
    E2_4: 'incomeTax',
  },
  asiguratE3: {
    E3_8: 'grossPay',
    E3_52: 'taxableDelegationAllowance',
    E3_54: 'taxableTransnationalSecondmentAllowance',
    E3_59: 'salaryEquivalentIncome',
    E3_61: 'bonusesIncentivesAndAllowances',
    E3_62: 'exemptDelegationAllowance',
    E3_64: 'exemptTransnationalSecondmentAllowance',
    E3_67: 'exemptEmployerVoluntaryPensionContributions',
    E3_60: 'benefitsInCashAndKind',
    E3_10: 'mealVouchers',
    E3_75: 'holidayVouchers',
    E3_58: 'taxableInsurancePremiums',
    E3_44: 'otherTaxableBenefits',
    E3_69: 'exemptIncome',
    E3_86: 'exemptGifts',
    E3_90: 'cappedExemptBenefits',
    E3_71: 'exemptHealthInsurance',
    E3_78: 'exemptHousing',
    E3_9: 'employeeContributions',
    E3_19: null,
    E3_11: 'dependents',
    E3_12: 'personalDeduction',
    E3_121: 'basicDeduction',
    E3_122: 'supplementaryDeduction',
    E3_1221: 'youngDeduction',
    E3_1222: 'childrenDeduction',
    E3_13: 'otherDeductions',
    E3_14: 'incomeTaxBase',
    E3_15: 'incomeTax',
    E3_16: 'amountReceived',
  },
  angajator: { totalPlata_A: 'controlTotal' },
  angajatorA: {
    A_datorat: 'owed',
    A_deductibil: 'deductible',
    A_scutit: 'exempt',
    A_plata: 'payable',
  },
  angajatorB: {
    B_cnp: 'unemploymentInsuredCount',
    B_sanatate: 'medicalLeaveInsuredCount',
    B_pensie: 'pensionInsuredCount',
    B_sal: 'employeeCount',
    B_brutSalarii: 'grossSalaries',
  },
  angajatorC1: {
    C1_11: 'normalIncomeWithRelief',
    C1_12: 'normalConditionsMedicalLeaveCasBaseWithRelief',
    C1_13: null,
    C1_21: null,
    C1_22: null,
    C1_23: null,
    C1_31: null,
    C1_32: null,
    C1_33: null,
    C1_T1: 'incomeWithReliefTotal',
    C1_T2: 'medicalLeaveCasBaseWithReliefTotal',
    C1_T: null,
    C1_T3: null,
    C1_5: null,
    C1_7: 'accidentFundRecoverable',
  },
  angajatorC2: {
    ...medicalRows(),
    C2_155: 'medicalLeaveEmployerRecalculatedDifference',
    C2_156: 'medicalLeaveFundRecalculatedDifference',
    C2_T6: 'medicalLeaveFundAmountTotal',
    C2_10: 'medicalLeaveFundBenefitsDue',
    C2_140: 'medicalLeaveFundRecoverable',
  },
  angajatorC3: {
    C3_11: 'accidentCases',
    C3_12: 'accidentDays',
    C3_13: 'accidentAmount',
    C3_14: 'accidentFundAmount',
    C3_21: null,
    C3_22: null,
    C3_23: null,
    C3_24: null,
    C3_31: null,
    C3_32: null,
    C3_33: null,
    C3_34: null,
    C3_41: null,
    C3_42: null,
    C3_43: null,
    C3_44: null,
    C3_total: 'accidentAmountTotal',
    C3_suma: 'accidentFundRecoverable',
  },
  angajatorC4: { C4_baza: 'employerContributionBase', C4_ct: 'employerContribution' },
  angajatorD: {
    D2: 'otherCategoryMedicalLeaveInsuredCount',
    D3: 'otherCategoryCasInsuredCount',
  },
  angajatorE1: {
    E1_venit: 'otherCategoryNormalConditionsIncome',
    E1_baza: 'otherCategoryNormalConditionsMedicalLeaveCasBase',
  },
  angajatorE2: {
    ...otherCategoryMedicalRows(),
    E2_156: 'otherCategoryMedicalLeaveFundRecalculatedDifference',
    E2_66: 'otherCategoryMedicalLeaveFundAmountTotal',
    E2_10: 'otherCategoryMedicalLeaveFundBenefitsDue',
    E2_140: 'otherCategoryMedicalLeaveFundRecoverable',
  },
  angajatorE3: {
    ...otherCategoryAccidentRows(),
    E3_total: 'otherCategoryAccidentAmountTotal',
    E3_suma: 'otherCategoryAccidentFundAmountTotal',
  },
  angajatorF1: {
    F1_suma: 'incomeTaxOwed',
    F1_deplata: 'incomeTaxPayable',
    F1_suma_ded: 'incomeTaxDeductible',
    F1_suma_scut: 'incomeTaxExempt',
  },
  angajatorF2: {
    F2_suma: 'incomeTaxOwed',
    F2_deplata: 'incomeTaxPayable',
    F2_suma_ded: 'incomeTaxDeductible',
    F2_suma_scut: 'incomeTaxExempt',
  },
};

function otherCategoryMedicalRows(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [prefix, suffix, name] of [
    ['E2_1', '', 'incapacity'],
    ['E2_11', '', 'isolation'],
    ['E2_12', '', 'percent55'],
    ['E2_13', '', 'percent65'],
    ['E2_14', '', 'percent75'],
    ['E2_2', '', 'prevention'],
    ['E2_21', '', 'quarantine'],
    ['E2_3', '', 'maternity'],
    ['E2_4', '', 'childCare'],
    ['E2_4', 'a', 'oncologyCare'],
    ['E2_5', '', 'maternalRisk'],
  ])
    for (const [column, label] of [
      ['1', 'cases'],
      ['2', 'days'],
      ['4', 'fundDays'],
      ['6', 'fundAmount'],
    ])
      result[`${prefix}${column}${suffix}`] = `otherCategory.${name}.${label}`;
  return result;
}

function otherCategoryAccidentRows(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [row, name] of [
    ['1', 'incapacity'],
    ['2', 'workplaceTransfer'],
    ['3', 'reducedWorkingTime'],
    ['4', 'retraining'],
  ])
    ['cases', 'days', 'amount', 'fundAmount'].forEach((label, index) => {
      result[`E3_${row}${index + 1}`] = `otherCategoryAccident.${name}.${label}`;
    });
  return result;
}

function medicalRows(): Record<string, string> {
  const result: Record<string, string> = {};
  const columns = ['cases', 'days', 'employerDays', 'fundDays', 'employerAmount', 'fundAmount'];
  for (const [prefix, name] of [
    ['C2_1', 'incapacity'],
    ['C2_11', 'isolation'],
    ['C2_12', 'percent55'],
    ['C2_13', 'percent65'],
    ['C2_14', 'percent75'],
    ['C2_2', 'prevention'],
    ['C2_21', 'quarantine'],
  ])
    columns.forEach((column, index) => (result[`${prefix}${index + 1}`] = `${name}.${column}`));
  for (const [prefix, suffix, name] of [
    ['C2_3', '', 'maternity'],
    ['C2_4', '', 'childCare'],
    ['C2_4', 'a', 'oncologyCare'],
    ['C2_5', '', 'maternalRisk'],
  ])
    for (const index of [1, 2, 4, 6])
      result[`${prefix}${index}${suffix}`] = `${name}.${columns[index - 1]}`;
  return result;
}

interface ClassificationRule {
  name: string;
  pattern: RegExp;
}

function classification(name: string, pattern = /^\d{1,3}$/): ClassificationRule {
  return { name, pattern };
}

/** Closed code fields only; bounded syntax cannot carry a name or a personal code. */
export const d112ClassificationFields: Readonly<
  Record<string, Readonly<Record<string, ClassificationRule>>>
> = {
  asigurat: {
    casaSn: classification('healthFundCode', /^(?:[A-Z]{2}|_[AB])$/),
    asigCI: classification('medicalLeaveInsuranceCode', /^[12]$/),
    asigSO: classification('unemploymentInsuranceCode', /^[12]$/),
    asigScu: classification('incomeTaxExemptionCode', /^\d$/),
    asigExc: classification('minimumContributionExceptionCode', /^[012]$/),
    motivExc: classification('minimumContributionExceptionReasonCode', /^[0-5]$/),
    plata_CAS: classification('casPaymentCode', /^\d$/),
    plata_CASS: classification('cassPaymentCode', /^\d$/),
    plata_CAM: classification('employerContributionPaymentCode', /^\d$/),
    bifa_plataNerezident: classification('nonresidentPaymentFlag', /^[01]$/),
    bifa_Ucraina: classification('ukraineFlag', /^[01]$/),
  },
  asiguratA: {
    A_1: classification('insuredType'),
    A_2: classification('pensioner', /^[01]$/),
    A_3: classification('workingTimeContractType', /^(?:N|P[1-7])$/),
    A_4: classification('normHours', /^[678]$/),
  },
  asiguratB1: {
    B1_1: classification('insuredType'),
    B1_2: classification('pensioner', /^[01]$/),
    B1_3: classification('workingTimeContractType', /^(?:N|P[1-7])$/),
    B1_4: classification('normHours', /^[678]$/),
  },
  asiguratB2: { B2_1: classification('workingConditionsCode', /^[123]$/) },
  asiguratD: {
    D_9: classification('indemnityCode', /^\d{1,2}$/),
    D_9a: classification('nationalHealthProgrammeCode', /^\d{1,2}$/),
    D_9b: classification('hasUnpaidDay', /^[01]$/),
    D_10: classification('prescriptionPlace', /^\d{1,2}$/),
  },
  asiguratE3: {
    E3_1: classification('reportingSection', /^[ABC]$/),
    E3_2: classification('insuredType'),
    E3_3: classification('mainJobCode', /^[123]$/),
    E3_4: classification('incomePeriodCode', /^[AP]$/),
    E3_7: classification('otherPeriodIncomeReasonCode'),
  },
  angajator: { datCAM: classification('employerContributionLiabilityCode', /^[012]$/) },
  angajatorA: { A_codOblig: classification('obligationCode') },
  angajatorF2: {
    F2_cif: classification('secondaryEstablishmentFiscalCode', /^\d{1,10}$/),
    F2_id: classification('secondaryEstablishmentOrdinal', /^\d{1,5}$/),
  },
};

// Explicitly excluded identifiers, names, contacts, dates, diagnosis and certificate numbers.
// In particular D_8/D_8a are other people's CNPs, even though they look like decimal figures.
const metadata: Readonly<Record<string, readonly string[]>> = {
  declaratieUnica: [
    'luna_r',
    'an_r',
    'd_rec',
    'tip_rec',
    'nume_declar',
    'prenume_declar',
    'functie_declar',
  ],
  asigurat: [
    'cnpAsig',
    'idAsig',
    'numeAsig',
    'prenAsig',
    'cisAsig',
    'cnpAnt',
    'numeAnt',
    'prenAnt',
    'dataAng',
    'dataSf',
  ],
  asiguratD: [
    'Data_CMI',
    'D_1',
    'D_2',
    'D_3',
    'D_4',
    'D_5',
    'D_6',
    'D_7',
    'D_8',
    'D_8a',
    'D_11',
    'D_12',
    'D_23',
  ],
  angajator: [
    'cif',
    'cifS',
    'rgCom',
    'caen',
    'den',
    'adrSoc',
    'telSoc',
    'faxSoc',
    'mailSoc',
    'adrFisc',
    'telFisc',
    'faxFisc',
    'mailFisc',
    'casaAng',
  ],
  angajatorA: ['A_codBugetar'],
};

export interface D112Figure {
  section: string;
  /** One-based occurrence within this person/employer; repeated sections never overwrite. */
  occurrence: number;
  field: string;
  name: string | null;
  value: string;
}

export interface D112Classification {
  section: string;
  occurrence: number;
  field: string;
  name: string;
  value: string;
}

export interface D112Employees {
  namespace: string;
  version: number | null;
  period: FiledDeclaration['period'];
  employerFiscalCode: string | null;
  rectifying: boolean | null;
  layout: '2026-v7' | 'unsupported';
  employees: { personKey: string; figures: D112Figure[]; classifications: D112Classification[] }[];
  employerTotals: D112Figure[];
  employerClassifications: D112Classification[];
  unmappedFields: PathCount[];
  fieldsOutsideMappingTable: PathCount[];
  numericFieldsWithoutNeutralName: PathCount[];
  unplacedSections: PathCount[];
}

/** Never calculates, rounds or coalesces figures. Unsupported layouts expose keys and gaps. */
export function readD112Employees(declaration: FiledDeclaration, key: Uint8Array): D112Employees {
  if (key.byteLength < 32) throw new Error('PAYROLL_KEY_SIZE');
  if (
    declaration.form !== 'D112' ||
    !/^mfp:anaf:dgti:(declaratie_unica|d112):declaratie:v\d+$/.test(declaration.namespace)
  )
    throw new Error('D112_NAMESPACE');
  const fields = fieldMap(declaration);
  const root = declaration.root;
  if (declaration.period?.year === '2026') {
    if (!declaration.period.month) throw new Error('D112_MONTH_REQUIRED');
    if (!/^(?:0?[1-9]|1[0-2])$/.test(declaration.period.month))
      throw new Error('D112_MONTH_INVALID');
  }
  const supported =
    declaration.version === 7 &&
    declaration.period?.year === '2026' &&
    /^(?:0?[1-9]|1[0-2])$/.test(declaration.period.month ?? '') &&
    root === 'declaratieUnica';
  const people = new Map<string, D112Employees['employees'][number]>();
  const identities = new Set<string>();
  for (const [path, value] of fields) {
    const steps = path.split('/');
    if (
      steps.length === 3 &&
      steps[0] === root &&
      /^asigurat(?:\[\d+\])?$/.test(steps[1]!) &&
      steps[2] === '@cnpAsig'
    ) {
      const owner = path.slice(0, -'/@cnpAsig'.length);
      const identity = personKey(value, key);
      if (identities.has(identity)) throw new Error('D112_PERSON_DUPLICATE');
      identities.add(identity);
      people.set(owner, { personKey: identity, figures: [], classifications: [] });
    }
  }
  const employerTotals: D112Figure[] = [];
  const employerClassifications: D112Classification[] = [];
  const unmapped = new Map<string, number>();
  const outside = new Map<string, number>();
  const unnamed = new Map<string, number>();
  const unplaced = new Map<string, Set<string>>();
  const gap = (path: string, reason: 'outside' | 'unnamed') => {
    const canonical = path.replace(/\[\d+\]/g, '');
    unmapped.set(canonical, (unmapped.get(canonical) ?? 0) + 1);
    const counts = reason === 'outside' ? outside : unnamed;
    counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
  };
  for (const [path, value] of fields) {
    if (path === `${root}/@{http://www.w3.org/2001/XMLSchema-instance}schemaLocation`) continue;
    const match = /^(.*)\/@([A-Za-z_]\w*)$/.exec(path);
    const elementPath = match?.[1] ?? path.replace(/\/#text$/, '');
    const steps = elementPath.split('/');
    const sectionStep = steps.at(-1)!;
    const section = sectionStep.replace(/\[\d+\]$/, '');
    const field = match?.[2];
    const owner = steps.slice(0, 2).join('/');
    const isPerson = /^asigurat(?:\[\d+\])?$/.test(steps[1] ?? '');
    if (isPerson && !people.has(owner)) throw new Error('D112_PERSON_CODE_MISSING');
    const destination = isPerson ? people.get(owner)!.figures : employerTotals;
    const placed =
      (isPerson && (steps.length === 2 || steps.length === 3)) ||
      (steps[1] === 'angajator' && (steps.length === 2 || steps.length === 3));
    const occurrence = steps.length === 2 ? 1 : Number(/\[(\d+)\]$/.exec(sectionStep)?.[1] ?? '1');
    const classificationTable =
      placed && supported && Object.hasOwn(d112ClassificationFields, section)
        ? d112ClassificationFields[section]
        : undefined;
    if (field && classificationTable && Object.hasOwn(classificationTable, field)) {
      const rule = classificationTable[field]!;
      if (!rule.pattern.test(value)) throw new Error('D112_CLASSIFICATION');
      const classifications = isPerson
        ? people.get(owner)!.classifications
        : employerClassifications;
      classifications.push({ section, occurrence, field, name: rule.name, value });
      continue;
    }
    if (field && Object.hasOwn(metadata, section) && metadata[section]?.includes(field)) continue;
    const table =
      placed && supported && Object.hasOwn(d112FieldNames, section)
        ? d112FieldNames[section]
        : undefined;
    if (!field || !table || !Object.hasOwn(table, field)) {
      gap(path, 'outside');
      if (steps.length > 1 && (!supported || !table)) {
        const canonical = elementPath.replace(/\[\d+\]/g, '');
        const occurrences = unplaced.get(canonical) ?? new Set<string>();
        occurrences.add(elementPath);
        unplaced.set(canonical, occurrences);
      }
      continue;
    }
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('D112_DECIMAL');
    const name = table[field]!;
    if (name === null) gap(path, 'unnamed');
    destination.push({
      section,
      occurrence,
      field,
      name,
      value,
    });
  }
  return {
    namespace: declaration.namespace,
    version: declaration.version,
    period: declaration.period,
    employerFiscalCode: declaration.fiscalCode,
    rectifying: declaration.rectifying,
    layout: supported ? '2026-v7' : 'unsupported',
    employees: [...people.values()],
    employerTotals,
    employerClassifications,
    unmappedFields: pathCounts(unmapped),
    fieldsOutsideMappingTable: pathCounts(outside),
    numericFieldsWithoutNeutralName: pathCounts(unnamed),
    unplacedSections: pathCounts(new Map([...unplaced].map(([path, items]) => [path, items.size]))),
  };
}
