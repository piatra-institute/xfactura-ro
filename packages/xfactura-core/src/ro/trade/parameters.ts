import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of EU goods, imports and exports (G3): when an intra-community acquisition's
 * and supply's VAT become chargeable, which VIES check and which transport documents justify an
 * intra-community supply, how long the proof of an exempt supply may wait, how an import is booked
 * and converted, INS's Intrastat thresholds, and the RO e-Transport declaration's days. Every
 * version is `extracted`, read on 5 November 2026; the readings the texts leave open have review
 * packets (src/ro/reviews/specs/trade.ts).
 */

const day = z.number().int().min(1).max(31);
const account = z.string().regex(/^[1-9]\d{2,3}$/);
const lei = z.string().regex(/^[1-9]\d*$/);

const acquisition = z
  .object({
    /** Without the supplier's invoice by then, the VAT is chargeable on this day of the month
     * after the chargeable event (art. 284 alin. (2)). */
    exigibilityDay: day,
  })
  .strict();
export type AcquisitionRule = z.infer<typeof acquisition>;

const supply = z
  .object({
    /** The same day for the exempt supply (art. 283 alin. (1)). */
    exigibilityDay: day,
    /** The days after the chargeable event the exemption's documents may follow (OMFP nr.
     * 103/2016 art. 1 alin. (4)). */
    proofDays: z.number().int().min(1).max(366),
  })
  .strict();
export type SupplyRule = z.infer<typeof supply>;

const vies = z
  .object({
    /** The VIES check the exemption relies on is dated by the VAT's chargeability (`exigibility`,
     * the invoice or the 15th of the next month) or by the chargeable event itself (`supply`). */
    checkBy: z.enum(['exigibility', 'supply']),
  })
  .strict();
export type ViesRule = z.infer<typeof vies>;

const transport = z
  .object({
    /** Art. 45a of Regulation (EU) No 282/2011 is a presumption (`safe_harbour`): without it the
     * transport is shown by other documents (OMFP nr. 103/2016 art. 10), which the reviewer
     * confirms; or the exemption needs it (`required`). */
    presumption: z.enum(['safe_harbour', 'required']),
    /** Non-contradictory items of evidence from two independent parties (art. 45a alin. (1)). */
    documents: z.number().int().min(1).max(5),
    /** The buyer's written statement reaches the seller by this day of the month after the
     * supply (art. 45a alin. (1) lit. (b), last paragraph). */
    buyerStatementDay: day,
  })
  .strict();
export type TransportRule = z.infer<typeof transport>;

const imports = z
  .object({
    /** The account of the customs debt: the duties of imported goods (the function of 446) and
     * the import VAT paid at customs, an item of the customs authority until paid. */
    customsAccount: account,
    /** The rate the supplier's invoice in a currency is booked at: its issue date's BNR rate,
     * as every invoice (`invoice_date`), or the customs rate of the declaration (`customs`). */
    invoiceRate: z.enum(['invoice_date', 'customs']),
    /** The grounds of art. 326 alin. (4) the engine books without payment at customs. */
    deferral: z.array(z.literal('art.326(4)(a)')).min(1),
  })
  .strict();
export type ImportRule = z.infer<typeof imports>;

const exportProof = z
  .object({
    /** The days the customs certification of the exit may follow the supply (OMFP nr. 103/2016
     * art. 1 alin. (4)). */
    proofDays: z.number().int().min(1).max(366),
  })
  .strict();
export type ExportProofRule = z.infer<typeof exportProof>;

const intrastatThresholds = z
  .object({
    /** Introduceri (arrivals), in lei, per calendar year. */
    arrivals: lei,
    /** Expedieri (dispatches), in lei. */
    dispatches: lei,
  })
  .strict();
export type IntrastatThresholds = z.infer<typeof intrastatThresholds>;

const etransport = z
  .object({
    /** The data are declared at most this many calendar days before the transport's declared
     * start (OUG nr. 41/2022 art. 11 alin. (1)). */
    declareDaysBefore: z.number().int().min(0).max(30),
    /** The UIT code is valid this many calendar days from the declared start (alin. (2)). */
    validityDays: z.number().int().min(1).max(60),
  })
  .strict();
export type ETransportRule = z.infer<typeof etransport>;

export const tradeDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.intra_eu.acquisition',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: acquisition,
    description:
      'Exigibilitatea TVA pentru achiziția intracomunitară de bunuri: data facturii furnizorului sau ziua din luna următoare faptului generator, dacă nu s-a emis factură până atunci (art. 284 alin. (2)).',
  },
  {
    key: 'ro.vat.intra_eu.supply',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: supply,
    description:
      'Exigibilitatea livrării intracomunitare scutite (art. 283 alin. (1)) și termenul în care se prezintă documentele de justificare a scutirii (OMFP nr. 103/2016 art. 1 alin. (4)).',
  },
  {
    key: 'ro.vat.intra_eu.vies',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: vies,
    description:
      'Până la ce dată trebuie să fie verificat în VIES codul de TVA al cumpărătorului unei livrări intracomunitare: exigibilitatea sau faptul generator.',
  },
  {
    key: 'ro.vat.intra_eu.transport',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: transport,
    description:
      'Dovada transportului în alt stat membru: prezumția art. 45a din Regulamentul (UE) nr. 282/2011 (două dovezi independente necontradictorii, declarația cumpărătorului) și locul ei între documentele OMFP nr. 103/2016.',
  },
  {
    key: 'ro.vat.import',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: imports,
    description:
      'Importul de bunuri: contul datoriei vamale (taxe vamale și TVA plătită în vamă), cursul la care se înregistrează factura furnizorului în valută și temeiurile art. 326 alin. (4) acoperite.',
  },
  {
    key: 'ro.vat.export.proof',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: exportProof,
    description:
      'Termenul în care se prezintă certificarea ieșirii bunurilor exportate (OMFP nr. 103/2016 art. 1 alin. (4), art. 2 alin. (2)).',
  },
  {
    key: 'ro.intrastat.thresholds',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: intrastatThresholds,
    description:
      'Pragurile valorice Intrastat ale anului de referință, separat pentru introduceri și expedieri (ordinul anual al președintelui INS).',
  },
  {
    key: 'ro.etransport',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: etransport,
    description:
      'RO e-Transport: câte zile înainte de începerea transportului se pot declara datele și cât este valabil codul UIT (OUG nr. 41/2022 art. 11).',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
  to: string | null = null,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: to === null ? null : date(to),
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});
const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * As the texts read on 5 November 2026 give them. The Fiscal Code is read in ANAF's consolidated
 * text (in force), so its values start on 1 January 2026; INS's thresholds are its orders for
 * 2025 and 2026; RO e-Transport's days are the ordinance's 2022 text, its consolidation not read.
 */
export const tradeVersions: ParameterVersion[] = [
  version(
    'ro.vat.intra_eu.acquisition',
    { exigibilityDay: 15 },
    [
      code('art.284(1)-(2)'),
      code('art.268(3)-(4)'),
      code('art.276(1),(5)'),
      code('art.326(2)-(5)'),
      'OPANAF174/2026:rd.5-6',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.intra_eu.supply',
    { exigibilityDay: 15, proofDays: 90 },
    [code('art.283(1)'), code('art.294(2)'), 'OMFP103/2016:art.1(4)', 'OPANAF174/2026:rd.1'],
    '2026-01-01',
  ),
  version(
    'ro.vat.intra_eu.vies',
    { checkBy: 'exigibility' },
    [
      code('art.294(2)'),
      code('art.283(1)'),
      'OMFP103/2016:art.10(1),(7)',
      'EC/VIES:checkVatNumber',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.intra_eu.transport',
    { presumption: 'safe_harbour', documents: 2, buyerStatementDay: 10 },
    ['REG282/2011-A:art.45a', 'OMFP103/2016:art.10(1),(7)'],
    '2026-01-01',
  ),
  version(
    'ro.vat.import',
    { customsAccount: '446', invoiceRate: 'invoice_date', deferral: ['art.326(4)(a)'] },
    [
      code('art.285(1)-(2)'),
      code('art.289(1)-(2)'),
      code('art.290(1)'),
      code('art.299(1)(c)-(e)'),
      code('art.326(2)-(5)'),
      'OMFP1802/2014:conturi.446',
      'OMFP1802/2014:conturi.442',
      'OPANAF174/2026:rd.7',
      'OPANAF174/2026:rd.24-25',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.export.proof',
    { proofDays: 90 },
    [code('art.294(1)'), 'OMFP103/2016:art.1(4)', 'OMFP103/2016:art.2(2)'],
    '2026-01-01',
  ),
  version(
    'ro.intrastat.thresholds',
    { arrivals: '1000000', dispatches: '1000000' },
    ['INS/Intrastat:praguri.2025', 'INS/Intrastat:norme.obligati'],
    '2025-01-01',
    '2025-12-31',
  ),
  version(
    'ro.intrastat.thresholds',
    { arrivals: '1000000', dispatches: '1000000' },
    ['INS/Intrastat:praguri.2026', 'INS/Intrastat:norme.obligati'],
    '2026-01-01',
  ),
  version(
    'ro.etransport',
    { declareDaysBefore: 3, validityDays: 5 },
    ['OUG41/2022:art.8', 'OUG41/2022:art.11', 'OUG41/2022:consolidat'],
    '2026-01-01',
  ),
];
