import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../db/database';
import { bankMovements, employees, parties } from '../db/schema';
import { payPayment, salaryPayment } from './personal';

/*
 * Which bank movements pay pay (`payPayment`), for the views that withhold it from a reader who
 * may not read pay (6 November 2026). A movement is a payment of pay when its proposal (posted,
 * approved or proposed: its latest version, unless withdrawn) books it against 421, 423, 425 or
 * 426, paying as many people as the parties of those lines. One nobody explained yet (or only by
 * a blocked proposal) is when its counterparty is an employee: by name, or by the account a
 * payment of pay already went to; it then pays one person.
 */

const chunks = <T>(values: readonly T[], size = 400) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

/** A name's words, lower case and without diacritics: `POPESCU ANA` is `Ana Popescu`. */
export const nameWords = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 1);

/** Whether a counterparty's name is this employee's: every word of the employee's name, of two
 * words or more, is one of the counterparty's. */
export function namesEmployee(counterparty: string | null, employee: readonly string[]) {
  if (!counterparty || employee.length < 2) return false;
  const words = new Set(nameWords(counterparty));
  return employee.every((word) => words.has(word));
}

/** The company's employees' names, as `nameWords` splits them. */
export async function employeeNames(tx: Transaction, companyId: string) {
  return (
    await tx
      .select({ name: parties.name })
      .from(employees)
      .innerJoin(
        parties,
        and(eq(parties.companyId, employees.companyId), eq(parties.id, employees.partyId)),
      )
      .where(eq(employees.companyId, companyId))
  ).map((row) => nameWords(row.name));
}

type Movement = { id: string; counterparty: string | null; counterpartyAccount: string | null };

/** The movements of these that pay pay, with how many people each pays (above). */
export async function salaryMovements(
  tx: Transaction,
  companyId: string,
  movements: readonly Movement[],
): Promise<Map<string, { persons: number }>> {
  const found = new Map<string, { persons: number }>();
  if (!movements.length) return found;
  const explained = new Set<string>();
  for (const part of chunks(movements.map((movement) => `movement:${movement.id}`))) {
    const rows = await tx.all<{ subject: string; effect: string | null }>(sql`
      select p.subject_key as subject, v.effect_json as effect
      from acc_proposals p
      join acc_proposal_versions v on v.company_id = p.company_id and v.proposal_id = p.id
        and v.version = (select max(x.version) from acc_proposal_versions x
          where x.company_id = p.company_id and x.proposal_id = p.id)
      where p.company_id = ${companyId} and p.subject_key in (${sql.join(
        part.map((key) => sql`${key}`),
        sql`, `,
      )})
        and not exists (select 1 from acc_withdrawals w
          where w.company_id = p.company_id and w.proposal_id = p.id)`);
    for (const row of rows) {
      const id = row.subject.slice('movement:'.length);
      // A blocked proposal explains nothing yet: its movement is read by its counterparty.
      if (!row.effect) continue;
      explained.add(id);
      const lines = (JSON.parse(row.effect) as { lines: { account: string; partyId?: string }[] })
        .lines;
      const paid = payPayment(lines);
      if (paid && (found.get(id)?.persons ?? 0) < paid.persons) found.set(id, paid);
    }
  }
  const pending = movements.filter((movement) => !explained.has(movement.id));
  if (!pending.length) return found;
  const names = await employeeNames(tx, companyId);
  const accounts = [...new Set(pending.flatMap((movement) => movement.counterpartyAccount ?? []))];
  const paidTo = new Set<string>();
  for (const part of chunks(accounts))
    for (const row of await tx.all<{ account: string }>(sql`
      select distinct m.counterparty_account as account from acc_bank_movements m
      join acc_proposals p on p.company_id = m.company_id and p.subject_key = 'movement:' || m.id
      join acc_entries e on e.company_id = p.company_id and e.proposal_id = p.id
      join acc_lines l on l.company_id = e.company_id and l.entry_id = e.id
      where m.company_id = ${companyId}
        and m.counterparty_account in (${sql.join(
          part.map((account) => sql`${account}`),
          sql`, `,
        )})
        and substr(l.account, 1, 3) in ('421', '423', '425', '426')`))
      paidTo.add(row.account);
  for (const movement of pending)
    if (
      (movement.counterpartyAccount && paidTo.has(movement.counterpartyAccount)) ||
      names.some((name) => namesEmployee(movement.counterparty, name))
    )
      found.set(movement.id, { persons: 1 });
  return found;
}

/** The subjects of these (`movement:<id>`) that are payments of pay (`salaryMovements`). */
export async function salarySubjects(
  tx: Transaction,
  companyId: string,
  subjects: readonly string[],
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      subjects.flatMap((subject) =>
        subject.startsWith('movement:') ? [subject.slice('movement:'.length)] : [],
      ),
    ),
  ];
  const rows: { id: string; counterparty: string | null; counterpartyAccount: string | null }[] =
    [];
  for (const part of chunks(ids))
    rows.push(
      ...(await tx
        .select({
          id: bankMovements.id,
          counterparty: bankMovements.counterparty,
          counterpartyAccount: bankMovements.counterpartyAccount,
        })
        .from(bankMovements)
        .where(and(eq(bankMovements.companyId, companyId), inArray(bankMovements.id, part)))),
    );
  return new Set(
    [...(await salaryMovements(tx, companyId, rows)).keys()].map((id) => `movement:${id}`),
  );
}

/** The entries of these that pay pay, with how many people each pays, from their lines. */
export async function salaryEntries(
  tx: Transaction,
  companyId: string,
  entryIds: readonly string[],
): Promise<Map<string, { persons: number }>> {
  const found = new Map<string, { persons: number }>();
  for (const part of chunks([...new Set(entryIds)])) {
    if (!part.length) continue;
    const rows = await tx.all<{ entry: string; account: string; party: string | null }>(sql`
      select l.entry_id as entry, l.account as account, l.party_id as party from acc_lines l
      where l.company_id = ${companyId} and l.entry_id in (${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )})
        and (substr(l.account, 1, 3) in ('421', '423', '425', '426')
          or substr(l.account, 1, 3) in ('512', '531'))`);
    for (const [entry, lines] of Map.groupBy(rows, (row) => row.entry)) {
      const paid = payPayment(
        lines.map((line) => ({ account: line.account, partyId: line.party })),
      );
      if (paid) found.set(entry, paid);
    }
  }
  return found;
}

/** The effect lines of these proposals, at the version named or, without one, the latest. */
async function effectLines(
  tx: Transaction,
  companyId: string,
  named: readonly { proposalId: string; version?: number | undefined }[],
) {
  const found = new Map<string, { account: string; partyId?: string }[]>();
  for (const part of chunks([...new Set(named.map((item) => item.proposalId))]))
    if (part.length)
      for (const row of await tx.all<{
        proposal: string;
        version: number | bigint;
        effect: string;
      }>(
        sql`select v.proposal_id as proposal, v.version as version, v.effect_json as effect
          from acc_proposal_versions v
          where v.company_id = ${companyId} and v.effect_json is not null
            and v.proposal_id in (${sql.join(
              part.map((id) => sql`${id}`),
              sql`, `,
            )})
          order by v.proposal_id, v.version`,
      )) {
        const wanted = named.find((item) => item.proposalId === row.proposal);
        if (wanted?.version !== undefined && wanted.version !== Number(row.version)) continue;
        found.set(row.proposal, (JSON.parse(row.effect) as { lines: [] }).lines);
      }
  return found;
}

/**
 * A reviewed action's preview as a reader who may not read pay sees it, where it lists bookings
 * one by one: a batch's members (`proposals.batch`) and a template's backtest examples
 * (`templates.request`). A member that pays pay is `Plată salarii`, without its amount when it
 * pays one person; an example, without its inputs. A batch's totals per account stand, as the
 * trial balance's do.
 */
export async function previewWithoutPay(
  tx: Transaction,
  companyId: string,
  operation: string,
  preview: unknown,
): Promise<unknown> {
  const value = preview as Record<string, unknown> | null;
  if (operation === 'proposals.batch' && Array.isArray(value?.members)) {
    type Member = { proposalId: string; version: number; subject: string | null };
    const members = value.members as Member[];
    const lines = await effectLines(tx, companyId, members);
    const subjects = await salarySubjects(
      tx,
      companyId,
      members.flatMap((member) => member.subject ?? []),
    );
    return {
      ...value,
      members: members.map((member) => {
        const paid =
          payPayment(lines.get(member.proposalId) ?? []) ??
          (member.subject && subjects.has(member.subject) ? { persons: 1 } : null);
        return paid
          ? {
              ...member,
              description: salaryPayment,
              ...(paid.persons > 1 ? {} : { amount: null }),
              redacted: true,
            }
          : member;
      }),
    };
  }
  const backtest = value?.backtest as { examples?: unknown[] } | undefined;
  if (operation === 'templates.request' && Array.isArray(backtest?.examples)) {
    type Example = { proposalId: string; subject: string };
    const examples = backtest.examples as Example[];
    const lines = await effectLines(tx, companyId, examples);
    const subjects = await salarySubjects(
      tx,
      companyId,
      examples.map((example) => example.subject),
    );
    return {
      ...value,
      backtest: {
        ...backtest,
        examples: examples.map((example) =>
          payPayment(lines.get(example.proposalId) ?? []) || subjects.has(example.subject)
            ? { ...example, posted: null, template: null, redacted: true }
            : example,
        ),
      },
    };
  }
  return preview;
}
