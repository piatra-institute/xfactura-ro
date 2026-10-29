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
];

// Transcribed from the previous draft catalogue and extended to 2024 for the pilot's history.
// None of these versions has been checked against the official text: every one is `extracted`
// and must be sourced and reviewed before it supports posting or filing.
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
    clauses: [
      'L227/2015 art. 291 alin. (1) lit. a), forma în vigoare până la 31.07.2025 (TO-SOURCE)',
    ],
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
      'L227/2015 art. 291 alin. (1) lit. a), modificat cu efect de la 01.08.2025 (TO-SOURCE: actul modificator)',
      'https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf',
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
    clauses: [
      'Categoria O (neplătitor de TVA / în afara sferei): https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf',
    ],
  },
];
