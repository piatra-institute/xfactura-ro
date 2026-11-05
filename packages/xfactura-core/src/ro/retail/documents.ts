import { z } from 'zod';
import { DomainError, requireCondition } from '../../errors';
import { Amount, dateSchema, moneySchema, signedMoneySchema } from '../../values';
import { sourceXml, type XmlElement } from '../../xml/source-xml';

/*
 * The daily closing report of a fiscal cash register (raportul fiscal de închidere zilnică, the
 * Z report; OUG nr. 28/1999 art. 4 alin. (6)–(7)) as a document of the company's own sales:
 * - read by an agent from its printout or a PDF (`documents.record`, kind `zreport`), each field
 *   citing the line it was read from, like every extracted document;
 * - or read from the register's own export, in the XML ANAF prescribes for a register's daily
 *   files (OPANAF nr. 146/2018 anexa nr. 2 secțiunea II.7, ANAF's form A4203): `retail.importZ`.
 *   The export of an offline register is signed with its certificate (PKCS#7, secțiunea II.13):
 *   the envelope is opened to read the XML, and its signature is kept, not verified.
 * Amounts include VAT, per rate, as the register prints them. The articles sold (the register's
 * report by article, when it prints one) are optional: without them the goods sold are a question.
 */

export const zReportKind = 'zreport';
export const isZReportKind = (kind: string) => kind === zReportKind;
export const zReportSchemaVersion = 'extracted-zreport-1';
export const zReportA4203Version = 'amef-a4203-1';

/** The payment types of ANAF's nomenclature (A4203, tipP 1–9), in its order. */
export const zPaymentMethods = [
  'card',
  'cashAdvance',
  'cash',
  'mealTickets',
  'valueTickets',
  'voucher',
  'credit',
  'modern',
  'other',
] as const;
export type ZPaymentMethod = (typeof zPaymentMethods)[number];

const rateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/)
  .transform((value) => new Amount(value).toString());
const count = z.number().int().min(0).max(9_999_999_999);
const counted = z.object({ count, amount: moneySchema }).strict();

export const zReportDocumentSchema = z
  .object({
    parserVersion: z.enum([zReportSchemaVersion, zReportA4203Version]),
    /** The company, as the register prints it. */
    seller: z
      .object({
        name: z.string().min(1).max(500),
        taxId: z.string().min(1).max(100),
        country: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict(),
    /** The register: its unique identification number (NUI, the 10 first characters of the
     * report's id in A4203) or the fiscal series printed on it. */
    register: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
    /** The report's number, progressive on the register (numărul de ordine). */
    number: z.string().regex(/^\d{1,10}$/),
    issueDate: dateSchema,
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
      .nullable(),
    /** The receipts issued that day (nrB). */
    receipts: count,
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** Each rate's operations with VAT (valOp) and VAT (tva), as printed; rate 0 the exempt. */
    taxes: z
      .array(z.object({ rate: rateSchema, gross: moneySchema, tax: moneySchema }).strict())
      .max(20),
    /** Operations exempt of VAT (totNet), and amounts outside the VAT base (totTaxe). */
    exempt: moneySchema,
    otherTaxes: moneySchema,
    /** The day's operations (totB) and VAT (totTva). */
    totals: z.object({ gross: moneySchema, tax: moneySchema }).strict(),
    /** The receipts printed with the buyer's VAT code (nrBC, totBC, totTvaC). */
    buyerCode: z
      .object({ receipts: count, gross: moneySchema, tax: moneySchema })
      .strict()
      .nullable(),
    /** Cancellations, discounts and surcharges made while printing receipts (nrA/totA, …). */
    cancellations: counted.nullable(),
    discounts: counted.nullable(),
    surcharges: counted.nullable(),
    /** The float put in at the day's start and taken out at its end (sume de serviciu). */
    serviceSums: z.object({ opening: moneySchema, closing: moneySchema }).strict().nullable(),
    /** The amounts per means of payment (pl). */
    payments: z
      .array(
        z
          .object({
            method: z.enum(zPaymentMethods),
            amount: moneySchema,
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
      )
      .max(20),
    /** The electronic journal's identifier, when printed. */
    journalId: z.string().min(1).max(100).nullable(),
    /** The fiscal memory's running total of operations, when the report prints it. */
    cumulative: z.object({ gross: moneySchema }).strict().nullable(),
    /** RAM resets (nrAv). */
    failures: count.nullable(),
    /** The articles sold, from the register's report by article, when printed with the Z. */
    items: z
      .array(
        z
          .object({
            code: z.string().min(1).max(100).nullable(),
            name: z.string().min(1).max(500),
            quantity: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/),
            unit: z.string().min(1).max(20).nullable(),
            gross: signedMoneySchema,
            rate: rateSchema,
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type ZReportDocument = z.infer<typeof zReportDocumentSchema>;

/** What an agent records from a printout: the optional parts default to absent. */
export const zReportInput = zReportDocumentSchema.extend({
  parserVersion: z.literal(zReportSchemaVersion).default(zReportSchemaVersion),
  time: zReportDocumentSchema.shape.time.default(null),
  exempt: moneySchema.default('0'),
  otherTaxes: moneySchema.default('0'),
  buyerCode: zReportDocumentSchema.shape.buyerCode.default(null),
  cancellations: counted.nullable().default(null),
  discounts: counted.nullable().default(null),
  surcharges: counted.nullable().default(null),
  serviceSums: zReportDocumentSchema.shape.serviceSums.default(null),
  journalId: zReportDocumentSchema.shape.journalId.default(null),
  cumulative: zReportDocumentSchema.shape.cumulative.default(null),
  failures: count.nullable().default(null),
  items: zReportDocumentSchema.shape.items.default([]),
});

const bani = (value: string) => BigInt(new Amount(value).mul(100).toFixed(0));
const lei = (value: bigint) => new Amount(value.toString()).div(100).toFixed(2);

/** The VAT a rate's amount with VAT includes: gross × rate ÷ (100 + rate), in bani, half up. */
export function includedVat(gross: bigint, rate: string): bigint {
  const r = new Amount(rate);
  if (r.isZero()) return 0n;
  return BigInt(new Amount(gross.toString()).mul(r).div(r.plus(100)).toFixed(0));
}

/**
 * The report's own arithmetic, as `checkDocument` runs it (TOTALS): the rates and the exempt and
 * other amounts add up to the day's total, the rates' VAT to the VAT total, the payments to the
 * total, the articles (when listed) to their rates; each rate's VAT is what its amount with VAT
 * includes, within half a ban per receipt (each receipt rounds its own VAT), at least one ban.
 */
export function zReportProblems(report: ZReportDocument): string[] {
  const problems: string[] = [];
  const sum = (values: string[]) => values.reduce((total, value) => total + bani(value), 0n);
  const exemptLine = report.taxes.find((tax) => new Amount(tax.rate).isZero());
  if (exemptLine && bani(exemptLine.gross) !== bani(report.exempt))
    problems.push(
      `Operațiunile scutite (${report.exempt}) diferă de cota 0 (${exemptLine.gross}).`,
    );
  const operations =
    sum(report.taxes.map((tax) => tax.gross)) +
    (exemptLine ? 0n : bani(report.exempt)) +
    bani(report.otherTaxes);
  if (operations !== bani(report.totals.gross))
    problems.push(
      `Cotele, operațiunile scutite și taxele din afara bazei însumează ${lei(operations)}, iar totalul raportului este ${report.totals.gross}.`,
    );
  const tax = sum(report.taxes.map((row) => row.tax));
  if (tax !== bani(report.totals.tax))
    problems.push(`TVA pe cote însumează ${lei(tax)}, iar TVA totală este ${report.totals.tax}.`);
  const tolerance = BigInt(Math.max(1, Math.ceil(report.receipts / 2)));
  for (const row of report.taxes) {
    const expected = includedVat(bani(row.gross), row.rate);
    const difference = expected - bani(row.tax);
    if (difference > tolerance || -difference > tolerance)
      problems.push(
        `La cota ${row.rate}%, ${row.gross} lei cu TVA includ ${lei(expected)} lei TVA, nu ${row.tax}.`,
      );
  }
  const paid = sum(report.payments.map((payment) => payment.amount));
  if (paid !== bani(report.totals.gross))
    problems.push(
      `Plățile însumează ${lei(paid)}, iar totalul raportului este ${report.totals.gross}.`,
    );
  if (report.items.length) {
    for (const row of report.taxes) {
      const items = report.items
        .filter((item) => new Amount(item.rate).eq(row.rate))
        .reduce((total, item) => total + bani(item.gross), 0n);
      if (items !== bani(row.gross))
        problems.push(
          `Articolele la cota ${row.rate}% însumează ${lei(items)}, iar raportul are ${row.gross}.`,
        );
    }
    if (
      report.items.some((item) => !report.taxes.some((row) => new Amount(row.rate).eq(item.rate)))
    )
      problems.push('Un articol are o cotă pe care raportul nu o are.');
  }
  if (report.buyerCode && bani(report.buyerCode.tax) > bani(report.totals.tax))
    problems.push('TVA bonurilor cu codul cumpărătorului depășește TVA totală.');
  return problems;
}

/** The fields an extraction must cite: what identifies the report and what it totals. */
export function zReportCitations(report: ZReportDocument): string[] {
  return [
    'issueDate',
    'number',
    'register',
    'seller.taxId',
    'totals.gross',
    'totals.tax',
    ...report.taxes.flatMap((_, index) => [`taxes.${index}.gross`, `taxes.${index}.tax`]),
    ...report.payments.map((_, index) => `payments.${index}.amount`),
  ];
}

// The register's export (OPANAF nr. 146/2018 anexa nr. 2, A4203).

const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | base64Digits.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

const OID_SIGNED_DATA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

type Der = { tag: number; start: number; end: number; content: number; constructed: boolean };

function derAt(bytes: Uint8Array, offset: number, limit: number): Der {
  requireCondition(offset + 2 <= limit, 'AMEF_SIGNED', 'Plicul PKCS#7 este trunchiat.');
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let content = offset + 2;
  if (length & 0x80) {
    const size = length & 0x7f;
    requireCondition(size >= 1 && size <= 4, 'AMEF_SIGNED', 'Plicul PKCS#7 nu este DER.');
    length = 0;
    for (let index = 0; index < size; index++) length = length * 256 + bytes[content + index]!;
    content += size;
  }
  requireCondition(content + length <= limit, 'AMEF_SIGNED', 'Plicul PKCS#7 este trunchiat.');
  return { tag, start: offset, end: content + length, content, constructed: (tag & 0x20) !== 0 };
}

function children(bytes: Uint8Array, node: Der): Der[] {
  const found: Der[] = [];
  for (let offset = node.content; offset < node.end;) {
    const child = derAt(bytes, offset, node.end);
    found.push(child);
    offset = child.end;
  }
  return found;
}

/**
 * The XML an export holds: the file itself when it is XML, or the content of the signed envelope
 * (CMS SignedData, DER or base64) the register wraps it in. The signature is not verified.
 */
export function amefXmlBytes(bytes: Uint8Array): { xml: Uint8Array; signed: boolean } {
  let start = 0;
  while (start < bytes.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(bytes[start]!))
    start += 1;
  if (bytes[start] === 0x3c) return { xml: bytes.subarray(start), signed: false };
  let der = bytes;
  if (bytes[start] !== 0x30) {
    let ascii = '';
    for (const byte of bytes) ascii += String.fromCharCode(byte);
    const text = ascii.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    requireCondition(
      /^[A-Za-z0-9+/]+={0,2}$/.test(text),
      'AMEF_FORMAT',
      'Fișierul nu este nici XML, nici un plic PKCS#7 al aparatului de marcat.',
    );
    der = fromBase64(text);
  }
  const info = derAt(der, 0, der.length);
  const [type, explicit] = children(der, info);
  requireCondition(
    type?.tag === 0x06 &&
      OID_SIGNED_DATA.every((value, index) => der[type.content + index] === value) &&
      type.end - type.content === OID_SIGNED_DATA.length &&
      explicit?.tag === 0xa0,
    'AMEF_SIGNED',
    'Plicul PKCS#7 nu este un SignedData.',
  );
  const signed = children(der, explicit!)[0]!;
  // SignedData: version, digestAlgorithms (SET), encapContentInfo (the first SEQUENCE), …
  const encapsulated = children(der, signed).find((node) => node.tag === 0x30);
  const parts = encapsulated ? children(der, encapsulated) : [];
  const wrapped = parts.find((node) => node.tag === 0xa0);
  requireCondition(wrapped, 'AMEF_SIGNED', 'Plicul PKCS#7 nu conține fișierul XML (detached).');
  const octets = children(der, wrapped!)[0]!;
  const collect = (node: Der): Uint8Array[] =>
    node.tag === 0x04
      ? [der.subarray(node.content, node.end)]
      : node.tag === 0x24
        ? children(der, node).flatMap(collect)
        : [];
  const pieces = collect(octets);
  requireCondition(pieces.length > 0, 'AMEF_SIGNED', 'Plicul PKCS#7 nu conține fișierul XML.');
  const size = pieces.reduce((total, piece) => total + piece.length, 0);
  const xml = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    xml.set(piece, offset);
    offset += piece.length;
  }
  return { xml, signed: true };
}

const amount = (value: string | undefined, field: string) => {
  const parsed = moneySchema.safeParse((value ?? '').trim());
  if (!parsed.success)
    throw new DomainError('AMEF_FIELD', `Atributul ${field} al raportului Z nu este o sumă.`);
  return parsed.data;
};
const integer = (value: string | undefined, field: string) => {
  const text = (value ?? '').trim();
  if (!/^\d{1,10}$/.test(text))
    throw new DomainError('AMEF_FIELD', `Atributul ${field} al raportului Z nu este un număr.`);
  return Number(text);
};
const child = (node: XmlElement, local: string) =>
  node.children.filter((item) => item.local === local);

/**
 * A daily file of a register (A4203, `msj`: the day's receipts and its Z report, `rB`) as a Z
 * report document. The report's id is the register's NUI (10 characters), the date and time
 * (AAAALLZZHHMMSS) and the report's number (4 digits). The seller is the company the register
 * belongs to (the message's `cif`, when given, must be its).
 */
export function parseA4203(
  bytes: Uint8Array,
  company: { name: string; taxId: string },
): ZReportDocument & { signed: boolean } {
  const { xml, signed } = amefXmlBytes(bytes);
  const root = sourceXml(xml);
  requireCondition(
    root.local === 'msj',
    'AMEF_FORMAT',
    'Fișierul nu este un fișier zilnic al aparatului de marcat (A4203, msj).',
  );
  const report = child(root, 'rB')[0];
  requireCondition(report, 'AMEF_FORMAT', 'Fișierul nu conține raportul Z (rB).');
  const attributes = report!.attributes;
  const id = (attributes.idR ?? '').trim();
  const parsedId = /^([A-Za-z0-9]{10})(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})$/.exec(id);
  requireCondition(
    parsedId,
    'AMEF_FIELD',
    'Identificatorul raportului Z (idR) nu are forma NNNNNNNNNNAAAALLZZHHMMSSRRRR.',
  );
  const [, nui, year, month, day, hour, minute, second, number] = parsedId!;
  const cif = root.attributes.cif?.trim();
  if (cif)
    requireCondition(
      cif.replace(/^RO/i, '') === company.taxId,
      'COUNTERPARTY',
      'Fișierul aparatului de marcat are codul fiscal al altui utilizator.',
    );
  const currency = (attributes.monRef ?? '').trim();
  const body = zReportDocumentSchema.parse({
    parserVersion: zReportA4203Version,
    seller: { name: company.name, taxId: company.taxId, country: 'RO' },
    register: nui,
    number: String(Number(number)),
    issueDate: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    receipts: integer(attributes.nrB, 'nrB'),
    currency,
    taxes: child(report!, 'coteZ').map((rate) => ({
      rate: String(integer(rate.attributes.cota, 'cota')),
      gross: amount(rate.attributes.valOp, 'valOp'),
      tax: amount(rate.attributes.tva, 'tva'),
    })),
    exempt: amount(attributes.totNet, 'totNet'),
    otherTaxes: amount(attributes.totTaxe, 'totTaxe'),
    totals: { gross: amount(attributes.totB, 'totB'), tax: amount(attributes.totTva, 'totTva') },
    buyerCode: {
      receipts: integer(attributes.nrBC, 'nrBC'),
      gross: amount(attributes.totBC, 'totBC'),
      tax: amount(attributes.totTvaC, 'totTvaC'),
    },
    cancellations: {
      count: integer(attributes.nrA, 'nrA'),
      amount: amount(attributes.totA, 'totA'),
    },
    discounts: { count: integer(attributes.nrR, 'nrR'), amount: amount(attributes.totR, 'totR') },
    surcharges: { count: integer(attributes.nrM, 'nrM'), amount: amount(attributes.totM, 'totM') },
    serviceSums: {
      opening: amount(attributes.sume_serv_in, 'sume_serv_in'),
      closing: amount(attributes.sume_serv_out, 'sume_serv_out'),
    },
    payments: child(report!, 'pl').map((payment) => {
      const type = integer(payment.attributes.tipP, 'tipP');
      requireCondition(
        type >= 1 && type <= zPaymentMethods.length,
        'AMEF_FIELD',
        `Tipul de plată ${type} nu este în nomenclatorul ANAF.`,
      );
      return {
        method: zPaymentMethods[type - 1]!,
        amount: amount(payment.attributes.valPl, 'valPl'),
        currency: (payment.attributes.monPl ?? '').trim(),
      };
    }),
    journalId: null,
    cumulative: null,
    failures: integer(attributes.nrAv, 'nrAv'),
    items: [],
  });
  return { ...body, signed };
}
