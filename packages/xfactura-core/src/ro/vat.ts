import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { parseLocalDate as date } from '../time';

const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);

export const vatDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.rate',
    axis: 'vat_chargeability_date',
    continuity: 'attest_allowed',
    scope: ['category'],
    value: percent,
    description: 'Cota TVA aplicabilă unei categorii de taxare (EN 16931 BT-151).',
  },
  {
    key: 'ro.vat.rate.reduced',
    axis: 'vat_chargeability_date',
    continuity: 'attest_allowed',
    scope: [],
    value: percent,
    description:
      'Cota redusă de TVA. Operațiunile cărora li se aplică sunt o clasificare separată, pe linie.',
  },
  {
    key: 'ro.vat.deduction.limited',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Partea deductibilă a TVA pentru vehiculele rutiere motorizate care nu sunt utilizate exclusiv în scopul activității economice.',
  },
];

// Every version is `extracted`: its clauses (src/ro/sources) say where the value comes from, and
// an expert contabil reviews it before it supports posting or filing.
export const vatVersions: ParameterVersion[] = [
  {
    id: 'ro.vat.rate/S/2024-01-01',
    key: 'ro.vat.rate',
    scope: { category: 'S' },
    value: '19',
    from: date('2024-01-01'),
    to: date('2025-07-31'),
    reviewedThrough: null,
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['L227/2015:art.291(1)(a)', 'ANAF/Ploiesti-modificari-tva:cote'],
  },
  {
    id: 'ro.vat.rate/S/2025-08-01',
    key: 'ro.vat.rate',
    scope: { category: 'S' },
    value: '21',
    from: date('2025-08-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'L227/2015:art.291(1)(a)',
      'ANAF/Cod-fiscal-consolidat:art.291(1)',
      'L141/2025:rates',
      'ANAF/D300-12.0.0:rd.9',
      'ANAF/Ploiesti-modificari-tva:cote',
    ],
  },
  {
    id: 'ro.vat.rate/O/2024-01-01',
    key: 'ro.vat.rate',
    scope: { category: 'O' },
    value: '0',
    from: date('2024-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['ANAF/ghid-coduri-facturi-2.9:O'],
  },
  {
    id: 'ro.vat.rate.reduced/2025-08-01',
    key: 'ro.vat.rate.reduced',
    scope: {},
    value: '11',
    from: date('2025-08-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'L227/2015:art.291(2)',
      'ANAF/Cod-fiscal-consolidat:art.291(2)',
      'L141/2025:rates',
      'ANAF/D300-12.0.0:rd.10',
      'ANAF/Ploiesti-modificari-tva:cote',
    ],
  },
  {
    id: 'ro.vat.deduction.limited/2016-01-01',
    key: 'ro.vat.deduction.limited',
    scope: {},
    value: '50',
    from: date('2016-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['ANAF/Cod-fiscal-consolidat:art.298'],
  },
];
