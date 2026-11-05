import { and, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD100,
  d100Namespace,
  writeD100,
  d100WithheldCodes,
  type D100,
  type D100Obligation,
  type D100WithheldCode,
} from 'xfactura-core/ro/declarations/d100';
import type { Withheld } from 'xfactura-core/ro/withholding';
import { counties } from 'xfactura-core/ro/geo';
import type { Transaction } from '../db/database';
import { companies, entries, lines, proposals, proposalVersions } from '../db/schema';
import { entryStands } from '../kernel/ledger';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

export const d100Options = z
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
    /** The fourth quarter's micro tax is due by 25 January (the structure) or 25 June (ANAF's
     * validator) of the next year: the company decides with its expert. */
    fourthQuarterDue: z.enum(['january', 'june']).optional(),
  })
  .strict();

/** Postings that stand of a treatment (or subject) dated in a range, with the input and effect
 * they posted. */
async function posted(
  tx: Transaction,
  companyId: string,
  where: { treatmentId?: string; subjectKey?: string; from: string; to: string },
) {
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
        ...(where.treatmentId ? [eq(proposals.treatmentId, where.treatmentId)] : []),
        ...(where.subjectKey ? [eq(proposals.subjectKey, where.subjectKey)] : []),
        gte(entries.date, where.from),
        lte(entries.date, where.to),
        // A reversed posting no longer counts; the subject's new booking does.
        entryStands('"acc_entries"'),
      ),
    );
  return rows.map((row) => ({
    entryId: row.entryId,
    date: row.date,
    input: JSON.parse(row.input) as Record<string, unknown>,
    effect: JSON.parse(row.effect ?? '{}') as {
      explanation?: { details?: Record<string, unknown> };
    },
  }));
}

/** The obligations of a month from the books: the quarter's micro or profit tax in its last month,
 * and the dividend and interest tax withheld in the month. */
async function obligationsOf(tx: Transaction, companyId: string, month: string) {
  const [year, number] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const end = `${month}-31`;
  const quarter = `${year}-Q${Math.ceil(number / 3)}`;
  const micro =
    number % 3 === 0
      ? await posted(tx, companyId, {
          subjectKey: `micro:${quarter}:1`,
          from: `${month}-01`,
          to: `${year + 1}-12-31`,
        })
      : [];
  const dividends = await posted(tx, companyId, {
    treatmentId: 'dividends.withhold',
    from: `${month}-01`,
    to: end,
  });
  const interest = await posted(tx, companyId, {
    treatmentId: 'loans.withhold',
    from: `${month}-01`,
    to: end,
  });
  // Rent paid to individuals and non-residents' income (O1); intellectual property is D112's.
  const others = [
    ...(await posted(tx, companyId, {
      treatmentId: 'payees.withhold',
      from: `${month}-01`,
      to: end,
    })),
    ...(await posted(tx, companyId, {
      treatmentId: 'nonresidents.withhold',
      from: `${month}-01`,
      to: end,
    })),
  ];
  // The profit tax of quarters I–III, posted from the quarter's end within the year (memoranda
  // when nothing was due).
  const profit =
    number % 3 === 0 && number < 12
      ? (
          await posted(tx, companyId, {
            treatmentId: 'tax.profit',
            from: `${month}-01`,
            to: `${year}-12-31`,
          })
        ).filter((row) => row.input.period === quarter && !row.input.rectification)
      : [];
  // The tax each entry booked: on 446 when withheld, on 4418 for the micro tax.
  const taxes = new Map<string, bigint>();
  for (const [rows, account] of [
    [micro, '4418'],
    [[...dividends, ...interest], '446'],
  ] as const)
    for (const row of rows) {
      const [line] = await tx
        .select({ bani: lines.bani })
        .from(lines)
        .where(
          and(
            eq(lines.companyId, companyId),
            eq(lines.entryId, row.entryId),
            eq(lines.account, account),
          ),
        );
      taxes.set(row.entryId, line?.bani ?? 0n);
    }
  // The profit tax: what each posting credited to 4411 (nothing for a memorandum).
  for (const row of profit) {
    const booked = await tx
      .select({ side: lines.side, bani: lines.bani })
      .from(lines)
      .where(
        and(
          eq(lines.companyId, companyId),
          eq(lines.entryId, row.entryId),
          eq(lines.account, '4411'),
        ),
      );
    taxes.set(
      row.entryId,
      booked.reduce((sum, line) => sum + (line.side === 'C' ? line.bani : -line.bani), 0n),
    );
  }
  return { micro, dividends, interest, others, profit, taxes };
}

/**
 * The declaration of obligations to the state budget (D100) for a month, from the books: the
 * micro-enterprise tax posted for the quarter, in its last month, the dividend tax withheld in
 * the month, for individuals (604) and companies (150), with, in December, the tax on dividends
 * left unpaid at year end, the tax withheld on interest paid to individuals (605), on rent paid to
 * individuals (628) and on non-residents' income (631–634, 636).
 */
export function d100Declaration(): DeclarationKind {
  return {
    kind: 'D100',
    description: 'Declarație privind obligațiile de plată la bugetul de stat (D100)',
    tax: null,
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    format(month) {
      try {
        return `D100 ${d100Namespace({ year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) })}`;
      } catch {
        return null;
      }
    },
    options: d100Options,
    async inputs(tx, companyId, month) {
      const { micro, dividends, interest, others, profit } = await obligationsOf(
        tx,
        companyId,
        month,
      );
      const { readSet } = await loadState(tx, companyId, {
        entries: [...micro, ...dividends, ...interest, ...others, ...profit].map(
          (row) => row.entryId,
        ),
      });
      const seller = await sellerDetails(tx, companyId);
      const inputs: ReadSetEntry[] = [
        ...readSet,
        ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
      ];
      return inputs;
    },
    async prepare(tx, companyId, month, raw) {
      const options = d100Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const inputs = await this.inputs(tx, companyId, month);
      const { micro, dividends, interest, others, profit, taxes } = await obligationsOf(
        tx,
        companyId,
        month,
      );
      const seller = await sellerDetails(tx, companyId);
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const december = month.endsWith('-12');
      const obligations: D100Obligation[] = [];
      const [microTax] = micro;
      if (microTax) {
        // The tax as posted (698 = 4418): computed by `tax.micro`, in whole lei.
        const tax = taxes.get(microTax.entryId) ?? 0n;
        if (tax <= 0n || tax % 100n)
          problems.push({
            code: 'D100_MICRO',
            message:
              'Impozitul pe microîntreprinderi înregistrat lipsește sau are subdiviziuni de leu.',
          });
        if (december && !options.fourthQuarterDue)
          problems.push({
            code: 'D100_DUE',
            message:
              'Precizați termenul impozitului pe trimestrul IV (25 ianuarie, după structură, sau 25 iunie, după validatorul ANAF).',
          });
        obligations.push({
          kind: 'micro',
          tax: Number(tax / 100n),
          ...(december && options.fourthQuarterDue
            ? { fourthQuarterDue: options.fourthQuarterDue }
            : {}),
        });
      }
      // The profit tax of the quarter (103): what its computations booked, in whole lei.
      if (profit.length) {
        const tax = profit.reduce((sum, row) => sum + taxes.get(row.entryId)!, 0n);
        if (tax < 0n || tax % 100n)
          problems.push({
            code: 'D100_PROFIT',
            message:
              'Impozitul pe profit înregistrat pentru trimestru este negativ sau are subdiviziuni de leu.',
          });
        obligations.push({ kind: 'profit', tax: Number(tax / 100n) });
      }
      for (const beneficiary of ['individual', 'company'] as const) {
        const own = dividends.filter(
          (row) => row.effect.explanation?.details?.beneficiary === beneficiary,
        );
        if (!own.length) continue;
        const sum = (unpaid: boolean) =>
          own
            .filter((row) => Boolean(row.input.unpaidAtYearEnd) === unpaid)
            .reduce((total, row) => total + taxes.get(row.entryId)!, 0n);
        const withheld = sum(false);
        const unpaid = sum(true);
        if (withheld % 100n || unpaid % 100n)
          problems.push({
            code: 'D100_BANI',
            message: 'Impozitul pe dividende are subdiviziuni de leu.',
          });
        obligations.push({
          kind: 'dividends',
          beneficiary,
          withheld: Number(withheld / 100n),
          ...(unpaid ? { unpaidAtYearEnd: Number(unpaid / 100n) } : {}),
        });
      }
      // The tax withheld on interest paid to individuals in the month (605).
      if (interest.length) {
        const withheld = interest.reduce((total, row) => total + taxes.get(row.entryId)!, 0n);
        if (withheld % 100n)
          problems.push({
            code: 'D100_BANI',
            message: 'Impozitul pe dobânzi are subdiviziuni de leu.',
          });
        obligations.push({ kind: 'interest', withheld: Number(withheld / 100n) });
      }
      // The other taxes withheld at source, by their code: what each posting withheld.
      const byCode = new Map<D100WithheldCode, bigint>();
      for (const row of others) {
        const record = row.effect.explanation?.details?.withholding as Withheld | undefined;
        if (!record || BigInt(record.tax) === 0n) continue;
        if (!(d100WithheldCodes as readonly string[]).includes(record.type)) continue;
        const code = record.type as D100WithheldCode;
        byCode.set(code, (byCode.get(code) ?? 0n) + BigInt(record.tax));
      }
      for (const code of d100WithheldCodes) {
        const tax = byCode.get(code);
        if (tax === undefined) continue;
        if (tax % 100n)
          problems.push({
            code: 'D100_BANI',
            message: `Impozitul reținut la sursă (${code}) are subdiviziuni de leu.`,
          });
        obligations.push({ kind: 'withheld', code, withheld: Number(tax / 100n) });
      }
      if (!obligations.length)
        problems.push({
          code: 'D100_NOTHING',
          message: `Nicio obligație de declarat pentru ${month}.`,
        });
      if (problems.length || !seller) return { xml: '', inputs, problems, summary: null };

      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D100 = {
        period: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        afterReserveCancellation: false,
        dissolution: false,
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
        obligations,
      };
      problems.push(
        ...checkD100(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD100(model),
        inputs,
        problems,
        summary: {
          month,
          obligations: obligations.map((item) =>
            item.kind === 'other' || item.kind === 'withheld' ? item.code : item.kind,
          ),
        },
      };
    },
  };
}
