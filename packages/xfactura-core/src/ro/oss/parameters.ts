import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';
import { memberStateRates } from './rates';
import { tedbRates } from './rates-data';

/*
 * The legal values of distance sales and the One Stop Shop (docs/ACCOUNTING_ENGINE.md, "Sales to
 * consumers in other Member States"): the threshold of art. 278^1 and the option's two years, the
 * Member States' rates (TEDB), the Union scheme's return (quarterly, in euro, at the ECB's rate of
 * the period's last day, corrections in a later return within three years), the account its VAT
 * is owed on, where the domestic returns report these sales, and the import scheme's limits.
 * Every version is `extracted`, read on 5 November 2026; the expert contabil reviews each
 * (src/ro/reviews/specs/oss.ts).
 */

const account = z.string().regex(/^[1-9]\d{2,3}$/);

const threshold = z
  .object({
    /** The threshold of art. 278^1 alin. (1) lit. c), in euro. */
    eur: z.string().regex(/^[1-9]\d*$/),
    /** Its equivalent in lei, fixed by alin. (5): the sales are counted in lei. */
    lei: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();
export type DistanceThreshold = z.infer<typeof threshold>;

const ossReturn = z
  .object({
    /** The Union scheme's return covers a calendar quarter (art. 315 alin. (6)). */
    period: z.literal('quarter'),
    currency: z.literal('EUR'),
    /** Amounts in another currency at the ECB's rate published for the period's last day, or
     * the next publication when it publishes none that day (art. 315 alin. (12)). */
    fx: z
      .object({
        source: z.literal('ECB'),
        date: z.literal('period_end'),
        fallback: z.literal('next_publication'),
      })
      .strict(),
    /** Changes to a filed return go into a later one, within this many years of the first
     * one's deadline (alin. (11)); ANAF's structure admits no rectifying return (d_rec = 0). */
    correctionYears: z.number().int().min(1).max(10),
  })
  .strict();
export type OssReturnRule = z.infer<typeof ossReturn>;

const declarations = z
  .object({
    /** The D300 row of the Union scheme's sales: none, as ANAF's SAF-T sheet maps code 310340
     * to D398 alone, or rd. 3 (base only), as the order's general wording of rd. 3 reads. */
    d300: z.enum(['none', 'R3']),
    /** D394 lists the taxable operations on the national territory: the place of these sales is
     * abroad. */
    d394: z.literal('none'),
    /** The SAF-T TaxCode of a sale declared in the Union scheme. */
    d406: z.literal('310340'),
  })
  .strict();
export type OssDeclarations = z.infer<typeof declarations>;

const ioss = z
  .object({
    /** The intrinsic value of a consignment the import scheme covers (art. 315^2 alin. (1)). */
    consignmentLimitEur: z.string().regex(/^[1-9]\d*$/),
    /** Its return is monthly (alin. (18)). */
    period: z.literal('month'),
  })
  .strict();

export const ossDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.distance.threshold',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: threshold,
    description:
      'Pragul de la art. 278^1 alin. (1) lit. c) pentru vânzările intracomunitare de bunuri la distanță și serviciile de telecomunicații, radiodifuziune, televiziune și cele furnizate pe cale electronică către persoane neimpozabile din alte state membre: sub el, în anul curent și în cel precedent, locul rămâne în România.',
  },
  {
    key: 'ro.vat.distance.option_years',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z.number().int().min(1).max(10),
    description:
      'Numărul minim de ani calendaristici pentru care se aplică opțiunea de impozitare la destinație a furnizorului sub prag (art. 278^1 alin. (3)).',
  },
  {
    key: 'ro.vat.oss.rates',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: ['country'],
    value: memberStateRates,
    description:
      'Cotele de TVA ale unui stat membru de consum: cota standard și cotele reduse, super-reduse și de parcare, cu categoriile cărora li se aplică, după baza de date TEDB a Comisiei Europene.',
  },
  {
    key: 'ro.vat.oss.return',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: ossReturn,
    description:
      'Declarația specială de TVA a regimului Uniune (formularul 398): perioada, moneda, cursul de schimb și termenul în care se corectează o declarație depusă.',
  },
  {
    key: 'ro.vat.oss.payable_account',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: account,
    description:
      'Contul pe care se înregistrează TVA datorată statelor membre de consum prin regimul special Uniune, de plătit în euro în contul special indicat de ANAF (art. 315 alin. (13)).',
  },
  {
    key: 'ro.vat.oss.declarations',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: declarations,
    description:
      'Unde raportează decontul de TVA (300), declarația 394 și SAF-T (D406) vânzările declarate în regimul special Uniune.',
  },
  {
    key: 'ro.vat.ioss',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: ioss,
    description:
      'Regimul special de import (art. 315^2): valoarea intrinsecă maximă a unui lot și perioada declarației speciale.',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
  scope: Record<string, string> = {},
  to: string | null = null,
): ParameterVersion => ({
  id: `${key}/${Object.values(scope)
    .map((item) => `${item}/`)
    .join('')}${from}`,
  key,
  scope,
  value,
  from: date(from),
  to: to === null ? null : date(to),
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});
const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const dayBefore = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * As the texts read on 5 November 2026 give them. The Fiscal Code is read in ANAF's consolidated
 * text (in force): its values start on 1 January 2026, earlier years are a gap; so do the rates,
 * read in TEDB from that date.
 */
export const ossVersions: ParameterVersion[] = [
  version(
    'ro.vat.distance.threshold',
    { eur: '10000', lei: '46337' },
    [
      code('art.278^1(1)-(2)'),
      code('art.278^1(5)'),
      code('art.275(2)'),
      code('art.278(5)(h)'),
      'OPANAF174/2026:rd.17-18',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.distance.option_years',
    2,
    [code('art.278^1(3)'), 'OPANAF1699/2021:art.7(e)'],
    '2026-01-01',
  ),
  ...Object.entries(tedbRates).flatMap(([country, versions]) =>
    versions.map((item, index) =>
      version(
        'ro.vat.oss.rates',
        memberStateRates.parse(item.value),
        ['EC/TEDB:rates-2026', code('art.315(7)-(10)')],
        item.from,
        { country },
        index + 1 < versions.length ? dayBefore(versions[index + 1]!.from) : null,
      ),
    ),
  ),
  version(
    'ro.vat.oss.return',
    {
      period: 'quarter',
      currency: 'EUR',
      fx: { source: 'ECB', date: 'period_end', fallback: 'next_publication' },
      correctionYears: 3,
    },
    [
      code('art.315(6)-(6^1)'),
      code('art.315(11)'),
      code('art.315(12)-(13)'),
      'ANAF/D398:structura',
      'ECB/eurofxref:reference-rates',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.oss.payable_account',
    '4423',
    [code('art.315(12)-(13)'), 'OMFP1802/2014:cont.4423'],
    '2026-01-01',
  ),
  version(
    'ro.vat.oss.declarations',
    { d300: 'none', d394: 'none', d406: '310340' },
    ['ANAF/D406:Livrari.310340-310346', 'OPANAF174/2026:rd.3', 'OPANAF3769/2015:anexa2.sect2'],
    '2026-01-01',
  ),
  version(
    'ro.vat.ioss',
    { consignmentLimitEur: '150', period: 'month' },
    [code('art.315^2(1)-(3)'), code('art.315^2(18)-(23)')],
    '2026-01-01',
  ),
];
