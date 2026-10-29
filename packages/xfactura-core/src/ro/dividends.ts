import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { parseLocalDate as date } from '../time';

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

export const dividendDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.dividend.tax_rate',
    axis: 'distribution_decision_date',
    continuity: 'block',
    scope: ['beneficiary'],
    value: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/),
    description:
      'Cota impozitului pe dividende reținut la plată, după beneficiar: persoană fizică sau persoană juridică română.',
  },
];

// Read in ANAF's consolidated Fiscal Code: the 16% rates apply to dividends distributed from
// 2026-01-01 (Legea nr. 141/2025, art. VII); earlier distributions are a gap.
export const dividendVersions: ParameterVersion[] = (
  [
    ['individual', [code('art.97(7)')]],
    ['company', [code('art.43(2)')]],
  ] as const
).map(([beneficiary, clauses]) => ({
  id: `ro.dividend.tax_rate/${beneficiary}/2026-01-01`,
  key: 'ro.dividend.tax_rate',
  scope: { beneficiary },
  value: '16',
  from: date('2026-01-01'),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses: [...clauses],
}));
