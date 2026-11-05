import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';
import { defaultCatalogue, natureCatalogue } from './natures';

const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const lei = z.string().regex(/^[1-9]\d{0,15}$/);
const eur = z.string().regex(/^[1-9]\d{0,9}$/);
const wages = z.number().int().min(1).max(120);

export const lossRule = z
  .object({
    /** The share of a source's net income that carried losses may offset each year. */
    sharePercent: percent,
    /** The years after its own in which a loss may be offset. */
    years: z.number().int().min(1).max(10),
    /** Losses of years before this one keep the older window (D212 instructions). */
    legacyBefore: z.number().int().min(2000).max(2100),
    legacyYears: z.number().int().min(1).max(10),
  })
  .strict();
export type LossRule = z.infer<typeof lossRule>;

export const pitLimits = z
  .object({
    /** Art. 68 alin. (5) lit. a), b), c), q): percent of the alin. (6) base, of the salary costs,
     * of gross income. */
    scholarshipPercent: percent,
    protocolPercent: percent,
    socialPercent: percent,
    professionalPercent: percent,
    /** Art. 68 alin. (7) lit. k): the non-deductible share of costs of vehicles not used only for
     * the business; depreciation is outside it. */
    vehiclePercent: percent,
    /** Annual amounts in euro per person (lit. g), g^1), g^2), h), p), r), s)), converted at BNR's
     * average rate of the year of payment (norme pct. 7 alin. (6)). */
    associationEur: eur,
    pensionEur: eur,
    occupationalPensionEur: eur,
    peppEur: eur,
    healthEur: eur,
    sportEur: eur,
    etfEur: eur,
  })
  .strict();
export type PitLimits = z.infer<typeof pitLimits>;

export const normaRule = z
  .object({
    /** A norm is at least this many minimum wages in force on 1 January of the income year. */
    floorWages: wages,
    /** Which minimum wage the floor counts: the one in force on 1 January of the income year
     * (art. 69 alin. (3) from the income of 2026), or the one in force when the DGRFP set the norm
     * (the earlier wording, "în vigoare la momentul stabilirii acesteia"). */
    floorWage: z.enum(['january_1', 'when_set']),
    /** Gross income above this many euro (BNR's annual average) makes the real system mandatory
     * from the next year. */
    realAboveEur: eur,
  })
  .strict();
export type NormaRule = z.infer<typeof normaRule>;

export const casRule = z
  .object({
    /** CAS is due when the year's cumulated income reaches this many minimum wages. */
    thresholdWages: wages,
    /** The least chosen base: the lower for incomes up to the upper multiple, the upper above. */
    lowerBaseWages: wages,
    upperBaseWages: wages,
  })
  .strict();
export type CasRule = z.infer<typeof casRule>;

export const cassRule = z
  .object({
    /** Below this many minimum wages CASS is due on this base, unless an exception applies. */
    minimumWages: wages,
    /** The base is capped at this many minimum wages. */
    maximumWages: wages,
  })
  .strict();
export type CassRule = z.infer<typeof cassRule>;

export const cassOtherRule = z
  .object({
    /** Art. 170 alin. (2)–(3): CASS on the income of art. 155 alin. (1) lit. c)–h) (intellectual
     * property, rent, investments, other sources) is due from the first of these multiples of the
     * minimum wage, on a base of the band reached, ascending. */
    bandWages: z.array(wages).min(1).max(5),
  })
  .strict();
export type CassOtherRule = z.infer<typeof cassOtherRule>;

export const sourcesRule = z
  .object({
    /** How an expense common to several sources of one person may be split among them, as the
     * person states it with its document: `gross`, in proportion to each source's gross income;
     * `fixed`, by stated shares. No text sets a key (an expert question). */
    sharedKeys: z
      .array(z.enum(['gross', 'fixed']))
      .min(1)
      .max(2),
  })
  .strict();
export type SourcesRule = z.infer<typeof sourcesRule>;

export const cassOptionRule = z
  .object({
    /** The base of the CASS a person opts to pay (art. 180 alin. (2)): this many minimum wages in
     * force on 1 January of the year the option is for. */
    baseWages: wages,
  })
  .strict();
export type CassOptionRule = z.infer<typeof cassOptionRule>;

const yearly = (key: string, value: z.ZodType, description: string): ParameterDefinition => ({
  key,
  axis: 'fiscal_year_start',
  continuity: 'block',
  scope: [],
  value,
  description,
});

/** Parameters of the annual income tax and contributions of individuals with independent income,
 * selected by the first day of the income year. */
export const pitDefinitions: ParameterDefinition[] = [
  yearly('ro.pit.rate', percent, 'Cota impozitului pe venitul din activități independente.'),
  yearly(
    'ro.pit.rounding',
    z.enum(['leu_half_down']),
    'Rotunjirea sumelor la leu: fracțiunile de până la 50 de bani inclusiv se neglijează.',
  ),
  yearly(
    'ro.pit.loss',
    lossRule,
    'Reportarea pierderii fiscale pe sursă: cota din venitul net anual compensabilă și anii.',
  ),
  yearly(
    'ro.pit.limits',
    pitLimits,
    'Limitele cheltuielilor deductibile limitat și cota nedeductibilă pentru vehicule.',
  ),
  yearly(
    'ro.pit.norma',
    normaRule,
    'Norma de venit: nivelul minim în salarii minime și pragul de trecere la sistemul real.',
  ),
  yearly(
    'ro.pit.natures',
    natureCatalogue,
    'Natura încasărilor și plăților după cont, pentru registrele contabilității în partidă simplă.',
  ),
  yearly(
    'ro.min_wage.contributions',
    lei,
    'Salariul de bază minim brut pe țară în vigoare la 1 ianuarie al anului de realizare a venitului, pentru plafoanele și bazele CAS și CASS ale persoanelor fizice.',
  ),
  yearly(
    'ro.cas.rate',
    percent,
    'Cota CAS datorate de persoanele fizice cu venituri independente.',
  ),
  yearly(
    'ro.cas.independent',
    casRule,
    'Plafonul și bazele minime ale CAS pentru veniturile din activități independente, în salarii minime.',
  ),
  yearly(
    'ro.cass.rate',
    percent,
    'Cota CASS datorate de persoanele fizice cu venituri independente.',
  ),
  yearly(
    'ro.cass.independent',
    cassRule,
    'Baza minimă și plafonul CASS pentru veniturile din activități independente, în salarii minime.',
  ),
  yearly(
    'ro.cass.other',
    cassOtherRule,
    'Pragurile și bazele CASS pentru veniturile din drepturi de proprietate intelectuală, cedarea folosinței bunurilor, investiții și alte surse (art. 155 alin. (1) lit. c)–h)), în salarii minime.',
  ),
  yearly(
    'ro.pit.sources',
    sourcesRule,
    'Cheile admise pentru repartizarea cheltuielilor comune mai multor surse de venit ale aceleiași persoane.',
  ),
  yearly(
    'ro.cass.option',
    cassOptionRule,
    'Baza CASS datorate de persoanele fizice care optează pentru plata contribuției (art. 180), în salarii minime, după anul pentru care optează.',
  ),
];

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * Read in ANAF's consolidated Fiscal Code (in force from 2026-01-01: the snapshot shows the text
 * in force, not since when) and in the texts that set a year's values. Income years before 2026
 * are a gap except where a text read states the earlier value. Every version is `extracted`.
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

/**
 * Income of 2025 (the D212 filed in 2026): the values the instructions of OPANAF nr. 2736/2025
 * state for it, and art. 66 and 68 alin. (2)–(7) as consolidated for 2026. No amendment to these
 * was found in OUG nr. 156/2024, Legea nr. 141/2025, Legea nr. 239/2025 (which changes only art.
 * 68 alin. (1), for art. 68^3) or Legea nr. 204/2026; the expert confirms.
 */
const income2025 = (key: string, value: ParameterVersion['value'], clauses: string[]) =>
  version(key, value, clauses, '2025-01-01', '2025-12-31');

export const pitVersions: ParameterVersion[] = [
  income2025('ro.pit.rate', '10', ['OPANAF2736/2025:instr.cap.I.rd.9', code('art.64(1)(a)')]),
  income2025('ro.pit.rounding', 'leu_half_down', [code('art.66')]),
  income2025('ro.pit.loss', { sharePercent: '70', years: 5, legacyBefore: 2024, legacyYears: 7 }, [
    'OPANAF2736/2025:instr.cap.I.rd.6',
    code('art.118(4)-(5)'),
  ]),
  income2025('ro.cas.rate', '25', ['OPANAF2736/2025:instr.pct.46', code('art.138(a)')]),
  income2025('ro.cas.independent', { thresholdWages: 12, lowerBaseWages: 12, upperBaseWages: 24 }, [
    'OPANAF2736/2025:instr.pct.43',
    'OPANAF2736/2025:instr.pct.46',
  ]),
  income2025('ro.cass.rate', '10', ['OPANAF2736/2025:instr.pct.47.1', code('art.156')]),
  version('ro.pit.rate', '10', [code('art.64(1)(a)'), code('art.69^2')]),
  version('ro.pit.rounding', 'leu_half_down', [code('art.66')]),
  version('ro.pit.loss', { sharePercent: '70', years: 5, legacyBefore: 2024, legacyYears: 7 }, [
    code('art.118(4)-(5)'),
    'OPANAF2736/2025:instr.cap.I.rd.6',
  ]),
  version(
    'ro.pit.limits',
    {
      scholarshipPercent: '5',
      protocolPercent: '2',
      socialPercent: '5',
      professionalPercent: '5',
      vehiclePercent: '50',
      associationEur: '4000',
      pensionEur: '400',
      occupationalPensionEur: '400',
      peppEur: '400',
      healthEur: '400',
      sportEur: '100',
      etfEur: '400',
    },
    [code('art.68(5)-(6)'), code('art.68(7)'), code('norme.art.68.pct.7(6)-(7)')],
  ),
  version('ro.pit.norma', { floorWages: 12, floorWage: 'january_1', realAboveEur: '25000' }, [
    code('art.69(3),(9)'),
    'L239/2025:art.XII.pct.6',
    'L239/2025:art.XIII',
  ]),
  // Income of 2025: art. 69 alin. (3) before Legea nr. 239/2025 (the portal's 2025 consolidated
  // Code; the new wording applies from the income of 2026, art. XIII alin. (2) lit. b)), and alin.
  // (9) as OUG nr. 128/2024 rewrote it from the income of 2025.
  income2025('ro.pit.norma', { floorWages: 12, floorWage: 'when_set', realAboveEur: '25000' }, [
    'LJR/Cod-fiscal-2025:art.69(3)',
    'OUG128/2024:art.I.pct.1',
  ]),
  version('ro.pit.natures', defaultCatalogue, [
    code('art.68(2)-(3)'),
    code('art.68(4)'),
    code('art.68(5)-(6)'),
    code('art.68(7)'),
    'OMFP3254/2017:art.4-5',
    'OMFP170/2015:cap.V.14-1-1',
  ]),
  income2025(
    'ro.pit.limits',
    {
      scholarshipPercent: '5',
      protocolPercent: '2',
      socialPercent: '5',
      professionalPercent: '5',
      vehiclePercent: '50',
      associationEur: '4000',
      pensionEur: '400',
      occupationalPensionEur: '400',
      peppEur: '400',
      healthEur: '400',
      sportEur: '100',
      etfEur: '400',
    },
    [code('art.68(5)-(6)'), code('art.68(7)'), code('norme.art.68.pct.7(6)-(7)')],
  ),
  income2025('ro.pit.natures', defaultCatalogue, [
    code('art.68(2)-(3)'),
    code('art.68(4)'),
    code('art.68(5)-(6)'),
    code('art.68(7)'),
    'OMFP3254/2017:art.4-5',
    'OMFP170/2015:cap.V.14-1-1',
  ]),
  // The minimum wage on 1 January: HG nr. 146/2026 raised it from 1 July 2026, which does not
  // change the 2026 bases (art. 135^1 alin. (3)). 2027 has no version until its act is read.
  version(
    'ro.min_wage.contributions',
    '4050',
    ['HG1506/2024:art.1', code('art.135^1(3)')],
    '2025-01-01',
    '2025-12-31',
  ),
  version(
    'ro.min_wage.contributions',
    '4050',
    ['HG1506/2024:art.1', 'HG146/2026:art.1', code('art.135^1(3)')],
    '2026-01-01',
    '2026-12-31',
  ),
  version('ro.cas.rate', '25', [code('art.138(a)')]),
  version('ro.cas.independent', { thresholdWages: 12, lowerBaseWages: 12, upperBaseWages: 24 }, [
    code('art.148(1)-(4)'),
    code('art.150(1)'),
    'L239/2025:art.XII.pct.18',
  ]),
  version('ro.cass.rate', '10', [code('art.156')]),
  // Income of 2025: the cap of 60 minimum wages the D212 for 2025 applies; 72 from income of 2026.
  version(
    'ro.cass.independent',
    { minimumWages: 6, maximumWages: 60 },
    ['OPANAF2736/2025:instr.pct.47.1'],
    '2025-01-01',
    '2025-12-31',
  ),
  version('ro.cass.independent', { minimumWages: 6, maximumWages: 72 }, [
    code('art.170(1)'),
    code('art.174(1)-(8)'),
    'L239/2025:art.XII.pct.19',
    'L239/2025:art.XIII',
  ]),
  // The option for 2025: 6 minimum wages, 2,430 lei of CASS (the instructions of the D212 for
  // 2025's income); from 2026 the Code as consolidated.
  version(
    'ro.cass.option',
    { baseWages: 6 },
    ['OPANAF2736/2025:instr.pct.49.1.5'],
    '2025-01-01',
    '2025-12-31',
  ),
  version('ro.cass.option', { baseWages: 6 }, [code('art.180(2)')]),
  // Art. 170 alin. (2)–(3): 6, 12 and 24 minimum wages; the same bands in the D212 for 2025's
  // income (OPANAF nr. 2.736/2025 instr. pct. 51–52).
  income2025('ro.cass.other', { bandWages: [6, 12, 24] }, ['OPANAF2736/2025:instr.pct.51-52']),
  version('ro.cass.other', { bandWages: [6, 12, 24] }, [code('art.170(2)-(3)')]),
  // The register is kept per source (OMFP nr. 3.254/2017 art. 3 alin. (3)–(4), art. 4 alin. (1),
  // art. 5 alin. (1)); no text says how an expense serving several sources is split: the person
  // states a key, from those admitted here (`ro.pit.sources` review packet).
  income2025('ro.pit.sources', { sharedKeys: ['gross', 'fixed'] }, ['OMFP3254/2017:art.3-5']),
  version('ro.pit.sources', { sharedKeys: ['gross', 'fixed'] }, ['OMFP3254/2017:art.3-5']),
];
