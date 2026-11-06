import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The D406 parameters beyond its deadlines (src/ro/obligations): from when each category of
 * taxpayer files it, how the annual assets file reads the fields ANAF's documents disagree on,
 * and how the periodic file reports the sales declared in the Union scheme. All `extracted`, for
 * the expert contabil to review.
 */

const isoDate = z.iso.date();

/**
 * The reference dates of OPANAF nr. 1.783/2021 anexa nr. 5 pct. 1.1 (as OPANAF nr. 407/2025
 * replaced the annex): large taxpayers classified so in 2021 and on 1 January 2022 from that day
 * (lit. a)), those large from 1 January 2022 only from 1 July 2022 (lit. b)), medium taxpayers
 * from 1 January 2023 (lit. c), pct. 1.2 lit. b)), small taxpayers and the non-residents
 * registered only for VAT from 1 January 2025 (lit. d)–e)); one classified after its category's
 * date files from its classification (lit. g)), and one that has begun keeps filing (pct. 2).
 */
export const d406StartSchema = z
  .object({
    large: isoDate,
    largeFrom2022: isoDate,
    medium: isoDate,
    small: isoDate,
  })
  .strict();
export type D406Start = z.infer<typeof d406StartSchema>;

/** The readings of the annual assets file (core `saft/assets`, `D406AssetsPresentation`). */
export const d406AssetsPresentationSchema = z
  .object({
    percentage: z.enum(['percent', 'fraction']),
    disposal: z.enum(['gross', 'net']),
  })
  .strict();

/** How the periodic file reports a sale declared in the Union scheme (core `saft/tax-codes`,
 * `D406UnionSchemeReading`): its TaxCode, and the TaxTable's Country of a 310340 entry. */
export const d406OssSchema = z
  .object({
    code: z.enum(['310340', '310325']),
    country: z.enum(['consumer', 'RO']),
  })
  .strict();

export const saftDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.d406.start',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: d406StartSchema,
    description:
      'Data de la care fiecare categorie de contribuabili depune D406 (mari, mijlocii, mici), după anexa nr. 5 la OPANAF nr. 1.783/2021.',
  },
  {
    key: 'ro.d406.assets.presentation',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: d406AssetsPresentationSchema,
    description:
      'Cum se completează în declarația D406 pentru active rata de amortizare (în procente sau ca fracție) și ieșirile (valoarea brută sau netă).',
  },
  {
    key: 'ro.d406.oss',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: d406OssSchema,
    description:
      'Cum raportează D406 lunar sau trimestrial vânzările declarate în regimul special Uniune (D398): codul de taxă (310340 la cota statului de consum sau 310325 la 0%) și țara intrării 310340 din tabela de taxe (statul de consum sau RO).',
  },
];

export const saftVersions: ParameterVersion[] = [
  {
    id: 'ro.d406.start/2022-01-01',
    key: 'ro.d406.start',
    scope: {},
    value: {
      large: '2022-01-01',
      largeFrom2022: '2022-07-01',
      medium: '2023-01-01',
      small: '2025-01-01',
    },
    from: date('2022-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OPANAF407/2025:anexa5.pct.1-2'],
  },
  {
    // ANAF's answer to MF.A.26 (the rate in percent) and its worked examples' gross value that
    // left, as the asset account's credit turnover (Exemple_Imobilizari, Ex. 1–2).
    id: 'ro.d406.assets.presentation/2025-01-01',
    key: 'ro.d406.assets.presentation',
    scope: {},
    value: { percentage: 'percent', disposal: 'gross' },
    from: date('2025-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['ANAF/SAFT_FAQ_2022:MF.A.25-SD.AT.18', 'ANAF/SAFT_Ghid_2021:2.12'],
  },
  {
    // The sheet Livrari's 310340 (D398 column 1, the rate "În funcție de Cota TVA din statul
    // membru în care sa fac livrările"), the guide's TaxPercentage ("procentul de taxa aplicabil
    // pentru codul de taxă respectiv") and the answer to MF.TT.12 (RO the default, any ISO
    // 3166 code). From the first period the writer's validator parameters cover.
    id: 'ro.d406.oss/2025-07-01',
    key: 'ro.d406.oss',
    scope: {},
    value: { code: '310340', country: 'consumer' },
    from: date('2025-07-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'ANAF/D406:Livrari.310340-310346',
      'ANAF/D406:MF.TT.9-12',
      'ANAF/SAFT_Ghid_2021:2.5',
      'ANAF/SAFT_FAQ_2022:MF.TT.12',
    ],
  },
];
