import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { parseLocalDate as date } from '../time';

export const procedureDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.declaration.rounding',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['half_up_leu']),
    description:
      'Rotunjirea la leu a impozitelor, contribuțiilor și a sumelor din declarații: sub 50 de bani prin reducere, de la 50 de bani prin majorare.',
  },
];

export const procedureVersions: ParameterVersion[] = [
  {
    id: 'ro.declaration.rounding/2016-01-01',
    key: 'ro.declaration.rounding',
    scope: {},
    value: 'half_up_leu',
    from: date('2016-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OUG59/2005:art.1(1)'],
  },
];
