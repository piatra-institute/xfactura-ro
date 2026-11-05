import { z } from 'zod';
import { hashOf } from '../../hash';
import { parseMoney } from '../../money';
import { dateSchema, moneySchema } from '../../values';

/*
 * The documents of goods across the border (G3), recorded with `documents.record` and checked
 * like every extraction (their arithmetic, the company as a party):
 * - `customs.declaration`: a customs declaration of import (DVI) or of export, with its MRN, the
 *   date the customs office accepted it, the invoices it covers, and per line the customs value,
 *   the duties and the VAT (art. 289) or, for an export, the certification of the exit (OMFP nr.
 *   103/2016 art. 2 alin. (2));
 * - `vies.check`: the answer of VIES about a VAT code on a date, as its REST service gives it
 *   (`parties.checkVies` records it from the response) or as its web page prints it.
 */

export const customsDocumentKind = 'customs.declaration';
export const viesDocumentKind = 'vies.check';
export const customsSchemaVersion = 'customs-declaration-1';
export const viesSchemaVersion = 'vies-check-1';

const lei = moneySchema;
const rate = z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/);
/** A Movement Reference Number: 18 characters, the year's two digits and the country first. */
const mrn = z.string().regex(/^\d{2}[A-Z]{2}[A-Z0-9]{14}$/);

const customsLine = z
  .object({
    description: z.string().min(1).max(500),
    /** The commodity code: the CN's 8 digits, or TARIC's 10. */
    commodity: z.string().regex(/^\d{8}(\d{2})?$/),
    /** The customs value of the line, in lei (art. 289 alin. (1)). */
    customsValue: lei,
    /** The customs duties (taxe vamale) and the other taxes due because of the import. */
    duty: lei,
    otherTaxes: lei.default('0.00'),
    /** The costs to the first destination in Romania not in the customs value (alin. (2)). */
    ancillary: lei.default('0.00'),
    /** The VAT base and VAT the declaration states (import only). */
    vatBase: lei.optional(),
    vatRate: rate.optional(),
    vat: lei.optional(),
    /** The country of origin (export: of dispatch). */
    origin: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();

const customsFields = {
  procedure: z.enum(['import', 'export']),
  mrn,
  /** The date the customs office accepted the declaration (the import's chargeable event,
   * art. 285; the export's customs formalities). */
  acceptedOn: dateSchema,
  office: z.string().min(2).max(200),
  /** The importer (import) or the exporter (export): the company. */
  declarant: z
    .object({
      name: z.string().min(1).max(500),
      taxId: z.string().min(1).max(100),
      country: z.literal('RO'),
    })
    .strict(),
  /** The supplier (import) or the consignee (export) abroad. */
  partner: z
    .object({
      name: z.string().min(1).max(500),
      country: z.string().regex(/^[A-Z]{2}$/),
      taxId: z.string().min(1).max(100).nullable().default(null),
    })
    .strict(),
  /** The invoices the declaration covers, as it lists them. */
  invoices: z
    .array(
      z
        .object({
          number: z.string().min(1).max(100),
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: moneySchema,
        })
        .strict(),
    )
    .min(1)
    .max(50),
  /** The rate the customs office converted the invoices at (art. 290 alin. (1)). */
  exchangeRate: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .nullable()
    .default(null),
  lines: z.array(customsLine).min(1).max(500),
  totals: z
    .object({
      customsValue: lei,
      duty: lei,
      otherTaxes: lei.default('0.00'),
      vatBase: lei.default('0.00'),
      vat: lei.default('0.00'),
    })
    .strict(),
  /** An import's VAT: paid at customs, or not paid there under art. 326 alin. (4) lit. a), the
   * deferral certificate's number on the declaration. */
  vatPayment: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('paid') }).strict(),
      z.object({ mode: z.literal('deferred'), certificate: z.string().min(1).max(100) }).strict(),
    ])
    .optional(),
  /** An export's exit: the certification of the export office (the exit notification of the
   * electronic declaration) and the office of exit. */
  exit: z
    .object({ certifiedOn: dateSchema, office: z.string().min(2).max(200) })
    .strict()
    .optional(),
};
const customsRules = <
  T extends z.ZodType<{ procedure: string; vatPayment?: unknown; exit?: unknown }>,
>(
  schema: T,
) =>
  schema
    .refine((value) => (value.procedure === 'import') === (value.vatPayment !== undefined), {
      message: 'Declarația de import arată cum s-a achitat TVA (vatPayment); cea de export nu.',
      path: ['vatPayment'],
    })
    .refine((value) => value.procedure === 'export' || value.exit === undefined, {
      message: 'Certificarea ieșirii (exit) privește doar exportul.',
      path: ['exit'],
    });
export const customsDeclarationSchema = customsRules(
  z.object({ parserVersion: z.literal(customsSchemaVersion), ...customsFields }).strict(),
);
/** What an agent records: the schema version is the engine's. */
export const customsDeclarationInput = customsRules(
  z
    .object({
      parserVersion: z.literal(customsSchemaVersion).default(customsSchemaVersion),
      ...customsFields,
    })
    .strict(),
);
export type CustomsDeclaration = z.infer<typeof customsDeclarationSchema>;

const viesFields = {
  /** VIES's Member State code: EL for Greece, XI for Northern Ireland. */
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  vatNumber: z.string().regex(/^[A-Z0-9+*]{2,14}$/),
  /** The date VIES answered for: the request's date. */
  requestDate: dateSchema,
  valid: z.boolean(),
  name: z.string().max(500).nullable().default(null),
  address: z.string().max(1000).nullable().default(null),
  /** The consultation number VIES gives a requester that identified itself. */
  requestIdentifier: z.string().max(100).nullable().default(null),
  source: z.enum(['vies_api', 'vies_web']),
};
export const viesCheckSchema = z
  .object({ parserVersion: z.literal(viesSchemaVersion), ...viesFields })
  .strict();
export const viesCheckInput = z
  .object({
    parserVersion: z.literal(viesSchemaVersion).default(viesSchemaVersion),
    ...viesFields,
  })
  .strict();
export type ViesCheck = z.infer<typeof viesCheckSchema>;

export const isCustomsKind = (kind: string) => kind === customsDocumentKind;
export const isViesKind = (kind: string) => kind === viesDocumentKind;

/** The identity of a declaration (its MRN) and of a VIES answer (code, date, consultation). */
export function tradeIdentity(kind: string, body: unknown): string | null {
  if (isCustomsKind(kind)) {
    const parsed = customsDeclarationSchema.safeParse(body);
    return parsed.success ? hashOf(['customs.declaration', parsed.data.mrn]) : null;
  }
  if (isViesKind(kind)) {
    const parsed = viesCheckSchema.safeParse(body);
    if (!parsed.success) return null;
    const check = parsed.data;
    return hashOf([
      'vies.check',
      check.countryCode,
      check.vatNumber,
      check.requestDate,
      check.requestIdentifier ?? '',
    ]);
  }
  return null;
}

const bani = (value: string) => parseMoney(value, 'RON');

/** A declaration's own arithmetic: the totals add up its lines, an import line's VAT base is its
 * customs value with the duties, the other taxes and the ancillary costs (art. 289), and its VAT
 * the base at the rate, within a leu of the office's rounding. */
export function customsProblems(declaration: CustomsDeclaration): string[] {
  const problems: string[] = [];
  const sum = (pick: (line: CustomsDeclaration['lines'][number]) => string | undefined) =>
    declaration.lines.reduce((total, line) => total + bani(pick(line) ?? '0.00'), 0n);
  const totals = declaration.totals;
  if (sum((line) => line.customsValue) !== bani(totals.customsValue))
    problems.push('Valoarea în vamă totală nu este suma liniilor.');
  if (sum((line) => line.duty) !== bani(totals.duty))
    problems.push('Taxele vamale totale nu sunt suma liniilor.');
  if (sum((line) => line.otherTaxes) !== bani(totals.otherTaxes))
    problems.push('Celelalte taxe totale nu sunt suma liniilor.');
  if (declaration.procedure === 'import') {
    if (sum((line) => line.vatBase) !== bani(totals.vatBase))
      problems.push('Baza TVA totală nu este suma liniilor.');
    if (sum((line) => line.vat) !== bani(totals.vat))
      problems.push('TVA totală nu este suma liniilor.');
    declaration.lines.forEach((line, index) => {
      if (line.vatBase === undefined || line.vatRate === undefined || line.vat === undefined) {
        problems.push(`Linia ${index + 1}: declarația de import arată baza, cota și TVA.`);
        return;
      }
      const base =
        bani(line.customsValue) + bani(line.duty) + bani(line.otherTaxes) + bani(line.ancillary);
      if (base !== bani(line.vatBase))
        problems.push(
          `Linia ${index + 1}: baza TVA nu este valoarea în vamă cu taxele și cheltuielile accesorii (art. 289).`,
        );
      const expected =
        (bani(line.vatBase) * BigInt(Math.round(Number(line.vatRate) * 100))) / 10_000n;
      const difference = expected - bani(line.vat);
      if (difference > 100n || difference < -100n)
        problems.push(`Linia ${index + 1}: TVA nu este ${line.vatRate}% din bază.`);
    });
  }
  return problems;
}
