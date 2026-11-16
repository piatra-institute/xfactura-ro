import { describe, expect, test } from 'bun:test';
import { writeD112 } from 'xfactura-core/ro/declarations/d112';
import { readDeclaration } from 'xfactura-core/ro/declarations/read';
import { d112FieldNames, readD112Employees, type D112Figure } from '../src/read/d112';
import { readRevisal } from '../src/read/revisal';
import {
  accountingProgramD112,
  d112Model,
  employee,
  otherKey,
  revisalArchive,
  revisalXml,
  sickEmployee,
  syntheticCodes,
  syntheticNames,
  tarMember,
  testKey,
  xmlBytes,
  zipMember,
} from './payroll-fixtures';

const readD112 = (xml: string) => readD112Employees(readDeclaration(xmlBytes(xml)), testKey);
function privateModel(model: unknown) {
  const serialized = JSON.stringify(model);
  for (const identity of [...syntheticCodes, ...syntheticNames])
    expect(serialized).not.toContain(identity);
}

type FigureCase = [section: string, field: string, name: string, value: string];
function assertFigures(figures: D112Figure[], cases: FigureCase[], sections?: Set<string>) {
  for (const [section, field, name, value] of cases) {
    expect(figures.find((figure) => figure.section === section && figure.field === field)).toEqual({
      section,
      occurrence: 1,
      field,
      name,
      value,
    });
    sections?.add(section);
  }
}

describe('reviewed D112 projection', () => {
  test('accounting-program layout retains zero gross-contract pay, F1 tax, and the unnamed coverage', () => {
    const model = readD112(accountingProgramD112());
    expect(model.employees[0]!.figures).toContainEqual({
      section: 'asiguratA',
      occurrence: 1,
      field: 'A_sal2',
      name: 'grossContractPay',
      value: '0',
    });
    assertFigures(model.employerTotals, [
      ['angajatorF1', 'F1_suma', 'incomeTaxOwed', '269'],
      ['angajatorF1', 'F1_deplata', 'incomeTaxPayable', '269'],
      ['angajatorF1', 'F1_suma_ded', 'incomeTaxDeductible', '0'],
      ['angajatorF1', 'F1_suma_scut', 'incomeTaxExempt', '0'],
    ]);
    expect(model.employerTotals.find((field) => field.field === 'F1_suma')!.value).toBe(
      model.employerTotals.find((field) => field.field === 'A_datorat')!.value,
    );
    expect(model.unplacedSections).toEqual([]);
    expect(model.fieldsOutsideMappingTable).toEqual([]);
    expect(model.numericFieldsWithoutNeutralName).toHaveLength(18);
    const expected = [
      ...['C1_21', 'C1_22', 'C1_31', 'C1_32', 'C1_T3'].map(
        (field) => `declaratieUnica/angajator/angajatorC1/@${field}`,
      ),
      ...[
        'C3_21',
        'C3_22',
        'C3_23',
        'C3_24',
        'C3_31',
        'C3_32',
        'C3_33',
        'C3_34',
        'C3_41',
        'C3_42',
        'C3_43',
        'C3_44',
      ].map((field) => `declaratieUnica/angajator/angajatorC3/@${field}`),
      'declaratieUnica/asigurat/asiguratE3/@E3_19',
    ].sort();
    expect(model.numericFieldsWithoutNeutralName).toEqual(
      expected.map((path) => ({ path, count: 1 })),
    );
    expect(
      [...model.employerTotals, ...model.employees[0]!.figures]
        .filter((figure) => figure.name === null)
        .map((figure) => figure.value),
    ).toEqual(Array(18).fill('0'));
    privateModel(model);
  });

  test('asserts a representative of every mapped section and medical/accident row group', () => {
    // Nonzero row markers exercise the projection; this is not a tax-validation fixture.
    const xml = accountingProgramD112()
      .replace(
        '<angajatorE2 ',
        '<angajatorE2 E2_11="1" E2_111="2" E2_121="3" E2_131="4" E2_141="5" E2_21="6" E2_211="7" E2_31="8" E2_41="9" E2_41a="10" E2_51="11" E2_126="12.30" E2_156="1.01" ',
      )
      .replace('<angajatorE3 ', '<angajatorE3 E3_11="1" E3_21="2" E3_31="3" E3_41="4" ')
      .replace(
        '</angajator>',
        `<angajatorF2 F2_cif="14399840" F2_id="1" F2_suma="10" F2_deplata="7" F2_suma_ded="2" F2_suma_scut="1"/></angajator>`,
      );
    const model = readD112(xml);
    const sections = new Set<string>();
    assertFigures(
      model.employees[0]!.figures,
      [
        ['asigurat', 'Timp_E3', 'incomeTaxTotal', '269'],
        ['asigurat', 'Tcota_E4', 'redirectedIncomeTaxPercent', '0.00'],
        ['asigurat', 'Tsuma_E4', 'redirectedIncomeTaxAmount', '0'],
        ['asiguratA', 'A_sal1', 'baseSalary', '5000'],
        ['asiguratA', 'A_sal2', 'grossContractPay', '0'],
        ['asiguratA', 'A_5', 'employerContributionBase', '5000'],
        ['asiguratA', 'A_6', 'hoursWorked', '176'],
        ['asiguratA', 'A_7', 'hoursSuspended', '0'],
        ['asiguratA', 'A_8', 'daysWorked', '22'],
        ['asiguratA', 'A_9', 'unemploymentBase', '5000'],
        ['asiguratA', 'A_11P', 'minimumCassBase', '0'],
        ['asiguratA', 'A_14P', 'minimumCas', '0'],
        ['asiguratE1', 'E1_1', 'grossPay', '5000'],
        ['asiguratE1', 'E1_2', 'employeeContributions', '1750'],
        ['asiguratE1', 'E1_41', 'basicDeduction', '562'],
        ['asiguratE1', 'E1_422', 'childrenDeduction', '0'],
        ['asiguratE1', 'E1_6', 'incomeTaxBase', '2688'],
        ['asiguratE3', 'E3_8', 'grossPay', '5000'],
        ['asiguratE3', 'E3_12', 'personalDeduction', '562'],
        ['asiguratE3', 'E3_1221', 'youngDeduction', '0'],
        ['asiguratE3', 'E3_60', 'benefitsInCashAndKind', '0'],
        ['asiguratE3', 'E3_69', 'exemptIncome', '0'],
        ['asiguratE3', 'E3_71', 'exemptHealthInsurance', '0'],
        ['asiguratE3', 'E3_90', 'cappedExemptBenefits', '0'],
        ['asiguratE3', 'E3_16', 'amountReceived', '2981'],
      ],
      sections,
    );
    assertFigures(
      model.employerTotals,
      [
        ['angajator', 'totalPlata_A', 'controlTotal', '500'],
        ['angajatorA', 'A_datorat', 'owed', '269'],
        ['angajatorA', 'A_deductibil', 'deductible', '0'],
        ['angajatorA', 'A_scutit', 'exempt', '0'],
        ['angajatorA', 'A_plata', 'payable', '269'],
        ['angajatorB', 'B_sal', 'employeeCount', '1'],
        ['angajatorB', 'B_brutSalarii', 'grossSalaries', '5000'],
        ['angajatorC1', 'C1_11', 'normalIncomeWithRelief', '5000'],
        ['angajatorC1', 'C1_12', 'normalConditionsMedicalLeaveCasBaseWithRelief', '0'],
        ['angajatorC1', 'C1_T1', 'incomeWithReliefTotal', '5000'],
        ['angajatorC1', 'C1_T2', 'medicalLeaveCasBaseWithReliefTotal', '0'],
        ['angajatorC2', 'C2_T6', 'medicalLeaveFundAmountTotal', '0'],
        ['angajatorC2', 'C2_10', 'medicalLeaveFundBenefitsDue', '0'],
        ['angajatorC2', 'C2_140', 'medicalLeaveFundRecoverable', '0'],
        ['angajatorC3', 'C3_11', 'accidentCases', '0'],
        ['angajatorC3', 'C3_14', 'accidentFundAmount', '0'],
        ['angajatorC3', 'C3_suma', 'accidentFundRecoverable', '0'],
        ['angajatorC4', 'C4_ct', 'employerContribution', '113'],
        ['angajatorD', 'D2', 'otherCategoryMedicalLeaveInsuredCount', '0'],
        ['angajatorD', 'D3', 'otherCategoryCasInsuredCount', '0'],
        ['angajatorE1', 'E1_venit', 'otherCategoryNormalConditionsIncome', '0'],
        ['angajatorE1', 'E1_baza', 'otherCategoryNormalConditionsMedicalLeaveCasBase', '0'],
        ['angajatorE2', 'E2_11', 'otherCategory.incapacity.cases', '1'],
        ['angajatorE2', 'E2_111', 'otherCategory.isolation.cases', '2'],
        ['angajatorE2', 'E2_121', 'otherCategory.percent55.cases', '3'],
        ['angajatorE2', 'E2_131', 'otherCategory.percent65.cases', '4'],
        ['angajatorE2', 'E2_141', 'otherCategory.percent75.cases', '5'],
        ['angajatorE2', 'E2_21', 'otherCategory.prevention.cases', '6'],
        ['angajatorE2', 'E2_211', 'otherCategory.quarantine.cases', '7'],
        ['angajatorE2', 'E2_31', 'otherCategory.maternity.cases', '8'],
        ['angajatorE2', 'E2_41', 'otherCategory.childCare.cases', '9'],
        ['angajatorE2', 'E2_41a', 'otherCategory.oncologyCare.cases', '10'],
        ['angajatorE2', 'E2_51', 'otherCategory.maternalRisk.cases', '11'],
        ['angajatorE2', 'E2_126', 'otherCategory.percent55.fundAmount', '12.30'],
        ['angajatorE2', 'E2_156', 'otherCategoryMedicalLeaveFundRecalculatedDifference', '1.01'],
        ['angajatorE2', 'E2_66', 'otherCategoryMedicalLeaveFundAmountTotal', '0'],
        ['angajatorE2', 'E2_10', 'otherCategoryMedicalLeaveFundBenefitsDue', '0'],
        ['angajatorE2', 'E2_140', 'otherCategoryMedicalLeaveFundRecoverable', '0'],
        ['angajatorE3', 'E3_11', 'otherCategoryAccident.incapacity.cases', '1'],
        ['angajatorE3', 'E3_21', 'otherCategoryAccident.workplaceTransfer.cases', '2'],
        ['angajatorE3', 'E3_31', 'otherCategoryAccident.reducedWorkingTime.cases', '3'],
        ['angajatorE3', 'E3_41', 'otherCategoryAccident.retraining.cases', '4'],
        ['angajatorE3', 'E3_total', 'otherCategoryAccidentAmountTotal', '0'],
        ['angajatorE3', 'E3_suma', 'otherCategoryAccidentFundAmountTotal', '0'],
        ['angajatorF1', 'F1_suma', 'incomeTaxOwed', '269'],
        ['angajatorF2', 'F2_deplata', 'incomeTaxPayable', '7'],
        ['angajatorF2', 'F2_suma_ded', 'incomeTaxDeductible', '2'],
        ['angajatorF2', 'F2_suma_scut', 'incomeTaxExempt', '1'],
      ],
      sections,
    );
    const base = employee();
    const writer = readD112(
      writeD112(
        d112Model([
          sickEmployee(),
          employee({
            cnp: syntheticCodes[1],
            income: { ...base.income, mainJob: false },
          }),
        ]),
      ),
    );
    assertFigures(
      writer.employees[0]!.figures,
      [
        ['asiguratB1', 'B1_sal2', 'grossContractPay', '4368'],
        ['asiguratB1', 'B1_5', 'employerContributionBase', '4000'],
        ['asiguratB2', 'B2_5', 'workedCasBase', '2455'],
        ['asiguratB3', 'B3_7', 'medicalLeaveCasBase', '1913'],
        ['asiguratB4', 'B4_5', 'cassBase', '4368'],
        ['asiguratB4', 'B4_8', 'cas', '1092'],
        ['asiguratD', 'D_19', 'medicalLeaveDailyAverage', '283.46'],
        ['asiguratD', 'D_14a', 'employerDaysIncludingUnpaid', '5'],
        ['asiguratD', 'D_14', 'employerPaidDays', '4'],
        ['asiguratD', 'D_28', 'medicalLeavePercent', '55'],
      ],
      sections,
    );
    assertFigures(
      writer.employees[1]!.figures,
      [
        ['asiguratE2', 'E2_1', 'grossPay', '5000'],
        ['asiguratE2', 'E2_2', 'employeeContributions', '1750'],
        ['asiguratE2', 'E2_3', 'incomeTaxBase', '2688'],
        ['asiguratE2', 'E2_4', 'incomeTax', '269'],
      ],
      sections,
    );
    assertFigures(
      writer.employerTotals,
      [
        ['angajatorC2', 'C2_11', 'incapacity.cases', '2'],
        ['angajatorC2', 'C2_111', 'isolation.cases', '0'],
        ['angajatorC2', 'C2_121', 'percent55.cases', '1'],
        ['angajatorC2', 'C2_131', 'percent65.cases', '1'],
        ['angajatorC2', 'C2_141', 'percent75.cases', '0'],
        ['angajatorC2', 'C2_21', 'prevention.cases', '0'],
        ['angajatorC2', 'C2_211', 'quarantine.cases', '0'],
        ['angajatorC2', 'C2_31', 'maternity.cases', '0'],
        ['angajatorC2', 'C2_41', 'childCare.cases', '0'],
        ['angajatorC2', 'C2_41a', 'oncologyCare.cases', '0'],
        ['angajatorC2', 'C2_51', 'maternalRisk.cases', '0'],
        ['angajatorC2', 'C2_125', 'percent55.employerAmount', '624'],
        ['angajatorC2', 'C2_136', 'percent65.fundAmount', '368'],
      ],
      sections,
    );
    expect([...sections].sort()).toEqual(Object.keys(d112FieldNames).sort());
  });

  test('names all nine extra gross-pay, benefit and tax fields and preserves their source strings', () => {
    const cases: FigureCase[] = [
      ['asiguratE3', 'E3_52', 'taxableDelegationAllowance', '12.01'],
      ['asiguratE3', 'E3_54', 'taxableTransnationalSecondmentAllowance', '12.02'],
      ['asiguratE3', 'E3_59', 'salaryEquivalentIncome', '12.03'],
      ['asiguratE3', 'E3_61', 'bonusesIncentivesAndAllowances', '12.04'],
      ['asiguratE3', 'E3_62', 'exemptDelegationAllowance', '12.05'],
      ['asiguratE3', 'E3_64', 'exemptTransnationalSecondmentAllowance', '12.06'],
      ['asiguratE3', 'E3_67', 'exemptEmployerVoluntaryPensionContributions', '12.07'],
      ['asigurat', 'Tcota_E4', 'redirectedIncomeTaxPercent', '3.50'],
      ['asigurat', 'Tsuma_E4', 'redirectedIncomeTaxAmount', '12.08'],
    ];
    let xml = accountingProgramD112();
    for (const [, field, , value] of cases)
      xml = xml.replace(new RegExp(`${field}="[^"]*"`), `${field}="${value}"`);
    const result = readD112(xml);
    assertFigures(result.employees[0]!.figures, cases);
    expect(result.fieldsOutsideMappingTable).toEqual([]);
    privateModel(result);
  });

  test('employee classifications explain exceptions and working time without entering figures', () => {
    const xml = accountingProgramD112()
      .replace('asigExc="0"', 'asigExc="1" motivExc="3" asigScu="1" plata_CAS="0"')
      .replace('A_3="N"', 'A_3="P4"')
      .replace('A_12="500"', 'A_12="0"')
      .replace('A_14="1250"', 'A_14="0"');
    const model = readD112(xml);
    for (const [section, field, name, value] of [
      ['asigurat', 'asigExc', 'minimumContributionExceptionCode', '1'],
      ['asigurat', 'motivExc', 'minimumContributionExceptionReasonCode', '3'],
      ['asigurat', 'asigScu', 'incomeTaxExemptionCode', '1'],
      ['asigurat', 'plata_CAS', 'casPaymentCode', '0'],
      ['asigurat', 'asigCI', 'medicalLeaveInsuranceCode', '1'],
      ['asigurat', 'asigSO', 'unemploymentInsuranceCode', '1'],
      ['asigurat', 'casaSn', 'healthFundCode', 'GL'],
      ['asiguratA', 'A_1', 'insuredType', '1'],
      ['asiguratA', 'A_2', 'pensioner', '0'],
      ['asiguratA', 'A_3', 'workingTimeContractType', 'P4'],
      ['asiguratA', 'A_4', 'normHours', '8'],
      ['asiguratE3', 'E3_1', 'reportingSection', 'A'],
      ['asiguratE3', 'E3_2', 'insuredType', '1'],
      ['asiguratE3', 'E3_3', 'mainJobCode', '1'],
      ['asiguratE3', 'E3_4', 'incomePeriodCode', 'P'],
    ]) {
      expect(model.employees[0]!.classifications).toContainEqual({
        section,
        occurrence: 1,
        field,
        name,
        value,
      });
      expect(model.employees[0]!.figures.some((figure) => figure.field === field)).toBe(false);
    }
    const sick = readD112(writeD112(d112Model([sickEmployee()]))).employees[0]!;
    expect(sick.classifications).toContainEqual({
      section: 'asiguratB1',
      occurrence: 1,
      field: 'B1_3',
      name: 'workingTimeContractType',
      value: 'N',
    });
    expect(sick.classifications).toContainEqual({
      section: 'asiguratD',
      occurrence: 2,
      field: 'D_9',
      name: 'indemnityCode',
      value: '01',
    });
    expect(model.employerClassifications).toContainEqual({
      section: 'angajatorA',
      occurrence: 1,
      field: 'A_codOblig',
      name: 'obligationCode',
      value: '602',
    });
    privateModel(model);
    for (const value of [syntheticCodes[2], syntheticNames[0]])
      expect(() => readD112(xml.replace('A_3="P4"', `A_3="${value}"`))).toThrow(
        'D112_CLASSIFICATION',
      );
  });

  test('secondary establishments retain all four tax figures and their own classification context', () => {
    const xml = accountingProgramD112().replace(
      '</angajator>',
      `<angajatorF2 F2_cif="14399840" F2_id="1" F2_suma="10" F2_deplata="7" F2_suma_ded="2" F2_suma_scut="1"/>
      <angajatorF2 F2_cif="18547290" F2_id="2" F2_suma="20" F2_deplata="17" F2_suma_ded="2" F2_suma_scut="1"/></angajator>`,
    );
    const result = readD112(xml);
    for (const occurrence of [1, 2]) {
      expect(
        result.employerTotals.filter(
          (figure) => figure.section === 'angajatorF2' && figure.occurrence === occurrence,
        ),
      ).toHaveLength(4);
      expect(result.employerClassifications).toContainEqual({
        section: 'angajatorF2',
        occurrence,
        field: 'F2_id',
        name: 'secondaryEstablishmentOrdinal',
        value: String(occurrence),
      });
    }
    expect(
      result.employerTotals
        .filter((figure) => figure.field === 'F2_suma')
        .map((figure) => figure.value),
    ).toEqual(['10', '20']);
    expect(
      result.employerClassifications
        .filter((field) => field.field === 'F2_cif')
        .map((field) => field.value),
    ).toEqual(['14399840', '18547290']);
    expect(result.unplacedSections).toEqual([]);
    privateModel(result);
  });

  test('a missing or invalid 2026 month has an explicit error', () => {
    expect(() => readD112(accountingProgramD112().replace('luna_r="10"', ''))).toThrow(
      'D112_MONTH_REQUIRED',
    );
    expect(() => readD112(accountingProgramD112().replace('luna_r="10"', 'luna_r="13"'))).toThrow(
      'D112_MONTH_INVALID',
    );
  });
});

describe('reviewed Revisal projection and tar edges', () => {
  test('reads contractual allowance values and types, hashing employer free-text labels', async () => {
    const allowances = `<SporuriSalariu>
      <Spor><IsProcent>true</IsProcent><Tip i:type="TipSporPredefinit"><Nume>TipSintetic</Nume><Versiune>9</Versiune></Tip><Valoare>12.50</Valoare></Spor>
      <Spor><IsProcent>false</IsProcent><Tip i:type="TipSporAngajator"><Nume>${syntheticNames[0]} ${syntheticCodes[2]}</Nume></Tip><Valoare>123.40</Valoare></Spor>
    </SporuriSalariu>`;
    const xml = revisalXml().replaceAll('<Salariu>', `${allowances}<Salariu>`);
    const result = await readRevisal(revisalArchive(xml), testKey);
    const values = result.contracts[0]!.allowances!;
    expect(values).toEqual([
      {
        type: 'TipSporPredefinit',
        typeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: '9',
        isPercent: true,
        value: '12.50',
      },
      {
        type: 'TipSporAngajator',
        typeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: null,
        isPercent: false,
        value: '123.40',
      },
    ]);
    expect(result.contracts[1]!.allowances).toEqual(values);
    expect(
      (await readRevisal(revisalArchive(xml), otherKey)).contracts[0]!.allowances![0]!.typeKey,
    ).not.toBe(values[0]!.typeKey);
    privateModel(result);
    const nil = await readRevisal(
      revisalArchive(
        revisalXml().replaceAll('<Salariu>', '<SporuriSalariu i:nil="true"/><Salariu>'),
      ),
      testKey,
    );
    expect(nil.contracts.every((contract) => contract.allowances === null)).toBe(true);
    expect(nil.unread.some((field) => field.path.endsWith('/SporuriSalariu'))).toBe(false);
  });

  test('reads a suspended current state directly and consumes a nil preceding state', async () => {
    const xml = revisalXml().replace(
      '<StareCurenta i:type="ContractStareActiv"><StarePrecedenta i:nil="true"/></StareCurenta>',
      '<StareCurenta i:type="ContractStareSuspendare"><StarePrecedenta i:nil="true"/><DataInceput>2026-10-10T00:00:00</DataInceput><DataSfarsit>2026-10-20T00:00:00</DataSfarsit><DataIncetare i:nil="true"/></StareCurenta>',
    );
    const result = await readRevisal(revisalArchive(xml), testKey);
    expect(result.contracts[1]!.state).toMatchObject({
      kind: 'suspended',
      suspensionStart: '2026-10-10T00:00:00',
      suspensionEnd: '2026-10-20T00:00:00',
      terminationDate: null,
    });
    expect(result.contracts[1]!.changes).toContainEqual({
      kind: 'suspension',
      date: '2026-10-10T00:00:00',
      until: '2026-10-20T00:00:00',
      endedAt: null,
    });
    expect(result.unread.some((field) => field.path.endsWith('/StarePrecedenta'))).toBe(false);
    privateModel(result);
  });

  test('accepts a safe tar prefix, the space-padded magic and zero trailer padding', async () => {
    const zip = zipMember(revisalXml());
    const expected = await readRevisal(tarMember(zip), testKey);
    expect(
      await readRevisal(
        tarMember(zip, 'snapshot.xml.pcs', undefined, undefined, { prefix: 'safe/nested' }),
        testKey,
      ),
    ).toEqual(expected);
    expect(
      await readRevisal(
        tarMember(zip, 'snapshot.xml.pcs', undefined, undefined, { magic: 'ustar ' }),
        testKey,
      ),
    ).toEqual(expected);
    expect(await readRevisal(Buffer.concat([tarMember(zip), Buffer.alloc(512)]), testKey)).toEqual(
      expected,
    );
  });
});
