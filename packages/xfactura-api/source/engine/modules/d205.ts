import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD205,
  d205Namespace,
  writeD205,
  type D205,
  type D205Beneficiary,
} from 'xfactura-core/ro/declarations/d205';
import { parseMoney } from 'xfactura-core/money';
import { counties } from 'xfactura-core/ro/geo';
import type { Transaction } from '../db/database';
import {
  companies,
  entries,
  lines,
  openItems,
  parties,
  partyCnps,
  proposals,
  proposalVersions,
} from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { Sealer } from './payroll';

export const d205Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    /** Whether the dividends paid (divid_P) are declared gross or net of the tax: the
     * instructions do not say, so the company decides with its expert. */
    paidAs: z.enum(['gross', 'net']),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** The year's posted dividend withholdings: what was paid (or left unpaid at year end), to whom,
 * the tax, and the distribution it came from. */
async function withholdings(tx: Transaction, companyId: string, year: string) {
  const rows = await tx
    .select({ entry: entries, input: proposalVersions.input })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.treatmentId, 'dividends.withhold'),
        gte(entries.date, `${year}-01-01`),
        lte(entries.date, `${year}-12-31`),
      ),
    );
  return Promise.all(
    rows.map(async ({ entry, input }) => {
      const given = JSON.parse(input) as {
        distributionEntryId: string;
        openItem: string;
        gross: string;
        unpaidAtYearEnd?: boolean;
      };
      const [tax] = await tx
        .select({ bani: lines.bani })
        .from(lines)
        .where(
          and(
            eq(lines.companyId, companyId),
            eq(lines.entryId, entry.id),
            eq(lines.account, '446'),
          ),
        );
      const [distribution] = await tx
        .select({ date: entries.date })
        .from(entries)
        .where(and(eq(entries.companyId, companyId), eq(entries.id, given.distributionEntryId)));
      const [item] = await tx
        .select({ partyId: openItems.partyId })
        .from(openItems)
        .where(and(eq(openItems.companyId, companyId), eq(openItems.id, given.openItem)));
      return {
        entryId: entry.id,
        date: entry.date,
        distributed: distribution!.date,
        partyId: item!.partyId,
        gross: BigInt(Math.round(Number(given.gross) * 100)),
        tax: tax?.bani ?? 0n,
        unpaid: given.unpaidAtYearEnd ?? false,
      };
    }),
  );
}

/** The year's posted interest withholdings: the gross interest paid, to whom, and the tax. */
async function interestWithholdings(tx: Transaction, companyId: string, year: string) {
  const rows = await tx
    .select({ entry: entries, input: proposalVersions.input })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.treatmentId, 'loans.withhold'),
        gte(entries.date, `${year}-01-01`),
        lte(entries.date, `${year}-12-31`),
      ),
    );
  return Promise.all(
    rows.map(async ({ entry, input }) => {
      const given = JSON.parse(input) as { openItem: string; gross: string };
      const [tax] = await tx
        .select({ bani: lines.bani })
        .from(lines)
        .where(
          and(
            eq(lines.companyId, companyId),
            eq(lines.entryId, entry.id),
            eq(lines.account, '446'),
          ),
        );
      const [item] = await tx
        .select({ partyId: openItems.partyId })
        .from(openItems)
        .where(and(eq(openItems.companyId, companyId), eq(openItems.id, given.openItem)));
      return {
        entryId: entry.id,
        date: entry.date,
        partyId: item!.partyId,
        gross: parseMoney(given.gross, 'RON'),
        tax: tax?.bani ?? 0n,
      };
    }),
  );
}

/** The year's posted rent withholdings (`payees.withhold`, rent): the landlord, the net income
 * the tax was computed on and the tax. Intellectual property is D112's, not D205's. */
async function rentWithholdings(tx: Transaction, companyId: string, year: string) {
  const rows = await tx
    .select({ entry: entries, input: proposalVersions.input, effect: proposalVersions.effect })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.treatmentId, 'payees.withhold'),
        gte(entries.date, `${year}-01-01`),
        lte(entries.date, `${year}-12-31`),
      ),
    );
  const found = [];
  for (const { entry, input, effect } of rows) {
    const record = (
      JSON.parse(effect ?? '{}') as {
        explanation?: { details?: { withholding?: { type: string; base: string; tax: string } } };
      }
    ).explanation?.details?.withholding;
    if (record?.type !== '628') continue;
    const given = JSON.parse(input) as { openItem: string };
    const [item] = await tx
      .select({ partyId: openItems.partyId })
      .from(openItems)
      .where(and(eq(openItems.companyId, companyId), eq(openItems.id, given.openItem)));
    found.push({
      entryId: entry.id,
      date: entry.date,
      partyId: item!.partyId,
      base: BigInt(record.base),
      tax: BigInt(record.tax),
    });
  }
  return found;
}

async function inputsOf(tx: Transaction, companyId: string, year: string) {
  const found = await withholdings(tx, companyId, year);
  const interest = await interestWithholdings(tx, companyId, year);
  const rent = await rentWithholdings(tx, companyId, year);
  const { readSet } = await loadState(tx, companyId, {
    entries: [...found, ...interest, ...rent].map((row) => row.entryId),
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { found, interest, rent, seller, inputs };
}

/**
 * The annual informative declaration of tax withheld (D205), for the dividends, the interest and
 * the rent paid in a year: per individual, a record of each, their CNP opened from its seal for
 * the declaration only. Companies are not declared in it.
 */
export function d205Declaration(secret: string): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D205',
    description:
      'Declarație informativă privind impozitul reținut la sursă, pe beneficiari de venit (D205)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      try {
        return `D205 ${d205Namespace(Number(year))}`;
      } catch {
        return null;
      }
    },
    options: d205Options,
    inputs: async (tx, companyId, year) => (await inputsOf(tx, companyId, year)).inputs,
    async prepare(tx, companyId, year, raw) {
      const options = d205Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { found, interest, rent, seller, inputs } = await inputsOf(tx, companyId, year);
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const lei = (bani: bigint, what: string) => {
        if (bani % 100n !== 0n)
          problems.push({ code: 'D205_BANI', message: `${what} are subdiviziuni de leu.` });
        return Number(bani / 100n);
      };
      const ids = [...new Set([...found, ...interest, ...rent].map((row) => row.partyId))];
      const people = ids.length
        ? await tx
            .select()
            .from(parties)
            .where(and(eq(parties.companyId, companyId), inArray(parties.id, ids)))
        : [];
      const cnps = ids.length
        ? new Map(
            (
              await tx
                .select()
                .from(partyCnps)
                .where(and(eq(partyCnps.companyId, companyId), inArray(partyCnps.partyId, ids)))
            ).map((row) => [row.partyId, row.cnpSealed]),
          )
        : new Map<string, string>();
      const beneficiaries: D205Beneficiary[] = people.map((party) => {
        const own = found.filter((row) => row.partyId === party.id);
        const payments = own
          .filter((row) => !row.unpaid)
          .map((row) => ({
            date: row.date,
            distributed: row.distributed,
            gross: lei(row.gross, `Dividendul plătit lui ${party.name}`),
            tax: lei(row.tax, `Impozitul reținut lui ${party.name}`),
          }));
        const unpaid = own
          .filter((row) => row.unpaid)
          .map((row) => ({
            gross: lei(row.gross, `Dividendul neplătit al lui ${party.name}`),
            tax: lei(row.tax, `Impozitul reținut lui ${party.name}`),
          }));
        const paidInterest = interest
          .filter((row) => row.partyId === party.id)
          .map((row) => ({
            date: row.date,
            gross: lei(row.gross, `Dobânda plătită lui ${party.name}`),
            tax: lei(row.tax, `Impozitul pe dobânda reținut lui ${party.name}`),
          }));
        // The net income of each rent payment, rounded half up to the leu as D205 declares it.
        const paidRent = rent
          .filter((row) => row.partyId === party.id)
          .map((row) => ({
            date: row.date,
            base: Number((row.base + 50n) / 100n),
            tax: lei(row.tax, `Impozitul pe chirie reținut lui ${party.name}`),
          }));
        if (party.kind === 'ro_individual') {
          const sealed = cnps.get(party.id);
          if (!sealed)
            problems.push({
              code: 'D205_CNP',
              message: `Înregistrați CNP-ul beneficiarului ${party.name} (parties.recordCnp).`,
            });
          return {
            kind: 'individual',
            cnp: sealed ? sealer.open(companyId, sealed) : '',
            name: party.name,
            payments,
            unpaid,
            ...(paidInterest.length ? { interest: paidInterest } : {}),
            ...(paidRent.length ? { rent: paidRent } : {}),
          };
        }
        return { kind: 'company', cui: party.taxId ?? '', name: party.name, payments, unpaid };
      });
      if (problems.length || !seller) return { xml: '', inputs, problems, summary: null };

      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D205 = {
        year: Number(year),
        correction: false,
        declarant: options.declarant,
        payer: {
          cui: company!.cui,
          name: details.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision ? counties[address.subdivision] : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
        },
        paidAs: options.paidAs,
        beneficiaries,
      };
      problems.push(
        ...checkD205(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD205(model),
        inputs,
        problems,
        summary: {
          year,
          individuals: beneficiaries.filter((item) => item.kind === 'individual').length,
          companies: beneficiaries.filter((item) => item.kind === 'company').length,
        },
      };
    },
  };
}
