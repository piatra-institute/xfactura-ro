import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const lei = z.string().regex(/^(0|[1-9]\d*)$/);

export const deductionTable = z
  .object({
    /** The table covers gross incomes up to the minimum wage plus this many lei. */
    span: lei,
    /** Each row after the first covers this many lei more. */
    step: lei,
    /** Percentages of the minimum wage for 0, 1, 2, 3 and 4 or more dependents; the first row is
     * for incomes up to the minimum wage. */
    rows: z.array(z.tuple([percent, percent, percent, percent, percent])).min(1),
  })
  .strict();
export type DeductionTable = z.infer<typeof deductionTable>;

export const supplementaryDeduction = z.object({ youngPercent: percent, perChild: lei }).strict();
export type SupplementaryDeduction = z.infer<typeof supplementaryDeduction>;

export const minimumWageRelief = z.object({ amount: lei, grossCeiling: lei }).strict();
export type MinimumWageRelief = z.infer<typeof minimumWageRelief>;

const rate = (key: string, description: string): ParameterDefinition => ({
  key,
  axis: 'payroll_month_start',
  continuity: 'block',
  scope: [],
  value: percent,
  description,
});

export const payrollDefinitions: ParameterDefinition[] = [
  rate('ro.payroll.income_tax.rate', 'Cota impozitului pe veniturile din salarii.'),
  rate('ro.payroll.cas.rate', 'Cota CAS datorate de angajat, în condiții normale de muncă.'),
  rate('ro.payroll.cass.rate', 'Cota CASS datorate de angajat.'),
  rate(
    'ro.payroll.cam.rate',
    'Cota contribuției asiguratorii pentru muncă, datorate de angajator.',
  ),
  {
    key: 'ro.payroll.minimum_wage',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: lei,
    description:
      'Salariul de bază minim brut pe țară garantat în plată, pentru norma întreagă, în lei.',
  },
  {
    key: 'ro.payroll.personal_deduction',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: deductionTable,
    description: 'Tabelul deducerii personale de bază, în procente din salariul minim.',
  },
  {
    key: 'ro.payroll.supplementary_deduction',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: supplementaryDeduction,
    description:
      'Deducerea personală suplimentară: procentul din salariul minim până la 26 de ani și suma pentru fiecare copil înscris la școală.',
  },
  {
    key: 'ro.payroll.minimum_wage_relief',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: minimumWageRelief,
    description:
      'Suma care nu se include în bazele de calcul pentru salariații plătiți cu salariul minim, și plafonul venitului brut până la care se acordă.',
  },
  {
    key: 'ro.payroll.tax_base_rounding',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['leu_half_down']),
    description:
      'Rotunjirea bazei de calcul al impozitului la leu (până la 50 de bani inclusiv se neglijează).',
  },
  {
    key: 'ro.payroll.amount_rounding',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['leu_half_up']),
    description:
      'Rotunjirea contribuțiilor și a impozitului la leu (de la 50 de bani prin majorare).',
  },
];

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * The values read in ANAF's consolidated Fiscal Code apply from 2026-01-01: the snapshot shows
 * them in force, not since when, so earlier months are a gap until the texts then in force are
 * sourced. The minimum wage and its relief cite texts still to be obtained.
 */
const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from = '2026-01-01',
  to: string | null = null,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: to === null ? null : date(to),
  reviewedThrough: to === null ? date('2026-12-31') : null,
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});

export const payrollVersions: ParameterVersion[] = [
  version('ro.payroll.income_tax.rate', '10', [code('art.64(1)(b)'), code('art.78(2)(a)')]),
  version('ro.payroll.cas.rate', '25', [code('art.138(a)')]),
  version('ro.payroll.cass.rate', '10', [code('art.156')]),
  version('ro.payroll.cam.rate', '2.25', [code('art.220^3(1)')]),
  version('ro.payroll.minimum_wage', '4050', ['HG1506/2024:art.1'], '2025-01-01', '2025-12-31'),
  version(
    'ro.payroll.minimum_wage',
    '4050',
    ['HG1506/2024:art.1', 'ANAF/D112-0726:salariul-minim'],
    '2026-01-01',
    '2026-06-30',
  ),
  version(
    'ro.payroll.minimum_wage',
    '4325',
    ['HG146/2026:art.1', 'ANAF/D112-0726:salariul-minim'],
    '2026-07-01',
  ),
  version(
    'ro.payroll.personal_deduction',
    {
      span: '2000',
      step: '50',
      rows: [
        ['20', '25', '30', '35', '45'],
        ['19.5', '24.5', '29.5', '34.5', '44.5'],
        ['19', '24', '29', '34', '44'],
        ['18.5', '23.5', '28.5', '33.5', '43.5'],
        ['18', '23', '28', '33', '43'],
        ['17.5', '22.5', '27.5', '32.5', '42.5'],
        ['17', '22', '27', '32', '42'],
        ['16.5', '21.5', '26.5', '31.5', '41.5'],
        ['16', '21', '26', '31', '41'],
        ['15.5', '20.5', '25.5', '30.5', '40.5'],
        ['15', '20', '25', '30', '40'],
        ['14.5', '19.5', '24.5', '29.5', '39.5'],
        ['14', '19', '24', '29', '39'],
        ['13.5', '18.5', '23.5', '28.5', '38.5'],
        ['13', '18', '23', '28', '38'],
        ['12.5', '17.5', '22.5', '27.5', '37.5'],
        ['12', '17', '22', '27', '37'],
        ['11.5', '16.5', '21.5', '26.5', '36.5'],
        ['11', '16', '21', '26', '36'],
        ['10.5', '15.5', '20.5', '25.5', '35.5'],
        ['10', '15', '20', '25', '35'],
        ['9.5', '14.5', '19.5', '24.5', '34.5'],
        ['9', '14', '19', '24', '34'],
        ['8.5', '13.5', '18.5', '23.5', '33.5'],
        ['8', '13', '18', '23', '33'],
        ['7.5', '12.5', '17.5', '22.5', '32.5'],
        ['7', '12', '17', '22', '32'],
        ['6.5', '11.5', '16.5', '21.5', '31.5'],
        ['6', '11', '16', '21', '31'],
        ['5.5', '10.5', '15.5', '20.5', '30.5'],
        ['5', '10', '15', '20', '30'],
        ['4.5', '9.5', '14.5', '19.5', '29.5'],
        ['4', '9', '14', '19', '29'],
        ['3.5', '8.5', '13.5', '18.5', '28.5'],
        ['3', '8', '13', '18', '28'],
        ['2.5', '7.5', '12.5', '17.5', '27.5'],
        ['2', '7', '12', '17', '27'],
        ['1.5', '6.5', '11.5', '16.5', '26.5'],
        ['1', '6', '11', '16', '26'],
        ['0.5', '5.5', '10.5', '15.5', '25.5'],
        ['0', '5', '10', '15', '25'],
      ],
    },
    [code('art.77')],
  ),
  version('ro.payroll.supplementary_deduction', { youngPercent: '15', perChild: '100' }, [
    code('art.77'),
  ]),
  version(
    'ro.payroll.minimum_wage_relief',
    { amount: '300', grossCeiling: '4300' },
    ['OUG156/2024:salariul-minim', 'ANAF/D112-0726:salariul-minim'],
    '2026-01-01',
    '2026-06-30',
  ),
  version(
    'ro.payroll.minimum_wage_relief',
    { amount: '200', grossCeiling: '4600' },
    ['OUG89/2025:salariul-minim', 'ANAF/D112-0726:salariul-minim'],
    '2026-07-01',
    '2026-12-31',
  ),
  version('ro.payroll.tax_base_rounding', 'leu_half_down', [code('norme.art.64.pct.4')]),
  version('ro.payroll.amount_rounding', 'leu_half_up', ['L207/2015:rounding']),
];
