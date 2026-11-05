import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, type ReadSetEntry } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import {
  checkD301,
  d301Currencies,
  writeD301,
  type D301,
  type D301Line,
} from 'xfactura-core/ro/declarations/d301';
import { counties, euVatPrefixes } from 'xfactura-core/ro/geo';
import { crossBorderCodes } from 'xfactura-core/ro/treatments/cross-border';
import type { RuleContext } from 'xfactura-core/rules';
import { monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies, documents, taxEntries } from '../db/schema';
import { loadState } from '../kernel/state';
import { rounding, sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

export const d301Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    bank: z.string().trim().min(1).max(50),
    account: z.string().trim().min(1).max(50),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const special: readonly string[] = [crossBorderCodes.purchase.eu, crossBorderCodes.purchase.nonEu];

/**
 * The month's VAT owed outside VAT: the reverse-charge entries (RC-…, the output side) whose tax
 * point is in the month on a day the company was not registered under art. 316. Their tax period
 * is the month, or its quarter for a booking made while a `vat.period` fact said so: both are read
 * as one input each, so an entry landing in either makes the return stale.
 */
async function inputsOf(tx: Transaction, companyId: string, month: string) {
  const end = monthEnd(month as Month);
  const quarter = `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
  const { loaded, readSet } = await loadState(tx, companyId, {
    taxPeriods: [
      { tax: 'VAT', period: month },
      { tax: 'VAT', period: quarter },
    ],
    profile: true,
  });
  const ids = [month, quarter].flatMap(
    (period) =>
      loaded.taxLedger
        .get(`VAT|${period}`)
        ?.entries.filter(
          (entry) =>
            entry.direction === 'output' &&
            special.includes(entry.code) &&
            entry.taxPoint >= `${month}-01` &&
            entry.taxPoint <= end &&
            profileAt(loaded, 'vat.status', entry.taxPoint) !== 'normal_vat',
        )
        .map((entry) => `${entry.entryId}|${entry.taxNo}`) ?? [],
  );
  const rows = ids.length
    ? (
        await tx
          .select()
          .from(taxEntries)
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.tax, 'VAT'),
              eq(taxEntries.direction, 'output'),
              inArray(taxEntries.code, [...special]),
              gte(taxEntries.taxPoint, `${month}-01`),
              lte(taxEntries.taxPoint, end),
            ),
          )
      ).filter((row) => ids.includes(`${row.entryId}|${row.taxNo}`))
    : [];
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { loaded, rows, seller, inputs, end };
}

/**
 * The special VAT return (D301, OPANAF nr. 592/2016) of a month: the services bought from
 * suppliers not established in Romania by a company outside VAT, in section 4, and those from
 * suppliers established in the EU again in section 4.1. Each line is the supplier's invoice, its
 * value in its currency, the BNR rate at the chargeability the books used for VAT, and the base
 * and VAT rounded to whole lei by the register's rounding (the structure's baza =
 * round(val_valuta × curs_valutar, 0)). Authorizing it locks the month's VAT ledger.
 */
export function d301Declaration(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D301',
    description: 'Decont special de taxă pe valoarea adăugată (D301)',
    tax: 'VAT',
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    format: (month) => (month >= '2016-01' ? 'D301 v1' : null),
    options: d301Options,
    inputs: async (tx, companyId, month) => (await inputsOf(tx, companyId, month)).inputs,
    async prepare(tx, companyId, month, raw) {
      const options = d301Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { loaded, rows, seller, inputs, end } = await inputsOf(tx, companyId, month);
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const roundToLeu = await rounding(rules, tx, companyId, `${month}-01` as LocalDate, problems);
      const numbers = rows.length
        ? new Map(
            (
              await tx
                .select({ id: documents.id, number: documents.number, date: documents.docDate })
                .from(documents)
                .where(
                  and(
                    eq(documents.companyId, companyId),
                    inArray(documents.id, [
                      ...new Set(rows.flatMap((row) => (row.documentId ? [row.documentId] : []))),
                    ]),
                  ),
                )
            ).map((row) => [row.id, row]),
          )
        : new Map();
      // One line per invoice: a reversal in the same month cancels it, one in a later month is a
      // rectification of that month's return.
      const byDocument = new Map<string, (typeof rows)[number][]>();
      for (const row of rows) {
        const key = row.documentId ?? `${row.entryId}|${row.taxNo}`;
        byDocument.set(key, [...(byDocument.get(key) ?? []), row]);
      }
      const lines: D301Line[] = [];
      for (const [documentId, items] of byDocument) {
        const base = items.reduce((sum, item) => sum + item.baseBani, 0n);
        const vat = items.reduce((sum, item) => sum + item.taxBani, 0n);
        if (base === 0n && vat === 0n) continue;
        if (base < 0n || vat < 0n) {
          problems.push({
            code: 'D301_REVERSAL',
            message: `Achiziția ${documentId} este stornată în ${month}: decontul special nu admite valori negative; corectați decontul lunii achiziției (rectificativ).`,
          });
          continue;
        }
        const first = items[0]!;
        const document = numbers.get(documentId);
        const attributes = JSON.parse(first.attributes) as Record<string, string>;
        const currency = first.currency ?? 'RON';
        if (!(d301Currencies as readonly string[]).includes(currency)) {
          problems.push({
            code: 'D301_CURRENCY',
            message: `Moneda ${currency} a facturii ${document?.number ?? documentId} nu este în lista declarației 301.`,
          });
          continue;
        }
        const minor = items.reduce((sum, item) => sum + (item.baseMinor ?? item.baseBani), 0n);
        const country = attributes.counterpartyCountry ?? '';
        const line: Omit<D301Line, 'section'> = {
          number: (document?.number ?? attributes.number ?? documentId).slice(0, 20),
          date: document?.date ?? first.taxPoint,
          currencyValue: formatMoney(minor, currency),
          currency,
          rate: first.fxRate ?? '1',
          baseBani: roundToLeu ? roundToLeu(base) * 100n : base,
          vatBani: roundToLeu ? roundToLeu(vat) * 100n : vat,
        };
        lines.push({ ...line, section: 4 });
        if (euVatPrefixes[country] !== undefined && country !== 'RO')
          lines.push({ ...line, section: 5 });
      }
      if (problems.length || !seller || !roundToLeu)
        return { xml: '', inputs, problems, summary: null };
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D301 = {
        period: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        rectification: false,
        afterReserveCancellation: 0,
        company: {
          cif: company!.cui,
          name: details.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision
              ? (counties[address.subdivision] ?? address.subdivision)
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
          bank: options.bank,
          account: options.account,
        },
        // pers_inreg 2 for the holder of the art. 317 code, at the month's end.
        registeredArt317: profileAt(loaded, 'vat.eu', end) === 'special',
        declarant: options.declarant,
        lines,
      };
      problems.push(...checkD301(model).map(({ code, message }) => ({ code, message })));
      const payable = lines
        .filter((line) => line.section !== 5)
        .reduce((sum, line) => sum + line.vatBani, 0n);
      return {
        xml: problems.length ? '' : writeD301(model),
        inputs,
        problems,
        summary: {
          month,
          registeredArt317: model.registeredArt317,
          lines: lines.map((line) => ({
            section: line.section === 5 ? '4.1' : String(line.section),
            number: line.number,
            date: line.date,
            value: `${line.currencyValue} ${line.currency}`,
            rate: line.rate,
            base: formatMoney(line.baseBani, 'RON'),
            vat: formatMoney(line.vatBani, 'RON'),
          })),
          payable: formatMoney(payable, 'RON'),
        },
      };
    },
  };
}
