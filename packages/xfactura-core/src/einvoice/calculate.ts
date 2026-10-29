import { DomainError } from '../errors';
import { divRound, formatScaled, parseScaled } from '../money/decimal';
import {
  CIUS_RO,
  invoiceDraftSchema,
  invoiceFieldsSchema,
  type Adjustment,
  type AdjustmentDraft,
  type Invoice,
  type InvoiceDraft,
  type Line,
  type Vat,
  type VatBreakdown,
} from './model';

/**
 * Derives every amount of an invoice from its draft, in exact decimals. Rounding is half away
 * from zero to two decimals, applied once at each point EN 16931 defines an amount:
 *
 * - line base: quantity × net price ÷ base quantity (BT-129 × BT-146 ÷ BT-149);
 * - a percentage allowance or charge: base × percent ÷ 100 (BT-136 = BT-137 × BT-138);
 * - line net amount: base − allowances + charges (BT-131), already in cents;
 * - VAT per category and rate: taxable amount × rate ÷ 100 (BR-CO-17).
 *
 * Totals are exact sums of those amounts (BR-CO-10 to BR-CO-16), so the written document is
 * self-consistent. A document-level percentage applies to the line total of its VAT category.
 */
export function calculateInvoice(input: InvoiceDraft): Invoice {
  const { prepaid, rounding, ...draft } = invoiceDraftSchema.parse(input);
  return defined({
    ...draft,
    customization: CIUS_RO,
    ...calculateAmounts({ lines: draft.lines, adjustments: draft.adjustments, prepaid, rounding }),
  });
}

/** The amounts alone, for documents whose parties are not complete yet (a PDF, a list). */
export function calculateAmounts(
  input: Pick<InvoiceDraft, 'lines' | 'adjustments' | 'prepaid' | 'rounding'>,
): Pick<Invoice, 'lines' | 'adjustments' | 'vatBreakdown' | 'totals'> {
  const draft = amountsSchema.parse(input);
  const groups = new Map<string, { vat: Vat; taxable: bigint }>();
  // Lines and document adjustments state only the category and rate (BG-30, BT-95/BT-96); an
  // exemption reason belongs to the breakdown of its category (BT-120, BT-121).
  const group = (vat: Vat) => {
    const key = `${vat.category}|${vat.rate ?? ''}`;
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { vat: rated(vat), taxable: 0n }));
    for (const field of ['exemptionReason', 'exemptionCode'] as const) {
      if (vat[field] === undefined) continue;
      if (entry.vat[field] !== undefined && entry.vat[field] !== vat[field])
        throw new DomainError(
          'EINVOICE_EXEMPTION',
          `Categoria ${vat.category} are un singur motiv de scutire pe factură.`,
        );
      entry.vat = { ...entry.vat, [field]: vat[field] };
    }
    return entry;
  };

  const lines: Line[] = draft.lines.map((line, index) => {
    const base = lineBase(line.quantity, line.price, line.baseQuantity);
    const adjustments = line.adjustments.map((item) => resolve(item, base));
    const net = adjustments.reduce(
      (total, item) => total + (item.charge ? 1n : -1n) * cents(item.amount),
      base,
    );
    const vat = normalizeVat(line.vat);
    group(vat).taxable += net;
    return defined({
      ...line,
      vat: rated(vat),
      id: String(index + 1),
      adjustments,
      netAmount: money(net),
    });
  });

  const lineTotal = sum(lines.map((line) => line.netAmount));
  const adjustments = draft.adjustments.map(({ vat: entered, ...item }) => {
    const vat = normalizeVat(entered);
    const entry = group(vat);
    const resolved = resolve(item, entry.taxable);
    entry.taxable += (resolved.charge ? 1n : -1n) * cents(resolved.amount);
    return { ...resolved, vat: rated(vat) };
  });
  const allowances = sum(adjustments.filter((item) => !item.charge).map((item) => item.amount));
  const charges = sum(adjustments.filter((item) => item.charge).map((item) => item.amount));

  const vatBreakdown: VatBreakdown[] = [...groups.values()].map(({ vat, taxable }) =>
    defined({
      category: vat.category,
      rate: vat.rate,
      taxable: money(taxable),
      tax: money(taxOf(vat, taxable)),
      exemptionReason: vat.exemptionReason,
      exemptionCode: vat.exemptionCode,
    }),
  );
  const taxExclusive = lineTotal - allowances + charges;
  const tax = sum(vatBreakdown.map((item) => item.tax));
  const prepaid = cents(draft.prepaid ?? '0');
  const rounding = cents(draft.rounding ?? '0');

  return {
    adjustments,
    lines,
    vatBreakdown,
    totals: {
      lines: money(lineTotal),
      allowances: money(allowances),
      charges: money(charges),
      taxExclusive: money(taxExclusive),
      tax: money(tax),
      taxInclusive: money(taxExclusive + tax),
      prepaid: money(prepaid),
      rounding: money(rounding),
      payable: money(taxExclusive + tax - prepaid + rounding),
    },
  };
}

const amountsSchema = invoiceFieldsSchema.pick({
  lines: true,
  adjustments: true,
  prepaid: true,
  rounding: true,
});

const cents = (text: string) => parseScaled(text, 2);
const money = (value: bigint) => formatScaled(value, 2);
const sum = (amounts: string[]) => amounts.reduce((total, amount) => total + cents(amount), 0n);
const round = (numerator: bigint, denominator: bigint) =>
  divRound(numerator, denominator, 'halfAwayFromZero');

/** quantity (scale 6) × price (scale 8) ÷ base quantity (scale 6), in cents. */
export function lineBase(quantity: string, price: string, baseQuantity = '1'): bigint {
  const base = parseScaled(baseQuantity, 6);
  if (base <= 0n)
    throw new DomainError('EINVOICE_BASE_QUANTITY', 'Cantitatea de bază trebuie să fie pozitivă.');
  return round(parseScaled(quantity, 6) * parseScaled(price, 8), base * 10n ** 6n);
}

/** base (cents) × percent (scale 4) ÷ 100, in cents. */
export function percentOf(base: bigint, percent: string): bigint {
  return round(base * parseScaled(percent, 4), 1_000_000n);
}

function resolve(item: AdjustmentDraft, base: bigint): Adjustment {
  const { percent, amount, ...rest } = item;
  if (percent === undefined) return defined({ ...rest, amount: amount! });
  return defined({ ...rest, amount: money(percentOf(base, percent)), percent, base: money(base) });
}

const rated = (vat: Vat): Vat => defined({ category: vat.category, rate: vat.rate });

/** Zero-rated, exempt, reverse-charge, intra-EU and export categories state a 0 rate (BR-Z-05,
 * BR-E-05, BR-AE-05, BR-IC-05, BR-G-05); "not subject to VAT" states none (BR-O-05). */
function normalizeVat(vat: Vat): Vat {
  if (vat.category === 'O') {
    if (vat.rate !== undefined)
      throw new DomainError(
        'EINVOICE_VAT_RATE',
        'Operațiunile neimpozabile (O) nu au cotă de TVA.',
      );
    return vat;
  }
  if (['Z', 'E', 'AE', 'K', 'G'].includes(vat.category)) return { ...vat, rate: vat.rate ?? '0' };
  return vat;
}

/** Categories without a positive rate carry no VAT (BR-Z-08, BR-E-08, BR-AE-08, BR-IC-08,
 * BR-G-08, BR-O-08); the rest need one. */
function taxOf(vat: Vat, taxable: bigint): bigint {
  const rated = vat.category === 'S' || vat.category === 'L' || vat.category === 'M';
  if (!rated) {
    if (vat.rate !== undefined && parseScaled(vat.rate, 4) !== 0n)
      throw new DomainError('EINVOICE_VAT_RATE', `Categoria ${vat.category} nu are cotă de TVA.`);
    return 0n;
  }
  if (vat.rate === undefined || parseScaled(vat.rate, 4) <= 0n)
    throw new DomainError(
      'EINVOICE_VAT_RATE',
      `Categoria ${vat.category} are nevoie de o cotă pozitivă.`,
    );
  return round(taxable * parseScaled(vat.rate, 4), 1_000_000n);
}

/** Drops undefined properties, so a calculated invoice equals the same invoice read back. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
