import { z } from 'zod';
import { DomainError } from '../errors';
import { divRound, formatScaled, parseScaled } from '../money/decimal';
import { isValidCnp, isValidCui } from '../ro/identifiers';
import { bucharestDate, utcDate } from '../time';
import { bucharestSector, countryCode, countyCode, euVatPrefixes } from '../ro/geo';
import { calculateAmounts } from './calculate';
import { canonicalDecimal, type InvoiceDraft, type LineDraft, type Party } from './model';

/**
 * Documents as the browser invoicer stores and exports them (`xfactura-web/data/interfaces.ts`).
 * Older records omit `vatPayer` and hold some amounts as strings.
 */
const numberLike = z.union([z.number(), z.string()]);
export const invoicerCompanySchema = z.object({
  name: z.string(),
  vatNumber: z.string(),
  vatPayer: z.boolean().nullish(),
  address: z.string(),
  city: z.string(),
  county: z.string(),
  country: z.string(),
  IBAN: z.string().optional(),
});
export const invoicerInvoiceSchema = z.object({
  id: z.string(),
  seller: invoicerCompanySchema,
  buyer: invoicerCompanySchema,
  metadata: z.object({
    number: z.union([z.string(), z.number()]).transform(String),
    currency: z.string(),
    issueDate: z.number(),
    dueDate: z.number(),
  }),
  products: z.array(
    z.object({
      name: z.string(),
      price: numberLike,
      quantity: numberLike,
      vatRate: z.number(),
      vatIncluded: z.boolean().optional(),
      allowance: z
        .looseObject({ amount: numberLike, reason: z.string(), fixedAmount: z.boolean() })
        .nullish(),
    }),
  ),
});
export type InvoicerInvoice = z.input<typeof invoicerInvoiceSchema>;
export type InvoicerCompany = z.input<typeof invoicerCompanySchema>;

/** Where the conversion departs from the previous PHP generator or interprets a field. */
export type ConversionNote = {
  code:
    | 'DATE_SHIFTED'
    | 'VAT_ID_RECOGNIZED'
    | 'VAT_PREFIX_ADDED'
    | 'CUI_CHECKSUM'
    | 'PERSONAL_ID'
    | 'GROSS_PRICE'
    | 'PAYMENT_ACCOUNT'
    | 'BUYER_VAT_ID_OMITTED';
  message: string;
};

/** Net prices derived from VAT-inclusive prices keep four decimals; the line amount is then
 * computed from the written price, so the document stays self-consistent. */
export const DERIVED_PRICE_SCALE = 4;

/**
 * Converts an invoicer document into an e-Factura draft. Unknown counties, countries or
 * Bucharest sectors are errors, never defaults. Notes record each interpretation.
 */
export function fromInvoicer(input: InvoicerInvoice): {
  draft: InvoiceDraft;
  notes: ConversionNote[];
} {
  const source = invoicerInvoiceSchema.parse(input);
  const notes: ConversionNote[] = [];
  const date = (instant: number, label: string) => {
    const local = bucharestDate(instant);
    const legacy = utcDate(instant);
    if (local !== legacy)
      notes.push({
        code: 'DATE_SHIFTED',
        message: `${label}: ${local} (ora României); generatorul anterior scria ${legacy}.`,
      });
    return local;
  };
  const seller = party(source.seller, 'vânzător', notes);
  const sellerPays = seller.vatId !== undefined;
  const buyer = party(source.buyer, 'cumpărător', notes);
  const iban = source.seller.IBAN?.replace(/\s/g, '').toUpperCase();
  if (iban)
    notes.push({
      code: 'PAYMENT_ACCOUNT',
      message: `Contul vânzătorului ${iban} apare ca instrucțiune de plată.`,
    });

  const lines = convertLines(
    source.products,
    (rate, index) => vatFor(rate, sellerPays, index),
    notes,
  );

  return {
    draft: {
      typeCode: '380',
      number: source.metadata.number.trim(),
      issueDate: date(source.metadata.issueDate, 'Data emiterii'),
      dueDate: date(source.metadata.dueDate, 'Data scadenței'),
      currency: source.metadata.currency.trim().toUpperCase(),
      seller,
      buyer: sellerPays ? buyer : withoutVatId(buyer, notes),
      ...(iban ? { payment: { meansCode: '30', accounts: [{ id: iban }] } } : {}),
      lines,
    },
    notes,
  };
}

/**
 * The amounts of an invoicer document whose parties may still be incomplete, for previews,
 * PDFs and lists: the same calculation as the e-Factura, with a positive rate read as
 * standard-rated and zero as outside the scope of VAT.
 */
export function invoicerAmounts(products: InvoicerInvoice['products']) {
  const parsed = invoicerInvoiceSchema.shape.products.parse(products);
  return calculateAmounts({
    lines: convertLines(
      parsed,
      (rate) => (rate === '0' ? { category: 'O' } : { category: 'S', rate }),
      [],
    ),
  });
}

function convertLines(
  products: z.output<typeof invoicerInvoiceSchema>['products'],
  vat: (rate: string, index: number) => LineDraft['vat'],
  notes: ConversionNote[],
): LineDraft[] {
  return products.map((product, index): LineDraft => {
    const rate = canonicalDecimal(String(product.vatRate));
    let price = decimalText(product.price, `prețul liniei ${index + 1}`);
    if (product.vatIncluded) {
      const gross = price;
      price = netPrice(gross, rate);
      notes.push({
        code: 'GROSS_PRICE',
        message: `Linia ${index + 1}: prețul ${gross} cu TVA devine ${price} fără TVA.`,
      });
    }
    const allowance = product.allowance;
    const reduction = allowance && decimalText(allowance.amount, 'reducerea');
    return {
      name: product.name,
      quantity: decimalText(product.quantity, `cantitatea liniei ${index + 1}`),
      unitCode: 'C62',
      price,
      vat: vat(rate, index),
      adjustments:
        allowance && reduction
          ? [
              allowance.fixedAmount
                ? { charge: false, reason: allowance.reason, amount: reduction }
                : { charge: false, reason: allowance.reason, percent: reduction },
            ]
          : [],
    };
  });
}

function party(company: InvoicerCompany, role: string, notes: ConversionNote[]): Party {
  const country = countryCode(company.country);
  if (!country)
    throw new DomainError(
      'INVOICER_COUNTRY',
      `Țara ${role}ului „${company.country}” nu este recunoscută.`,
    );
  let city = company.city.trim();
  let subdivision: string | undefined = company.county.trim() || undefined;
  if (country === 'RO') {
    subdivision = countyCode(company.county);
    if (!subdivision)
      throw new DomainError(
        'INVOICER_COUNTY',
        `Județul ${role}ului „${company.county}” nu este recunoscut.`,
      );
    if (subdivision === 'RO-B') {
      const sector = bucharestSector(city);
      if (!sector)
        throw new DomainError(
          'INVOICER_SECTOR',
          `Pentru București, localitatea ${role}ului trebuie să fie sectorul (de exemplu „Sector 3”).`,
        );
      city = sector;
    }
  }

  const code = company.vatNumber.toUpperCase().replace(/\s/g, '');
  const identity: Pick<Party, 'vatId' | 'legalId'> = {};
  if (country === 'RO') {
    const digits = code.replace(/^RO/, '');
    // A CNP is personal data: notes say what it is, never repeat it.
    if (isValidCnp(digits))
      notes.push({
        code: 'PERSONAL_ID',
        message: `Identificatorul ${role}ului este un CNP: ${role}ul este o persoană fizică.`,
      });
    else if (!isValidCui(digits))
      notes.push({
        code: 'CUI_CHECKSUM',
        message: `Codul ${role}ului nu are cifra de control a unui CUI sau CNP.`,
      });
    if (code.startsWith('RO')) {
      identity.vatId = code;
      if (!company.vatPayer)
        notes.push({
          code: 'VAT_ID_RECOGNIZED',
          message: `${code} are prefixul RO, deci este cod de TVA al ${role}ului; generatorul anterior îl scria ca număr de înregistrare.`,
        });
    } else if (company.vatPayer) {
      identity.vatId = `RO${code}`;
      notes.push({
        code: 'VAT_PREFIX_ADDED',
        message: `Codul de TVA al ${role}ului devine RO${code}.`,
      });
    } else identity.legalId = code;
  } else {
    const prefix = euVatPrefixes[country];
    if (prefix && code.startsWith(prefix)) identity.vatId = code;
    else identity.legalId = code;
  }

  return {
    name: company.name.trim(),
    ...identity,
    address: {
      lines: [company.address.trim()],
      city,
      ...(subdivision ? { subdivision } : {}),
      country,
    },
  };
}

/** Lines not subject to VAT exclude the buyer's VAT identifier (BR-O-02); its registration
 * code remains the legal identifier (BT-47). */
function withoutVatId(buyer: Party, notes: ConversionNote[]): Party {
  if (!buyer.vatId) return buyer;
  const { vatId, ...rest } = buyer;
  notes.push({
    code: 'BUYER_VAT_ID_OMITTED',
    message:
      'Vânzătorul nu are cod de TVA, deci codul de TVA al cumpărătorului nu apare pe factură.',
  });
  return { ...rest, legalId: rest.legalId ?? vatId.replace(/^RO/, '') };
}

/** Category S at the stated rate. A zero rate needs an explicit category (zero-rated, exempt,
 * reverse charge…) the invoicer does not record; a seller without a VAT code is not subject. */
function vatFor(rate: string, sellerPays: boolean, index: number): LineDraft['vat'] {
  if (!sellerPays) {
    if (rate !== '0')
      throw new DomainError(
        'INVOICER_VAT',
        `Linia ${index + 1} are TVA ${rate}%, dar vânzătorul nu are cod de TVA.`,
      );
    // VATEX-EU-O: "not subject to VAT" in the VAT exemption reason code list.
    return { category: 'O', exemptionCode: 'VATEX-EU-O', exemptionReason: 'Neplătitor de TVA' };
  }
  if (rate === '0')
    throw new DomainError(
      'INVOICER_VAT',
      `Linia ${index + 1} are cota 0%; alegeți categoria de TVA (scutit, taxare inversă, export…).`,
    );
  return { category: 'S', rate };
}

function netPrice(gross: string, rate: string): string {
  const rateUnits = parseScaled(rate, 4);
  const net = divRound(
    parseScaled(gross, 8) * 10n ** 6n,
    10n ** BigInt(8 - DERIVED_PRICE_SCALE) * (10n ** 6n + rateUnits),
    'halfAwayFromZero',
  );
  return canonicalDecimal(formatScaled(net, DERIVED_PRICE_SCALE));
}

/** A stored number or string as decimal text; exponent notation and non-finite values are
 * rejected rather than reinterpreted. */
function decimalText(value: number | string, label: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text))
    throw new DomainError(
      'INVOICER_NUMBER',
      `Valoarea pentru ${label} („${value}”) nu este un număr.`,
    );
  return canonicalDecimal(text.replace(/^(-?)0+(?=\d)/, '$1'));
}
