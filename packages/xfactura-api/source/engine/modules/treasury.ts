import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, exists, gte, lte, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseCamt } from 'xfactura-core/bank/camt';
import { parseMt940 } from 'xfactura-core/bank/mt940';
import {
  canonicalBankAccount,
  checkedStatements,
  entrySourceId,
  statementFinancialHash,
  type BankStatementDocument,
} from 'xfactura-core/bank/statement-document';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { formatMoney, isSupportedCurrency, parseMoney } from 'xfactura-core/money';
import { monthEnd, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  bankMovements,
  bankStatements,
  entries,
  evidence,
  fiscalYears,
  ledgerAccounts,
  lines,
  proposals,
  treasuryAccounts,
} from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import type { CloseCheck, Finding } from '../kernel/periods';

const day = z.iso.date();
export const treasuryAccountInput = z
  .object({
    kind: z.enum(['bank', 'cash']),
    name: z.string().trim().min(2).max(200),
    iban: z.string().trim().min(15).max(34).optional(),
    currency: z
      .string()
      .refine((code): boolean => isSupportedCurrency(code), 'Moneda nu este acceptată.'),
    ledgerAccount: z.string().regex(/^5(12|31)\d(\.[A-Z0-9_-]{1,24})?$/),
    openedOn: day,
  })
  .strict()
  .refine((input) => (input.kind === 'bank') === Boolean(input.iban), {
    message: 'Un cont bancar are IBAN; casa nu are.',
    path: ['iban'],
  })
  // Lei are kept on 5121/5311 and foreign currency on 5124/5314 (OMFP 1802/2014 chart).
  .refine((input) => /^5(121|311)/.test(input.ledgerAccount) === (input.currency === 'RON'), {
    message: 'Contul contabil nu corespunde monedei.',
    path: ['ledgerAccount'],
  });
export const bankImportInput = z
  .object({ evidenceId: z.uuid(), financialYearId: z.uuid() })
  .strict();
export const movementQuery = z
  .object({
    treasuryAccountId: z.uuid().optional(),
    from: day.optional(),
    to: day.optional(),
    unsettled: z.boolean().default(false),
  })
  .strict();

function parseStatements(
  bytes: Uint8Array,
  year: { from: string; to: string },
): BankStatementDocument[] {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return parseCamt(bytes);
  requireCondition(/:20:/.test(head), 'BANK_FORMAT', 'Folosiți un extras MT940 sau camt.053.');
  return parseMt940(new TextDecoder('utf-8', { fatal: true }).decode(bytes), year);
}

/** Whether a movement has a posted explanation. */
const settled = (tx: Transaction, companyId: string) =>
  tx
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.subjectKey, sql`'movement:' || ${bankMovements.id}`),
      ),
    );

/** The ledger balance of an account at the end of a date, in the account's own currency. */
async function ledgerBalance(tx: Transaction, companyId: string, account: string, at: string) {
  const [row] = await tx
    .select({
      minor:
        sql<bigint>`coalesce(sum(case ${lines.side} when 'D' then 1 else -1 end * coalesce(${lines.currencyMinor}, ${lines.bani})), 0)`.mapWith(
          BigInt,
        ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(and(eq(lines.companyId, companyId), eq(lines.account, account), lte(entries.date, at)));
  return row?.minor ?? 0n;
}

export class Treasury {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  createAccount(actor: Actor, key: string, input: z.infer<typeof treasuryAccountInput>) {
    return this.commands.run(actor, key, 'treasury.createAccount', input, 'manage', async (tx) => {
      const [account] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            eq(ledgerAccounts.code, input.ledgerAccount),
          ),
        );
      requireCondition(
        account?.postable && !account.controlKind,
        'LEDGER_ACCOUNT',
        'Contul contabil nu este disponibil pentru trezorerie.',
      );
      const id = randomUUID();
      const iban = input.iban ? canonicalBankAccount(input.iban) : null;
      await tx
        .insert(treasuryAccounts)
        .values({ id, companyId: actor.companyId, ...input, iban, createdBy: actor.actorId });
      return { id, ...input, iban };
    });
  }

  accounts(actor: Actor) {
    return this.commands.read(actor, 'treasury.accounts', (tx) =>
      tx
        .select({
          id: treasuryAccounts.id,
          kind: treasuryAccounts.kind,
          name: treasuryAccounts.name,
          iban: treasuryAccounts.iban,
          currency: treasuryAccounts.currency,
          ledgerAccount: treasuryAccounts.ledgerAccount,
          openedOn: treasuryAccounts.openedOn,
        })
        .from(treasuryAccounts)
        .where(eq(treasuryAccounts.companyId, actor.companyId))
        .orderBy(asc(treasuryAccounts.ledgerAccount)),
    );
  }

  /**
   * Imports MT940 or camt.053 statements. Each statement must balance; each reported movement
   * is kept once per account, however many files repeat it, and a repeated movement must match.
   */
  import(actor: Actor, key: string, input: z.infer<typeof bankImportInput>) {
    return this.commands.run(actor, key, 'bank.import', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.companyId, actor.companyId),
            eq(fiscalYears.id, input.financialYearId),
            eq(fiscalYears.kind, 'financial'),
          ),
        );
      requireCondition(year, 'NOT_FOUND', 'Exercițiul financiar nu este disponibil.', 404);
      const range = { from: year.from, to: year.to };
      const statements = checkedStatements(
        parseStatements(await this.objects.get(actor.companyId, source.hash), range),
        range,
      );
      const results = [];
      for (const statement of statements) {
        const [account] = await tx
          .select()
          .from(treasuryAccounts)
          .where(
            and(
              eq(treasuryAccounts.companyId, actor.companyId),
              eq(treasuryAccounts.iban, canonicalBankAccount(statement.bankAccount)),
            ),
          );
        requireCondition(
          account,
          'BANK_ACCOUNT',
          `Contul ${statement.bankAccount} nu este configurat.`,
          422,
          {
            iban: statement.bankAccount,
          },
        );
        requireCondition(
          account.currency === statement.currency,
          'BANK_CURRENCY',
          `Extrasul este în ${statement.currency}, contul ${account.name} în ${account.currency}.`,
        );
        const financialHash = statementFinancialHash(statement);
        const [existing] = await tx
          .select({ id: bankStatements.id })
          .from(bankStatements)
          .where(
            and(
              eq(bankStatements.companyId, actor.companyId),
              eq(bankStatements.treasuryAccountId, account.id),
              eq(bankStatements.financialHash, financialHash),
            ),
          );
        const statementId = existing?.id ?? randomUUID();
        if (!existing)
          await tx.insert(bankStatements).values({
            id: statementId,
            companyId: actor.companyId,
            treasuryAccountId: account.id,
            evidenceId: source.id,
            format: statement.format,
            sourceId: statement.sourceId,
            from: statement.from,
            to: statement.to,
            openingMinor: parseMoney(statement.opening, statement.currency),
            closingMinor: parseMoney(statement.closing, statement.currency),
            financialHash,
            createdBy: actor.actorId,
          });
        let added = 0;
        for (const entry of statement.entries) {
          const sourceId = entrySourceId(statement, entry);
          const amountMinor = parseMoney(entry.amount, statement.currency);
          const [known] = await tx
            .select()
            .from(bankMovements)
            .where(
              and(
                eq(bankMovements.companyId, actor.companyId),
                eq(bankMovements.treasuryAccountId, account.id),
                eq(bankMovements.sourceId, sourceId),
              ),
            );
          if (known) {
            requireCondition(
              known.amountMinor === amountMinor && known.bookingDate === entry.date,
              'MOVEMENT_CONFLICT',
              'Aceeași mișcare bancară apare cu altă sumă sau dată.',
              409,
              { movementId: known.id },
            );
            continue;
          }
          const detail = entry.details[0];
          await tx.insert(bankMovements).values({
            id: randomUUID(),
            companyId: actor.companyId,
            treasuryAccountId: account.id,
            statementId,
            sourceId,
            bookingDate: entry.date,
            valueDate: entry.valueDate,
            amountMinor,
            currency: statement.currency,
            reference: entry.reference.slice(0, 1000),
            counterparty: (amountMinor > 0n ? detail?.debtor : detail?.creditor) ?? null,
            counterpartyAccount:
              (amountMinor > 0n ? detail?.debtorAccount : detail?.creditorAccount) ?? null,
            details: canonical({
              transactionCode: entry.transactionCode,
              bankReference: entry.bankReference,
              remittance: entry.details.flatMap((item) => item.remittance),
            }),
          });
          added++;
        }
        results.push({
          statementId,
          treasuryAccountId: account.id,
          from: statement.from,
          to: statement.to,
          opening: statement.opening,
          closing: statement.closing,
          movements: statement.entries.length,
          added,
        });
      }
      return { statements: results };
    });
  }

  movements(actor: Actor, input: z.infer<typeof movementQuery>) {
    return this.commands.read(actor, 'bank.movements', async (tx) => {
      const rows = await tx
        .select({
          movement: bankMovements,
          settled:
            sql<number>`case when ${exists(settled(tx, actor.companyId))} then 1 else 0 end`.mapWith(
              Number,
            ),
        })
        .from(bankMovements)
        .where(
          and(
            eq(bankMovements.companyId, actor.companyId),
            input.treasuryAccountId
              ? eq(bankMovements.treasuryAccountId, input.treasuryAccountId)
              : undefined,
            input.from ? gte(bankMovements.bookingDate, input.from) : undefined,
            input.to ? lte(bankMovements.bookingDate, input.to) : undefined,
            input.unsettled ? notExists(settled(tx, actor.companyId)) : undefined,
          ),
        )
        .orderBy(asc(bankMovements.bookingDate), asc(bankMovements.id));
      return rows.map(({ movement, settled: isSettled }) => ({
        id: movement.id,
        treasuryAccountId: movement.treasuryAccountId,
        bookingDate: movement.bookingDate,
        valueDate: movement.valueDate,
        amount: formatMoney(movement.amountMinor, movement.currency),
        currency: movement.currency,
        reference: movement.reference,
        counterparty: movement.counterparty,
        counterpartyAccount: movement.counterpartyAccount,
        settled: Boolean(isSettled),
      }));
    });
  }
}

/** Month-close checks for bank and cash. */
export const treasuryChecks: CloseCheck[] = [
  {
    id: 'bank.explained',
    async run(tx, companyId, month) {
      const end = monthEnd(month as Month);
      const rows = await tx
        .select({ id: bankMovements.id })
        .from(bankMovements)
        .where(
          and(
            eq(bankMovements.companyId, companyId),
            gte(bankMovements.bookingDate, `${month}-01`),
            lte(bankMovements.bookingDate, end),
            notExists(settled(tx, companyId)),
          ),
        )
        .orderBy(asc(bankMovements.id));
      return rows.length
        ? [
            {
              code: 'UNEXPLAINED_MOVEMENTS',
              severity: 'block' as const,
              message: 'Există mișcări bancare din această lună neexplicate.',
              count: rows.length,
              items: rows.slice(0, 20).map((row) => row.id),
            },
          ]
        : [];
    },
  },
  {
    id: 'bank.statements',
    async run(tx, companyId, month) {
      const findings: Finding[] = [];
      const accounts = await tx
        .select()
        .from(treasuryAccounts)
        .where(eq(treasuryAccounts.companyId, companyId));
      for (const account of accounts) {
        const statements = await tx
          .select()
          .from(bankStatements)
          .where(
            and(
              eq(bankStatements.companyId, companyId),
              eq(bankStatements.treasuryAccountId, account.id),
              lte(bankStatements.to, monthEnd(month as Month)),
            ),
          )
          .orderBy(desc(bankStatements.to), desc(bankStatements.from))
          .limit(2);
        const [latest, previous] = statements;
        if (!latest || latest.to < `${month}-01`) continue;
        if (previous && previous.closingMinor !== latest.openingMinor)
          findings.push({
            code: 'STATEMENT_CHAIN',
            severity: 'block',
            message: `Soldul inițial al extrasului ${latest.sourceId} nu continuă extrasul anterior (${account.name}).`,
            items: [latest.id],
          });
        const balance = await ledgerBalance(tx, companyId, account.ledgerAccount, latest.to);
        if (balance !== latest.closingMinor)
          findings.push({
            code: 'BANK_BALANCE',
            severity: 'block',
            message: `Soldul contabil ${formatMoney(balance, account.currency)} al contului ${account.ledgerAccount} diferă de extras (${formatMoney(latest.closingMinor, account.currency)} ${account.currency}) la ${latest.to}.`,
            items: [latest.id],
          });
      }
      return findings;
    },
  },
];
