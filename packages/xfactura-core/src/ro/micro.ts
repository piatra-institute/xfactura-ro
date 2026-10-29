import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { parseLocalDate as date } from '../time';

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

export const microDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.micro.rate',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/),
    description: 'Cota impozitului pe veniturile microîntreprinderilor.',
  },
  {
    key: 'ro.micro.revenue_limit_eur',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z.string().regex(/^[1-9]\d*$/),
    description:
      'Plafonul veniturilor microîntreprinderii, în euro, la cursul de la închiderea exercițiului financiar precedent.',
  },
];

// Read in ANAF's consolidated Fiscal Code: in force from 2026-01-01; earlier years are a gap.
export const microVersions: ParameterVersion[] = [
  {
    id: 'ro.micro.rate/2026-01-01',
    key: 'ro.micro.rate',
    scope: {},
    value: '1',
    from: date('2026-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [code('art.51(1)')],
  },
  {
    id: 'ro.micro.revenue_limit_eur/2026-01-01',
    key: 'ro.micro.revenue_limit_eur',
    scope: {},
    value: '100000',
    from: date('2026-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [code('art.47(1)(c)'), code('art.52(1),(5)')],
  },
];
