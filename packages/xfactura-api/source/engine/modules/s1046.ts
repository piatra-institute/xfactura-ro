import { and, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { DomainError } from 'xfactura-core/errors';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import { s1046Format, writeS1046 } from 'xfactura-core/ro/annual/s1046';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies, entries, lines } from '../db/schema';
import { loadState } from '../kernel/state';
import { activitySince, financialYear } from './annual';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { addressOf, countyCode } from './s1005';

const text = (max: number) => z.string().trim().min(1).max(max);

export const s1046Options = z
  .object({
    tradeRegister: text(18),
    /** nume_declarant: the person who manages the entity. */
    declarant: text(75),
    largeTaxpayer: z.boolean(),
    phone: text(15).optional(),
  })
  .strict();

/** The share capital at the year's end (1011 + 1012), in whole lei. */
async function capitalAt(tx: Transaction, companyId: string, end: string) {
  const [row] = await tx
    .select({
      credit:
        sql<bigint>`coalesce(sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END), 0)`.mapWith(
          BigInt,
        ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(lines.companyId, companyId),
        lte(entries.date, end),
        sql`substr(${lines.account}, 1, 4) IN ('1011', '1012')`,
      ),
    );
  const bani = row?.credit ?? 0n;
  return Number((bani + 50n) / 100n);
}

/**
 * The inactivity declaration (S1046) of a company that has carried out no activity since it was
 * set up, for a financial year ending on 31 December: a person states the fact
 * (`activity.none`), the books must agree (no revenue or expense since they began), and the
 * capital is read from 1011 and 1012. A company the books show active files its statements.
 */
export function s1046Declaration(): DeclarationKind {
  const inputs = async (tx: Transaction, companyId: string, year: string) => {
    const { readSet } = await loadState(tx, companyId, {
      profile: true,
      turnover: [
        {
          prefixes: ['1', '6', '7'],
          from: '1900-01-01' as LocalDate,
          to: `${year}-12-31` as LocalDate,
        },
      ],
    });
    const seller = await sellerDetails(tx, companyId);
    const entries: ReadSetEntry[] = [
      ...readSet,
      ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
    ];
    return { seller, inputs: entries };
  };
  return {
    kind: 'S1046',
    description: 'Declarație de inactivitate (S1046)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      try {
        return `S1046 ${s1046Format(Number(year)).namespace}`;
      } catch {
        return null;
      }
    },
    options: s1046Options,
    inputs: async (tx, companyId, year) => (await inputs(tx, companyId, year)).inputs,
    async prepare(tx, companyId, year, raw) {
      const options = s1046Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { seller, inputs: read } = await inputs(tx, companyId, year);
      const fail = () => ({ xml: '', inputs: read, problems, summary: null });
      const end = `${year}-12-31` as LocalDate;
      const { loaded } = await loadState(tx, companyId, { profile: true });
      const stated = loaded.profile
        .filter((fact) => fact.axis === 'activity.none' && fact.effectiveFrom <= end)
        .at(-1)?.value;
      if (stated !== 'yes')
        problems.push({
          code: 'ACTIVITY_NOT_STATED',
          message:
            'Declarația de inactivitate se depune de persoana care gestionează entitatea, pe propria răspundere: înregistrați faptul activity.none = yes, cu documentul care îl susține.',
        });
      if (await activitySince(tx, companyId, end))
        problems.push({
          code: 'ACTIVITY_IN_BOOKS',
          message: `Registrele au venituri sau cheltuieli până la 31.12.${year}: compania a desfășurat activitate și depune situații financiare anuale.`,
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      if (!(await financialYear(tx, companyId, end)))
        problems.push({
          code: 'YEAR_END',
          message: `Nu există un exercițiu financiar încheiat la 31.12.${year}.`,
        });
      if (problems.length) return fail();
      const details = JSON.parse(seller!.details) as Party;
      const county = countyCode(details.address.subdivision);
      if (county === undefined) {
        problems.push({
          code: 'S1046_COUNTY',
          message: 'Județul sediului social nu este în nomenclatorul formularului.',
        });
        return fail();
      }
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const form = loaded.profile.filter((fact) => fact.axis === 'entity.form').at(-1)?.value;
      let xml: string;
      try {
        xml = writeS1046({
          year: Number(year),
          yearEnd: end,
          // Tip_soc 1: economic operators (the companies the engine keeps).
          entityKind: 1,
          entity: {
            cui: company!.cui,
            name: details.name,
            address: addressOf(details),
            ...(options.phone ? { phone: options.phone } : {}),
            tradeRegister: options.tradeRegister,
            county,
            largeTaxpayer: options.largeTaxpayer,
          },
          capital: await capitalAt(tx, companyId, end),
          declarant: options.declarant,
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        problems.push({ code: error.code, message: error.message });
        return fail();
      }
      return {
        xml,
        inputs: read,
        problems,
        summary: { year: Number(year), form: form ?? 'srl', declarant: options.declarant },
      };
    },
  };
}
