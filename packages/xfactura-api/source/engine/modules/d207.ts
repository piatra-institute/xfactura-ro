import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD207,
  d207Namespace,
  writeD207,
  type D207,
  type D207Beneficiary,
} from 'xfactura-core/ro/declarations/d207';
import { counties } from 'xfactura-core/ro/geo';
import type { Withheld } from 'xfactura-core/ro/withholding';
import type { Transaction } from '../db/database';
import { companies, entries, parties, proposals, proposalVersions } from '../db/schema';
import { entryStands } from '../kernel/ledger';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

export const d207Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type NonresidentWithheld = Withheld & {
  d207: { incomeType: string; act: string; state: string; foreignId?: string };
};

/** The year's posted withholdings from non-residents (`nonresidents.withhold`), exemptions by a
 * treaty included: the beneficiary, what the posting recorded for D207, and the amounts. */
async function withholdings(tx: Transaction, companyId: string, year: string) {
  const rows = await tx
    .select({
      entryId: entries.id,
      date: entries.date,
      input: proposalVersions.input,
      effect: proposalVersions.effect,
    })
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
        eq(proposals.treatmentId, 'nonresidents.withhold'),
        gte(entries.date, `${year}-01-01`),
        lte(entries.date, `${year}-12-31`),
        entryStands('"acc_entries"'),
      ),
    );
  return rows.map((row) => {
    const effect = JSON.parse(row.effect ?? '{}') as {
      lines?: { account: string; partyId?: string }[];
      explanation?: { details?: { withholding?: NonresidentWithheld } };
    };
    const input = JSON.parse(row.input) as { openItem: string };
    return {
      entryId: row.entryId,
      date: row.date,
      openItem: input.openItem,
      withheld: effect.explanation!.details!.withholding!,
    };
  });
}

async function inputsOf(tx: Transaction, companyId: string, year: string) {
  const found = await withholdings(tx, companyId, year);
  const { readSet, loaded } = await loadState(tx, companyId, {
    entries: found.map((row) => row.entryId),
    openItems: [{ ids: [...new Set(found.map((row) => row.openItem))] }],
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { found, loaded, seller, inputs };
}

/** Whole lei, half up. */
const lei = (bani: bigint) => Number((bani + 50n) / 100n);

/**
 * The annual informative declaration of tax withheld from non-residents (D207), for a year: one
 * record per beneficiary and income type, from the year's `nonresidents.withhold` postings, under
 * the Codul fiscal or a treaty (Act_N), the exempt ones by a treaty included.
 */
export function d207Declaration(): DeclarationKind {
  return {
    kind: 'D207',
    description:
      'Declarație informativă privind impozitul reținut la sursă/veniturile scutite, pe beneficiari de venit nerezidenți (D207)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      try {
        return `D207 ${d207Namespace(Number(year))}`;
      } catch {
        return null;
      }
    },
    options: d207Options,
    inputs: async (tx, companyId, year) => (await inputsOf(tx, companyId, year)).inputs,
    async prepare(tx, companyId, year, raw) {
      const options = d207Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { found, loaded, seller, inputs } = await inputsOf(tx, companyId, year);
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      if (!found.length)
        problems.push({
          code: 'D207_NOTHING',
          message: `Niciun venit plătit nerezidenților în ${year}: D207 nu are ce declara.`,
        });
      const partyOf = new Map(
        found.flatMap((row) => {
          const item = loaded.openItems.get(row.openItem);
          return item ? [[row.entryId, item.partyId] as const] : [];
        }),
      );
      const ids = [...new Set(partyOf.values())];
      const people = new Map(
        (ids.length
          ? await tx
              .select()
              .from(parties)
              .where(and(eq(parties.companyId, companyId), inArray(parties.id, ids)))
          : []
        ).map((party) => [party.id, party]),
      );
      // One record per beneficiary and income type, the payments' gross and tax added.
      const groups = new Map<
        string,
        { partyId: string; withheld: NonresidentWithheld; base: bigint; tax: bigint; last: string }
      >();
      for (const row of found) {
        const partyId = partyOf.get(row.entryId);
        if (!partyId) continue;
        const key = `${partyId}|${row.withheld.d207.incomeType}|${row.withheld.d207.act}`;
        const group = groups.get(key) ?? {
          partyId,
          withheld: row.withheld,
          base: 0n,
          tax: 0n,
          last: row.date,
        };
        group.base += BigInt(row.withheld.base);
        group.tax += BigInt(row.withheld.tax);
        if (row.date > group.last) group.last = row.date;
        groups.set(key, group);
      }
      const beneficiaries: D207Beneficiary[] = [...groups.values()].map((group) => {
        const party = people.get(group.partyId)!;
        if (group.tax % 100n)
          problems.push({
            code: 'D207_BANI',
            message: `Impozitul reținut lui ${party.name} are subdiviziuni de leu.`,
          });
        return {
          name: party.name.slice(0, 100),
          state: group.withheld.d207.state,
          ...(group.withheld.d207.foreignId
            ? { foreignId: group.withheld.d207.foreignId.slice(0, 20) }
            : {}),
          incomeType: group.withheld.d207.incomeType,
          act: Number(group.withheld.d207.act) as 1 | 2,
          payments: [{ date: group.last, base: lei(group.base), tax: Number(group.tax / 100n) }],
        };
      });
      if (problems.length || !seller) return { xml: '', inputs, problems, summary: null };

      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D207 = {
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
        beneficiaries,
      };
      problems.push(
        ...checkD207(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD207(model),
        inputs,
        problems,
        summary: {
          year,
          beneficiaries: beneficiaries.length,
          types: [...new Set(beneficiaries.map((item) => item.incomeType))],
        },
      };
    },
  };
}
