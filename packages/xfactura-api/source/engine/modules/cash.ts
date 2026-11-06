import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { formatMoney, LEDGER_CURRENCY } from 'xfactura-core/money';
import { entries, lines } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { payClasses, salaryPayment } from '../kernel/personal';
import { salaryEntries } from '../kernel/salaries';

export const cashRegisterInput = z
  .object({
    /** The cash account (531x). */
    account: z.string().regex(/^531\d?$/),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict()
  .refine((input) => input.from <= input.to, {
    message: 'Perioada se termină înainte să înceapă.',
  });

const signed =
  sql<bigint>`coalesce(sum(case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end), 0)`.mapWith(
    BigInt,
  );
const money = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);

/**
 * The cash register (registrul de casă, OMFP nr. 2.634/2015): for each day with movements, the
 * balance carried over, each receipt and payment with its document number and explanation, and
 * the day's closing balance. A caller who may not read pay (an agent whose reads do not cover
 * `payroll` and `personal`, or a viewer) reads the day's payments of pay (`salaryEntries`) as one
 * row, `Plată salarii`, with their total and no document: the day's balances state it anyway.
 */
export function cashRegister(
  commands: Commands,
  actor: Actor,
  input: z.infer<typeof cashRegisterInput>,
) {
  return commands.read(actor, 'cash.register', async (tx, access) => {
    const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const [before] = await tx
      .select({ balance: signed })
      .from(lines)
      .innerJoin(entries, join)
      .where(
        and(
          eq(lines.companyId, actor.companyId),
          eq(lines.account, input.account),
          lt(entries.date, input.from),
        ),
      );
    const rows = await tx
      .select({
        entryId: entries.id,
        date: entries.date,
        number: entries.number,
        description: entries.description,
        side: lines.side,
        bani: lines.bani,
        memo: lines.memo,
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(
        and(
          eq(lines.companyId, actor.companyId),
          eq(lines.account, input.account),
          gte(entries.date, input.from),
          lte(entries.date, input.to),
        ),
      )
      .orderBy(asc(entries.date), asc(entries.seq), asc(lines.lineNo));
    const pay = (await commands.disclosable(tx, actor, access.role))(payClasses);
    const salaries = pay
      ? new Map<string, unknown>()
      : await salaryEntries(
          tx,
          actor.companyId,
          rows.map((row) => row.entryId),
        );
    let balance = before?.balance ?? 0n;
    const days = [...Map.groupBy(rows, (row) => row.date)].map(([date, movements]) => {
      const opening = balance;
      for (const row of movements) balance += row.side === 'D' ? row.bani : -row.bani;
      type Row = {
        document: string | null;
        description: string;
        receipt: string | null;
        payment: string | null;
        redacted?: true;
      };
      const shown: Row[] = [];
      const paid = movements.filter((row) => salaries.has(row.entryId));
      for (const row of movements) {
        if (!salaries.has(row.entryId)) {
          shown.push({
            document: row.memo ?? `NC ${row.number}`,
            description: row.description,
            receipt: row.side === 'D' ? money(row.bani) : null,
            payment: row.side === 'C' ? money(row.bani) : null,
          });
          continue;
        }
        if (row !== paid[0]) continue;
        const total = (side: 'D' | 'C') =>
          paid.filter((item) => item.side === side).reduce((sum, item) => sum + item.bani, 0n);
        shown.push({
          document: null,
          description: salaryPayment,
          receipt: paid.some((item) => item.side === 'D') ? money(total('D')) : null,
          payment: paid.some((item) => item.side === 'C') ? money(total('C')) : null,
          redacted: true,
        });
      }
      return { date, opening: money(opening), movements: shown, closing: money(balance) };
    });
    return {
      account: input.account,
      opening: money(before?.balance ?? 0n),
      days,
      closing: money(balance),
    };
  });
}
