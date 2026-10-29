import { z } from 'zod';
import { formatScaled, parseDecimal } from '../money/decimal';
import { isLocalDate, type LocalDate } from '../time';

/**
 * The EN 16931 semantic invoice, restricted to what xFactura issues and reads, with CIUS-RO as
 * the customization. Field comments name the business terms (BT) and groups (BG). Amounts are
 * decimal strings: two decimals for amounts (BR-DEC), canonical minimal text for quantities,
 * prices and rates, so a model survives writing and reading unchanged.
 */
export const CIUS_RO = 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1';

/** Minimal decimal text: no trailing fraction zeros, no "-0". */
export function canonicalDecimal(text: string): string {
  const parsed = parseDecimal(text);
  let numerator = parsed.numerator;
  let scale = parsed.denominator.toString().length - 1;
  while (scale > 0 && numerator % 10n === 0n) {
    numerator /= 10n;
    scale -= 1;
  }
  return formatScaled(numerator, scale);
}

const decimal = (scale: number, signed: boolean) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^${signed ? '-?' : ''}(0|[1-9]\\d{0,14})(\\.\\d{1,${scale}})?$`), {
      message: `Folosiți un număr cu cel mult ${scale} zecimale.`,
    })
    .transform(canonicalDecimal);

export const amountSchema = z
  .string()
  .trim()
  .regex(/^-?(0|[1-9]\d{0,14})(\.\d{1,2})?$/, {
    message: 'Folosiți o sumă cu cel mult 2 zecimale.',
  })
  .transform((text) => formatScaled(toCents(text), 2));
export const quantitySchema = decimal(6, true);
/** BR-27: the net price shall not be negative. */
export const priceSchema = decimal(8, false);
export const percentSchema = decimal(4, false);
export const dateSchema = z.string().refine((text): boolean => isLocalDate(text), {
  message: 'Folosiți o dată calendaristică AAAA-LL-ZZ.',
}) as unknown as z.ZodType<LocalDate>;

function toCents(text: string): bigint {
  const { numerator, denominator } = parseDecimal(text);
  return (numerator * 100n) / denominator;
}

/** UNCL5305 VAT category codes allowed by EN 16931. */
export const vatCategories = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'] as const;
export type VatCategory = (typeof vatCategories)[number];

export const vatSchema = z
  .object({
    category: z.enum(vatCategories), // BT-151 / BT-95 / BT-102 / BT-118
    rate: percentSchema.optional(), // BT-152 / BT-96 / BT-103 / BT-119
    exemptionReason: z.string().trim().min(1).max(1000).optional(), // BT-120
    exemptionCode: z.string().trim().min(1).max(30).optional(), // BT-121 (VATEX)
  })
  .strict();
export type Vat = z.output<typeof vatSchema>;

export const addressSchema = z
  .object({
    lines: z.array(z.string().trim().min(1).max(150)).min(1).max(3), // BT-35, BT-36, BT-162
    city: z.string().trim().min(1).max(100), // BT-37
    postalCode: z.string().trim().min(1).max(20).optional(), // BT-38
    subdivision: z.string().trim().min(1).max(100).optional(), // BT-39; ISO 3166-2 for Romania
    country: z.string().regex(/^[A-Z]{2}$/), // BT-40
  })
  .strict();

export const partySchema = z
  .object({
    name: z.string().trim().min(1).max(200), // BT-27 / BT-44
    tradingName: z.string().trim().min(1).max(200).optional(), // BT-28 / BT-45
    identifier: z.string().trim().min(1).max(100).optional(), // BT-29 / BT-46
    legalId: z.string().trim().min(1).max(100).optional(), // BT-30 / BT-47
    vatId: z
      .string()
      .regex(/^[A-Z]{2}[0-9A-Z+*.]{2,13}$/, {
        message: 'Codul de TVA începe cu prefixul țării, de exemplu RO12345678.',
      })
      .optional(), // BT-31 / BT-48
    taxRegistrationId: z.string().trim().min(1).max(100).optional(), // BT-32, seller only
    legalForm: z.string().trim().min(1).max(200).optional(), // BT-33, seller only
    address: addressSchema, // BG-5 / BG-8
    contact: z
      .object({
        name: z.string().trim().min(1).max(100).optional(), // BT-41 / BT-56
        phone: z.string().trim().min(1).max(100).optional(), // BT-42 / BT-57
        email: z.string().trim().min(1).max(100).optional(), // BT-43 / BT-58
      })
      .strict()
      .optional(), // BG-6 / BG-9
  })
  .strict();
export type Party = z.output<typeof partySchema>;

const periodSchema = z
  .object({ start: dateSchema.optional(), end: dateSchema.optional() })
  .strict()
  .refine((period) => period.start || period.end, { message: 'Perioada are nevoie de o dată.' })
  .refine((period) => !period.start || !period.end || period.start <= period.end, {
    message: 'Perioada se termină înainte să înceapă.',
  });

/** An allowance or charge as entered: a fixed amount or a percentage of its base. */
export const adjustmentDraftSchema = z
  .object({
    charge: z.boolean(), // false: allowance (BG-20/BG-27), true: charge (BG-21/BG-28)
    reason: z.string().trim().min(1).max(1000).optional(), // BT-97 / BT-104 / BT-139 / BT-144
    reasonCode: z.string().trim().min(1).max(10).optional(), // BT-98 / BT-105 / BT-140 / BT-145
    amount: amountSchema.optional(),
    percent: percentSchema.optional(),
  })
  .strict()
  .refine((item) => (item.amount === undefined) !== (item.percent === undefined), {
    message: 'Indicați fie suma, fie procentul.',
  })
  .refine((item) => item.reason || item.reasonCode, { message: 'Indicați motivul.' });
export type AdjustmentDraft = z.output<typeof adjustmentDraftSchema>;

export const lineDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(200), // BT-153
    description: z.string().trim().min(1).max(1000).optional(), // BT-154
    note: z.string().trim().min(1).max(300).optional(), // BT-127
    quantity: quantitySchema, // BT-129
    unitCode: z.string().regex(/^[A-Z0-9]{2,3}$/), // BT-130, UN/ECE Recommendation 20
    price: priceSchema, // BT-146, net of VAT
    baseQuantity: quantitySchema.optional(), // BT-149
    vat: vatSchema, // BG-30
    adjustments: z.array(adjustmentDraftSchema).max(20).default([]),
    period: periodSchema.optional(), // BG-26
    classification: z
      .object({ code: z.string().min(1).max(30), scheme: z.string().min(1).max(10) })
      .strict()
      .optional(), // BT-158 (CPV "STI", combined nomenclature "TSP")
  })
  .strict();
export type LineDraft = z.output<typeof lineDraftSchema>;

export const typeCodes = ['380', '381'] as const; // commercial invoice, credit note

export const invoiceFieldsSchema = z
  .object({
    typeCode: z.enum(typeCodes), // BT-3
    number: z.string().trim().min(1).max(200), // BT-1
    issueDate: dateSchema, // BT-2
    dueDate: dateSchema.optional(), // BT-9
    taxPointDate: dateSchema.optional(), // BT-7
    taxPointCode: z.enum(['3', '35', '432']).optional(), // BT-8
    currency: z.string().regex(/^[A-Z]{3}$/), // BT-5
    vatCurrency: z.literal('RON').optional(), // BT-6
    vatAccountingTotal: amountSchema.optional(), // BT-111
    notes: z.array(z.string().trim().min(1).max(300)).max(20).default([]), // BG-1, BR-RO-A020
    buyerReference: z.string().trim().min(1).max(200).optional(), // BT-10
    contractReference: z.string().trim().min(1).max(200).optional(), // BT-12
    orderReference: z.string().trim().min(1).max(200).optional(), // BT-13
    precedingInvoices: z
      .array(
        z
          .object({ number: z.string().trim().min(1).max(200), issueDate: dateSchema.optional() })
          .strict(),
      )
      .max(500)
      .default([]), // BG-3
    invoicingPeriod: periodSchema.optional(), // BG-14
    seller: partySchema, // BG-4
    buyer: partySchema, // BG-7
    deliveryDate: dateSchema.optional(), // BT-72
    payment: z
      .object({
        meansCode: z.string().regex(/^[0-9A-Z]{1,3}$/), // BT-81, UNCL4461
        reference: z.string().trim().min(1).max(140).optional(), // BT-83
        accounts: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(50), // BT-84
                name: z.string().trim().min(1).max(200).optional(), // BT-85
                bank: z.string().trim().min(1).max(50).optional(), // BT-86
              })
              .strict(),
          )
          .max(10)
          .default([]),
        terms: z.string().trim().min(1).max(1000).optional(), // BT-20
      })
      .strict()
      .optional(), // BG-16
    adjustments: z
      .array(adjustmentDraftSchema.and(z.object({ vat: vatSchema })))
      .max(100)
      .default([]), // BG-20 / BG-21
    lines: z.array(lineDraftSchema).min(1).max(999), // BG-25
    prepaid: amountSchema.optional(), // BT-113
    rounding: amountSchema.optional(), // BT-114
  })
  .strict();
export const invoiceDraftSchema = invoiceFieldsSchema.refine(
  (draft) => !(draft.taxPointDate && draft.taxPointCode),
  {
    message: 'Data exigibilității și codul ei se exclud reciproc (BR-CO-03).',
    path: ['taxPointCode'],
  },
);
export type InvoiceDraft = z.input<typeof invoiceDraftSchema>;
export type ParsedDraft = z.output<typeof invoiceDraftSchema>;

export type Adjustment = {
  charge: boolean;
  reason?: string;
  reasonCode?: string;
  amount: string; // BT-92 / BT-99 / BT-136 / BT-141
  percent?: string; // BT-94 / BT-101 / BT-138 / BT-143
  base?: string; // BT-93 / BT-100 / BT-137 / BT-142
};

export type Line = Omit<LineDraft, 'adjustments'> & {
  id: string; // BT-126
  adjustments: Adjustment[];
  netAmount: string; // BT-131
};

export type VatBreakdown = {
  category: VatCategory; // BT-118
  rate?: string; // BT-119
  taxable: string; // BT-116
  tax: string; // BT-117
  exemptionReason?: string; // BT-120
  exemptionCode?: string; // BT-121
};

export type Totals = {
  lines: string; // BT-106
  allowances: string; // BT-107
  charges: string; // BT-108
  taxExclusive: string; // BT-109
  tax: string; // BT-110
  taxInclusive: string; // BT-112
  prepaid: string; // BT-113
  rounding: string; // BT-114
  payable: string; // BT-115
};

/** A complete invoice: the draft with every derived amount. */
export type Invoice = Omit<ParsedDraft, 'lines' | 'adjustments' | 'prepaid' | 'rounding'> & {
  customization: string; // BT-24
  adjustments: (Adjustment & { vat: Vat })[];
  lines: Line[];
  vatBreakdown: VatBreakdown[]; // BG-23
  totals: Totals; // BG-22
};
