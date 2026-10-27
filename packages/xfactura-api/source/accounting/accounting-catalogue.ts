import { z } from 'zod';
import { canonical, dateSchema, requireCondition } from './domain';
import { sha256 } from './object-store';

// Draft calculation references. Independent interpretation/signing is a release gate.
const source = 'https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf';
const categorySource =
  'https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf';
export const accountingRules = [
  {
    id: 'ro-domestic-standard-2025-01',
    from: '2025-01-01',
    to: '2025-07-31',
    category: 'S',
    rate: '19',
    sources: [source],
  },
  {
    id: 'ro-domestic-standard-2025-08',
    from: '2025-08-01',
    to: '2026-12-31',
    category: 'S',
    rate: '21',
    sources: [source],
  },
  {
    id: 'ro-domestic-non-vat-2025-2026',
    from: '2025-01-01',
    to: '2026-12-31',
    category: 'O',
    rate: '0',
    sources: [categorySource],
  },
].map((rule) => ({ ...rule, hash: sha256(canonical(rule)), status: 'draft' as const }));
export const ruleOutput = z.object({
  id: z.string(),
  from: dateSchema,
  to: dateSchema,
  category: z.string(),
  rate: z.string(),
  sources: z.array(z.url()),
  hash: z.string(),
  status: z.literal('draft'),
});
export function invoiceRule(date: string, category: string) {
  const rule = accountingRules.find(
    (rule) => rule.category === category && date >= rule.from && date <= rule.to,
  );
  requireCondition(
    rule,
    'UNSUPPORTED_TREATMENT',
    'Data sau categoria TVA necesită un tratament separat.',
  );
  return rule;
}

// Metadata only: applicability is not inferred from the existence of this catalogue.
export const obligationCatalogue = [
  ['D100', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/100.html'],
  ['D101', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/101.html'],
  ['D112', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/112.html'],
  ['D300', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/300.html'],
  ['D301', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/301.html'],
  ['D390', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/390.html'],
  ['D394', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/394.html'],
  ['D406', 'https://static.anaf.ro/static/10/Anaf/Informatii_R/saf_t.htm'],
  ['D205', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/205.html'],
  ['D207', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/207.html'],
  ['D107', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/107.html'],
  ['D700', 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/700.html'],
  [
    'ANNUAL_STATEMENTS',
    'https://static.anaf.ro/static/10/Anaf/Declaratii_R/situatiifinanciare/2025/1002_5_2025.html',
  ],
].map(([id, source]) => ({ id, source, status: 'not_implemented' as const }));
export const obligationOutput = z.object({
  id: z.string(),
  source: z.url(),
  status: z.literal('not_implemented'),
});
