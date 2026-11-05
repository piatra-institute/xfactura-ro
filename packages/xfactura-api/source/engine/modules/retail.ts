import { and, asc, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { JsonValue, TaxLedgerEntry } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { addWorkingDays } from 'xfactura-core/ro/calendar';
import { documentIdentity } from 'xfactura-core/documents/schemas';
import {
  includedVat,
  parseA4203,
  retailCodePattern,
  zReportDocumentSchema,
  zReportKind,
  zReportProblems,
  type B2cRule,
  type ZReportDocument,
} from 'xfactura-core/ro/retail';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import type { D394CashRegisters, D394Rate } from 'xfactura-core/ro/declarations/d394';
import { d394Rates } from 'xfactura-core/ro/declarations/d394';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { ObjectStore } from '../adapters/object-store';
import type { Transaction } from '../db/database';
import {
  cashRegisterEventKinds,
  cashRegisterEvents,
  cashRegisters,
  companies,
  documentLinks,
  documents,
  entries,
  evidence,
  fiscalYears,
  ledgerAccounts,
  lines,
  parties,
  proposals,
  submissionEvents,
  submissions,
  warehouses,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import type { CloseCheck, Finding } from '../kernel/periods';
import { joinIdentityGroup } from '../kernel/sources';
import type { DeclarationProblem } from './declarations';

/*
 * Retail (G2) in the engine: the company's fiscal cash registers, tracked and never driven (OUG
 * nr. 28/1999: their fiscalization, ANAF registration, service and archives are the company's
 * obligations, recorded with their documents); a register's daily file imported from its export
 * (A4203); the analytic accounts of a warehouse kept at retail price; the month close's checks of
 * the registers' Z reports (numbers without gaps, days without reports, the fiscal memory's running
 * total), of the retail price method (the month's discharge, the year's count) and of card takings
 * in transit; the worklist's e-Factura deadlines; and where D394 reports the registers' receipts.
 */

const lei = (bani: bigint) => formatMoney(bani, 'RON');
const day = z.iso.date();
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;
const monthEnd = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
const addDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const registerInput = z
  .object({
    /** The register's unique identification number (NUI), as its files and reports carry it. */
    code: z.string().regex(/^[A-Za-z0-9]{4,40}$/),
    /** The fiscal series printed on its receipts. */
    fiscalSeries: z.string().trim().min(2).max(40),
    /** The working point's address it is installed at. */
    location: z.string().trim().min(5).max(500),
    /** The warehouse it sells goods from. */
    warehouseId: z.uuid().optional(),
    /** The day it was put into use (fiscalized). */
    activeFrom: day,
    /** The fiscalization record. */
    evidenceId: z.uuid(),
  })
  .strict();
export const registerEventInput = z
  .object({
    registerId: z.uuid(),
    kind: z.enum(cashRegisterEventKinds),
    date: day,
    reference: z.string().trim().min(1).max(100).optional(),
    evidenceId: z.uuid(),
  })
  .strict();
const obligationView = z.object({
  id: z.string(),
  title: z.string(),
  clause: z.string(),
  external: z.literal(true),
  state: z.enum(['recorded', 'missing', 'standing']),
  detail: z.string().nullable(),
});
export const cashRegisterView = z.object({
  id: z.string(),
  code: z.string(),
  fiscalSeries: z.string(),
  location: z.string(),
  warehouseId: z.string().nullable(),
  activeFrom: z.string(),
  closedOn: z.string().nullable(),
  events: z.array(
    z.object({
      seq: z.number(),
      kind: z.string(),
      date: z.string(),
      reference: z.string().nullable(),
    }),
  ),
  reports: z.object({
    count: z.number(),
    first: z.object({ number: z.string(), date: z.string() }).nullable(),
    last: z.object({ number: z.string(), date: z.string() }).nullable(),
  }),
  obligations: z.array(obligationView),
});
export const setupInput = z
  .object({
    warehouseId: z.uuid(),
    /** The VAT rates its goods are sold at: an account of goods and of VAT included each. */
    rates: z
      .array(z.enum(['21', '11', '9', '5', '19', '0']))
      .min(1)
      .max(6),
  })
  .strict();
export const setupView = z.object({ warehouseId: z.string(), accounts: z.array(z.string()) });
export const importZInput = z.object({ evidenceId: z.uuid() }).strict();
export const importZView = z.object({
  documentId: z.string(),
  created: z.boolean(),
  register: z.string(),
  number: z.string(),
  date: z.string(),
  signed: z.boolean(),
});
export const positionInput = z.object({ warehouseId: z.uuid(), date: day.optional() }).strict();
export const positionView = z.object({
  warehouseId: z.string(),
  code: z.string(),
  date: z.string().nullable(),
  rates: z.array(z.object({ rate: z.string(), goods: z.string(), vat: z.string() })),
  markup: z.string(),
  cost: z.string(),
});

/** The external obligations of a register, as the law lists them; the engine records, never
 * performs them. */
const obligationsOf = (
  register: typeof cashRegisters.$inferSelect,
  events: { kind: string; date: string; reference: string | null }[],
) => {
  const has = (kind: string) => events.find((event) => event.kind === kind);
  const failure = [...events]
    .reverse()
    .find((event) => event.kind === 'failure' || event.kind === 'repaired');
  return [
    {
      id: 'fiscalization',
      title: 'Fiscalizarea aparatului de către unitatea de service acreditată',
      clause: 'OUG28/1999:art.3(3)-(5)',
      external: true as const,
      state: 'recorded' as const,
      detail: `de la ${register.activeFrom}`,
    },
    {
      id: 'anaf.registration',
      title:
        'Înregistrarea în registrul național al aparatelor de marcat (ANAF) și conectarea la distanță',
      clause: 'OUG28/1999:art.3^1',
      external: true as const,
      state: has('anaf_registered') ? ('recorded' as const) : ('missing' as const),
      detail: has('anaf_registered')?.reference ?? null,
    },
    {
      id: 'service',
      title: 'Contractul de service cu distribuitorul autorizat și cartea de intervenții',
      clause: 'OUG28/1999:art.5(3)',
      external: true as const,
      state: has('service_contract') ? ('recorded' as const) : ('missing' as const),
      detail: has('service_contract')?.reference ?? null,
    },
    {
      id: 'special.register',
      title: 'Registrul special și chitanțele cât timp aparatul este defect',
      clause: 'OUG28/1999:art.1(8)',
      external: true as const,
      state: failure?.kind === 'failure' ? ('missing' as const) : ('standing' as const),
      detail: failure?.kind === 'failure' ? `defect din ${failure.date}` : null,
    },
    {
      id: 'archive',
      title: 'Păstrarea rapoartelor Z și a jurnalului electronic 5 ani, a memoriei fiscale 10 ani',
      clause: 'OUG28/1999:art.4(5)-(9)',
      external: true as const,
      state: 'standing' as const,
      detail: null,
    },
  ];
};

/** A Z report document's register, number and day, as recorded. */
type ZRow = {
  id: string;
  root: string;
  body: ZReportDocument;
};

async function zReports(tx: Transaction, companyId: string, until?: string) {
  const rows = await tx
    .select({ id: documents.id, body: documents.body, root: documentLinks.toId })
    .from(documents)
    .leftJoin(
      documentLinks,
      and(
        eq(documentLinks.companyId, documents.companyId),
        eq(documentLinks.fromId, documents.id),
        inArray(documentLinks.kind, ['same_as', 'same_as_confirmed']),
      ),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, zReportKind),
        ...(until ? [lte(documents.docDate, until)] : []),
        // A corrected extraction stands for the one it supersedes.
        sql`not exists (select 1 from ${documentLinks} s where s.company_id = ${documents.companyId}
          and s.to_id = ${documents.id} and s.kind = 'supersedes')`,
      ),
    )
    .orderBy(asc(documents.docDate), asc(documents.id));
  return rows.flatMap((row): ZRow[] => {
    const parsed = zReportDocumentSchema.safeParse(JSON.parse(row.body));
    return parsed.success ? [{ id: row.id, root: row.root ?? row.id, body: parsed.data }] : [];
  });
}

/** The subjects among these with a posted entry that stands (no reversal of it posted). */
async function standing(tx: Transaction, companyId: string, subjects: readonly string[]) {
  if (!subjects.length) return new Set<string>();
  const rows = await tx
    .select({ subject: proposals.subjectKey, entryId: entries.id })
    .from(proposals)
    .innerJoin(
      entries,
      and(eq(entries.companyId, proposals.companyId), eq(entries.proposalId, proposals.id)),
    )
    .where(and(eq(proposals.companyId, companyId), inArray(proposals.subjectKey, [...subjects])));
  if (!rows.length) return new Set<string>();
  const reversed = new Set(
    (
      await tx
        .select({ subject: proposals.subjectKey })
        .from(proposals)
        .innerJoin(
          entries,
          and(eq(entries.companyId, proposals.companyId), eq(entries.proposalId, proposals.id)),
        )
        .where(
          and(
            eq(proposals.companyId, companyId),
            inArray(
              proposals.subjectKey,
              rows.map((row) => `reverse:${row.entryId}`),
            ),
          ),
        )
    ).map((row) => row.subject.slice('reverse:'.length)),
  );
  return new Set(rows.filter((row) => !reversed.has(row.entryId)).map((row) => row.subject));
}

/** A register a Z report names: by its unique number or its fiscal series. */
const registerOf = (registers: (typeof cashRegisters.$inferSelect)[], name: string) =>
  registers.find(
    (register) =>
      register.code.toUpperCase() === name.toUpperCase() ||
      register.fiscalSeries.replace(/\s+/g, '').toUpperCase() ===
        name.replace(/\s+/g, '').toUpperCase(),
  );

/** The company's warehouses kept at retail price: those with retail-controlled goods accounts. */
async function retailWarehouses(tx: Transaction, companyId: string) {
  const accounts = await tx
    .select({ code: ledgerAccounts.code })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.controlKind, 'retail')));
  const codes = new Set(
    accounts.flatMap((row) => {
      const match = /^371\.([A-Z0-9_]{1,20})-\d{1,2}$/.exec(row.code);
      return match ? [match[1]!] : [];
    }),
  );
  if (!codes.size) return [];
  return (await tx.select().from(warehouses).where(eq(warehouses.companyId, companyId))).filter(
    (row) => codes.has(row.code),
  );
}

/** A warehouse's retail accounts' balances and turnover in a date range, per account. */
async function retailTurnover(
  tx: Transaction,
  companyId: string,
  code: string,
  from: string,
  to: string,
) {
  const rows = await tx
    .select({
      account: lines.account,
      debit: sql<bigint>`sum(CASE ${lines.side} WHEN 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(
        BigInt,
      ),
      credit: sql<bigint>`sum(CASE ${lines.side} WHEN 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(
        BigInt,
      ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, from),
        lte(entries.date, to),
        sql`(${lines.account} LIKE ${`371.${code}-%`} OR ${lines.account} = ${`378.${code}`} OR ${lines.account} LIKE ${`4428.${code}-%`})`,
      ),
    )
    .groupBy(lines.account);
  return rows;
}

/** The month close's checks of retail (G2). */
export const retailChecks: CloseCheck[] = [
  {
    // The registers' Z reports: every number booked, every day reported or dealt with, the fiscal
    // memory's running total consistent (OUG nr. 28/1999 art. 3 alin. (3)–(4), art. 4 alin. (6)).
    id: 'retail.zreports',
    async run(tx, companyId, month) {
      const registers = await tx
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.companyId, companyId));
      const start = `${month}-01`;
      const end = monthEnd(month);
      const reports = (await zReports(tx, companyId, end)).filter(
        (row, index, all) => all.findIndex((other) => other.root === row.root) === index,
      );
      if (!registers.length && !reports.length) return [];
      const findings: Finding[] = [];
      const closed = new Map<string, string>();
      for (const event of await tx
        .select()
        .from(cashRegisterEvents)
        .where(
          and(eq(cashRegisterEvents.companyId, companyId), eq(cashRegisterEvents.kind, 'closed')),
        ))
        closed.set(event.registerId, event.date);
      const unknown = reports.filter(
        (row) => row.body.issueDate >= start && !registerOf(registers, row.body.register),
      );
      if (unknown.length)
        findings.push({
          code: 'ZREPORT_REGISTER',
          severity: 'warn',
          message: `Rapoarte Z ale unor case de marcat neînregistrate (${[...new Set(unknown.map((row) => row.body.register))].join(', ')}): înregistrați casele (retail.registers.record).`,
          count: unknown.length,
          items: unknown.map((row) => row.id),
        });
      const gaps: string[] = [];
      const days: string[] = [];
      const memory: string[] = [];
      const duplicates: string[] = [];
      for (const register of registers) {
        if (register.activeFrom > end) continue;
        const closedOn = closed.get(register.id);
        if (closedOn && closedOn < start) continue;
        const own = reports
          .filter((row) => registerOf([register], row.body.register))
          .sort((a, b) => Number(a.body.number) - Number(b.body.number));
        const numbers = new Map<number, ZRow>();
        for (const row of own) {
          const number = Number(row.body.number);
          const held = numbers.get(number);
          if (held && held.body.issueDate !== row.body.issueDate)
            duplicates.push(
              `${register.code} nr. ${number} (${held.body.issueDate}, ${row.body.issueDate})`,
            );
          numbers.set(number, row);
        }
        const inMonth = own.filter((row) => row.body.issueDate >= start);
        if (inMonth.length) {
          const first = Math.min(...inMonth.map((row) => Number(row.body.number)));
          const last = Math.max(...inMonth.map((row) => Number(row.body.number)));
          const earlier = own.filter((row) => row.body.issueDate < start);
          const from = earlier.length
            ? Math.max(...earlier.map((row) => Number(row.body.number))) + 1
            : first;
          const missing: number[] = [];
          for (let number = from; number <= last; number++)
            if (!numbers.has(number)) missing.push(number);
          if (missing.length)
            gaps.push(
              `${register.code}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`,
            );
          // The fiscal memory accumulates each day's operations (art. 3 alin. (3) lit. a), d)).
          for (const row of inMonth) {
            const previous = numbers.get(Number(row.body.number) - 1);
            if (!row.body.cumulative || !previous?.body.cumulative) continue;
            const expected =
              BigInt(Math.round(Number(previous.body.cumulative.gross) * 100)) +
              BigInt(Math.round(Number(row.body.totals.gross) * 100));
            const actual = BigInt(Math.round(Number(row.body.cumulative.gross) * 100));
            if (expected !== actual)
              memory.push(
                `${register.code} Z ${row.body.number}: ${lei(actual)} în loc de ${lei(expected)}`,
              );
          }
        }
        // Days of the month without a report: the shop closed, or a report not recorded.
        const firstDay = register.activeFrom > start ? register.activeFrom : start;
        const lastDay = closedOn && closedOn < end ? closedOn : end;
        const reported = new Set(own.map((row) => row.body.issueDate));
        for (let date = firstDay; date <= lastDay; date = addDay(date, 1))
          if (!reported.has(date)) days.push(`${register.code} ${date}`);
      }
      if (gaps.length)
        findings.push({
          code: 'ZREPORT_GAP',
          severity: 'block',
          message: `Lipsesc rapoarte Z din numerotarea caselor de marcat: ${gaps.join('; ')}. Înregistrați-le (retail.importZ sau documents.record) și contabilizați-le.`,
          count: gaps.length,
          items: gaps,
        });
      if (duplicates.length)
        findings.push({
          code: 'ZREPORT_DUPLICATE',
          severity: 'block',
          message: `Același număr de raport Z apare la date diferite: ${duplicates.join('; ')}.`,
          count: duplicates.length,
          items: duplicates,
        });
      if (memory.length)
        findings.push({
          code: 'ZREPORT_CUMULATIVE',
          severity: 'block',
          message: `Totalul cumulat al memoriei fiscale nu rezultă din rapoartele Z: ${memory.join('; ')}. Verificați rapoartele (OUG nr. 28/1999 art. 3 alin. (3)).`,
          count: memory.length,
          items: memory,
        });
      if (days.length)
        findings.push({
          code: 'ZREPORT_DAY',
          severity: 'warn',
          message: `Zile fără raport Z: ${days.slice(0, 31).join(', ')}${days.length > 31 ? ', …' : ''}. Înregistrați raportul zilei, sau confirmați că unitatea a fost închisă (work.dispose).`,
          count: days.length,
          items: days,
        });
      const month_ = reports.filter(
        (row) => row.body.issueDate >= start && row.body.issueDate <= end,
      );
      const booked = await standing(
        tx,
        companyId,
        month_.map((row) => `document:${row.root}`),
      );
      const unbooked = month_.filter((row) => !booked.has(`document:${row.root}`));
      if (unbooked.length)
        findings.push({
          code: 'ZREPORT_UNBOOKED',
          severity: 'block',
          message: `Rapoarte Z necontabilizate: ${unbooked.map((row) => `${row.body.register} nr. ${row.body.number} (${row.body.issueDate})`).join(', ')} (retail.zReport).`,
          count: unbooked.length,
          items: unbooked.map((row) => row.root),
        });
      return findings;
    },
  },
  {
    // The retail price method: each month's discharge of its exits' markup and VAT, the count at
    // sale price in the financial year's last month (OMFP 1802/2014 pct. 286 alin. (4), (8)).
    id: 'retail.method',
    async run(tx, companyId, month) {
      const stores = await retailWarehouses(tx, companyId);
      if (!stores.length) return [];
      const start = `${month}-01`;
      const end = monthEnd(month);
      const findings: Finding[] = [];
      const missing: string[] = [];
      const stale: string[] = [];
      const counts: string[] = [];
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.companyId, companyId),
            eq(fiscalYears.kind, 'financial'),
            lte(fiscalYears.from, end),
            gte(fiscalYears.to, end),
          ),
        );
      for (const store of stores) {
        const rows = await retailTurnover(tx, companyId, store.code, start, end);
        const exits = rows.filter((row) => row.account.startsWith('371.') && row.credit !== 0n);
        const subject = `retail.discharge:${store.id}:${month}`;
        const discharged = await standing(tx, companyId, [subject]);
        if (exits.length && !discharged.has(subject)) missing.push(store.code);
        else if (exits.length) {
          // A Z report booked after the discharge leaves its exits' VAT undischarged.
          for (const row of exits) {
            const rate = row.account.slice(row.account.lastIndexOf('-') + 1);
            const vat = rows.find((other) => other.account === `4428.${store.code}-${rate}`);
            const expected = includedVat(row.credit, rate);
            if (expected !== 0n && (vat?.debit ?? 0n) < expected)
              stale.push(
                `${store.code} ${rate}%: TVA descărcată ${lei(vat?.debit ?? 0n)}, ieșirile cer ${lei(expected)}`,
              );
          }
        }
        if (year?.to === end) {
          const held = await retailTurnover(tx, companyId, store.code, '1900-01-01', end);
          const goods = held
            .filter((row) => row.account.startsWith('371.'))
            .reduce((sum, row) => sum + row.debit - row.credit, 0n);
          if (goods !== 0n) {
            const counted = await tx
              .select({ subject: proposals.subjectKey })
              .from(proposals)
              .innerJoin(
                entries,
                and(
                  eq(entries.companyId, proposals.companyId),
                  eq(entries.proposalId, proposals.id),
                ),
              )
              .where(
                and(
                  eq(proposals.companyId, companyId),
                  like(proposals.subjectKey, `retail.count:${store.id}:${month}-%`),
                ),
              );
            if (!counted.length) counts.push(store.code);
          }
        }
      }
      if (missing.length)
        findings.push({
          code: 'RETAIL_DISCHARGE_MISSING',
          severity: 'block',
          message: `Gestiunile la preț cu amănuntul ${missing.join(', ')} au ieșiri în ${month} fără descărcarea adaosului și a TVA neexigibile (retail.discharge).`,
          count: missing.length,
          items: missing,
        });
      if (stale.length)
        findings.push({
          code: 'RETAIL_DISCHARGE_STALE',
          severity: 'block',
          message: `Descărcarea lunii nu cuprinde toate ieșirile: ${stale.join('; ')}. Stornați descărcarea și propuneți-o din nou.`,
          count: stale.length,
          items: stale,
        });
      if (counts.length)
        findings.push({
          code: 'RETAIL_COUNT_MISSING',
          severity: 'block',
          message: `Ultima lună a exercițiului: gestiunile ${counts.join(', ')} la preț cu amănuntul nu au inventarul la preț de vânzare (retail.count; OMF nr. 2.861/2009, anexa pct. 1–2 și 4).`,
          count: counts.length,
          items: counts,
        });
      return findings;
    },
  },
  {
    // Card takings the acquirer has not settled by the end of the month after their day.
    id: 'retail.cards',
    async run(tx, companyId, month) {
      const end = monthEnd(month);
      const before = `${month}-01`;
      const rows = await tx
        .select({
          item: lines.item,
          bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            like(lines.account, '5125%'),
            like(lines.item, 'zreport:%'),
            lte(entries.date, end),
          ),
        )
        .groupBy(lines.item);
      const open = rows.filter((row) => row.bani !== 0n);
      if (!open.length) return [];
      const reports = new Map(
        (
          await tx
            .select({ id: documents.id, date: documents.docDate })
            .from(documents)
            .where(
              and(
                eq(documents.companyId, companyId),
                inArray(
                  documents.id,
                  open.map((row) => row.item!.slice('zreport:'.length)),
                ),
              ),
            )
        ).map((row) => [row.id, row.date]),
      );
      // Due by the end of the month after the report's: older than the previous month.
      const previousMonth = addDay(before, -1).slice(0, 7);
      const old = open.filter(
        (row) => (reports.get(row.item!.slice(8)) ?? end) < `${previousMonth}-01`,
      );
      if (!old.length) return [];
      return [
        {
          code: 'CARDS_IN_TRANSIT',
          severity: 'warn',
          message: `Încasări cu cardul nedecontate de bancă de peste o lună: ${old.map((row) => lei(row.bani)).join(', ')} lei (bank.settle cu cards).`,
          count: old.length,
          items: old.map((row) => row.item!.slice(8)),
        },
      ];
    },
  },
];

// The worklist: e-Factura deadlines and the registers' external obligations.

export type RetailWorkItem = {
  kind: 'efactura.due' | 'retail.register';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  due: string | null;
  period: string;
  message: string;
  details: { [key: string]: JsonValue };
  next: { operation: string; by: 'agent' | 'human'; inputHint: { [key: string]: JsonValue } }[];
};

/**
 * What waits on retail: each issued invoice to a buyer in Romania not transmitted to RO e-Factura
 * (none sent, or the last one rejected or absent), due `ro.deadline.efactura` working days after
 * its issue (OUG nr. 120/2021 art. 10 alin. (7), art. 10^1 alin. (2^1)); each register whose ANAF
 * registration or service contract is not recorded, or that is out of order.
 */
export async function retailWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
  rules: RuleContext,
): Promise<RetailWorkItem[]> {
  const items: RetailWorkItem[] = [];
  const issued = await tx
    .select({
      id: documents.id,
      number: documents.number,
      date: documents.docDate,
      body: documents.body,
      partyId: documents.partyId,
      country: parties.country,
      kind: parties.kind,
    })
    .from(documents)
    .innerJoin(
      parties,
      and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.authority, 'issued'),
        inArray(documents.kind, [invoiceKinds.sale, invoiceKinds.saleCredit]),
        gte(documents.docDate, '2026-01-01'),
      ),
    )
    .orderBy(asc(documents.docDate), asc(documents.id));
  const domestic = issued.filter((row) => row.country === 'RO');
  const sent = domestic.length
    ? await tx
        .select({
          documentId: submissions.documentId,
          state: submissionEvents.state,
          seq: submissionEvents.seq,
          submissionId: submissions.id,
        })
        .from(submissions)
        .innerJoin(
          submissionEvents,
          and(
            eq(submissionEvents.companyId, submissions.companyId),
            eq(submissionEvents.submissionId, submissions.id),
          ),
        )
        .where(
          and(
            eq(submissions.companyId, companyId),
            inArray(
              submissions.documentId,
              domestic.map((row) => row.id),
            ),
          ),
        )
        .orderBy(desc(submissionEvents.seq))
    : [];
  const live = new Set<string>();
  const latest = new Map<string, string>();
  for (const row of sent) {
    if (!latest.has(row.submissionId)) latest.set(row.submissionId, row.state);
  }
  for (const row of sent) {
    const state = latest.get(row.submissionId);
    if (state && state !== 'rejected' && state !== 'absent') live.add(row.documentId);
  }
  const receiptInvoices = new Set(
    domestic.length
      ? (
          await tx
            .select({ documentId: proposals.documentId })
            .from(proposals)
            .where(
              and(
                eq(proposals.companyId, companyId),
                eq(proposals.treatmentId, 'retail.receiptInvoice'),
              ),
            )
        ).flatMap((row) => (row.documentId ? [row.documentId] : []))
      : [],
  );
  for (const row of domestic) {
    if (live.has(row.id)) continue;
    let workingDays: number;
    let b2c: B2cRule | null = null;
    try {
      workingDays = rules.param<{ workingDays: number }>(
        'ro.deadline.efactura',
        'invoice_issue_date',
        row.date as LocalDate,
      ).workingDays;
      if (row.kind === 'ro_individual')
        b2c = rules.param<B2cRule>('ro.efactura.b2c', 'invoice_issue_date', row.date as LocalDate);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      continue;
    }
    if (b2c && receiptInvoices.has(row.id) && b2c.receiptInvoices === 'exempt') continue;
    const due = addWorkingDays(row.date as LocalDate, workingDays);
    items.push({
      kind: 'efactura.due',
      subject: { kind: 'document', id: row.id },
      severity: today > due ? 'block' : 'warn',
      due,
      period: row.date.slice(0, 7),
      message: `Factura ${row.number ?? row.id} din ${row.date} se transmite în RO e-Factura până la ${due} (${workingDays} zile lucrătoare de la emitere, OUG nr. 120/2021 art. 10 alin. (7)${row.kind === 'ro_individual' ? ', art. 10^1 alin. (2^1): factură B2C' : ''})${today > due ? ': termenul a trecut' : ''}.`,
      details: {
        documentId: row.id,
        number: row.number,
        issueDate: row.date,
        due,
        b2c: row.kind === 'ro_individual',
      },
      next: [{ operation: 'spv.submit', by: 'human', inputHint: { documentId: row.id } }],
    });
  }
  const registers = await tx
    .select()
    .from(cashRegisters)
    .where(eq(cashRegisters.companyId, companyId));
  for (const register of registers) {
    const events = await tx
      .select()
      .from(cashRegisterEvents)
      .where(
        and(
          eq(cashRegisterEvents.companyId, companyId),
          eq(cashRegisterEvents.registerId, register.id),
        ),
      )
      .orderBy(asc(cashRegisterEvents.seq));
    if (events.some((event) => event.kind === 'closed')) continue;
    const pending = obligationsOf(register, events).filter((item) => item.state === 'missing');
    if (!pending.length) continue;
    items.push({
      kind: 'retail.register',
      subject: { kind: 'cashRegister', id: register.id },
      severity: 'warn',
      due: null,
      period: today.slice(0, 7),
      message: `Casa de marcat ${register.code} (${register.location}): ${pending.map((item) => item.title.toLowerCase()).join('; ')} — obligații externe, neînregistrate în aplicație.`,
      details: {
        registerId: register.id,
        code: register.code,
        pending: pending.map((item) => item.id),
      },
      next: [
        {
          operation: 'retail.registers.event',
          by: 'human',
          inputHint: { registerId: register.id },
        },
      ],
    });
  }
  return items;
}

// Where the returns report the registers' receipts (D394 op2 I1).

/** The VAT ledger's entries of the registers' Z reports, and of the receipts invoiced. */
export const isZReportEntry = (entry: TaxLedgerEntry) =>
  entry.attributes.documentType === 'zreport';

/**
 * D394's op2 I1 by month: the registers used, the receipts and what they collected, with the base
 * and VAT by rate, the receipts invoiced left out (anexa nr. 2 lit. G); whole lei.
 */
export function cashRegisterSections(
  entries_: readonly TaxLedgerEntry[],
  roundToLeu: (bani: bigint) => bigint,
  problems: DeclarationProblem[],
): D394CashRegisters[] {
  const months = new Map<
    number,
    {
      registers: Set<string>;
      receipts: number;
      byRate: Map<D394Rate, { base: bigint; vat: bigint }>;
    }
  >();
  for (const entry of entries_) {
    const rate = /^S-(\d+)$/.exec(entry.code)?.[1];
    if (!rate || !(d394Rates as readonly string[]).includes(rate)) {
      problems.push({
        code: 'D394_OPERATION',
        message: `Raportul Z cu codul ${entry.code} nu are o cotă declarată în D394.`,
      });
      continue;
    }
    const month = Number(entry.taxPoint.slice(5, 7));
    const held = months.get(month) ?? { registers: new Set(), receipts: 0, byRate: new Map() };
    if (entry.attributes.register && !entry.attributes.invoiced)
      held.registers.add(entry.attributes.register);
    const amounts = held.byRate.get(rate as D394Rate) ?? { base: 0n, vat: 0n };
    amounts.base += entry.baseBani;
    amounts.vat += entry.taxBani;
    held.byRate.set(rate as D394Rate, amounts);
    months.set(month, held);
  }
  // The receipts: each report's count once (its entries share it), the invoiced ones taken out.
  const counted = new Set<string>();
  for (const entry of entries_) {
    const month = Number(entry.taxPoint.slice(5, 7));
    const held = months.get(month);
    if (!held) continue;
    const key = `${entry.documentId}|${entry.attributes.invoiced ?? ''}`;
    if (counted.has(key)) continue;
    counted.add(key);
    held.receipts += Number(entry.attributes.receipts ?? '0');
  }
  return [...months.entries()]
    .sort(([a], [b]) => a - b)
    .map(([month, held]) => {
      const byRate = Object.fromEntries(
        [...held.byRate].map(([rate, value]) => [
          rate,
          { base: Number(roundToLeu(value.base)), vat: Number(roundToLeu(value.vat)) },
        ]),
      ) as D394CashRegisters['byRate'];
      const total = Object.values(byRate).reduce(
        (sum, value) => sum + (value?.base ?? 0) + (value?.vat ?? 0),
        0,
      );
      return { month, registers: held.registers.size, receipts: held.receipts, total, byRate };
    })
    .filter((month) => month.receipts > 0 || month.total !== 0);
}

/** The company's fiscal cash registers, their Z reports and the warehouses kept at retail price. */
export class Retail {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  recordRegister(actor: Actor, key: string, input: z.infer<typeof registerInput>) {
    return this.commands.run(actor, key, 'retail.registers.record', input, 'manage', async (tx) => {
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Documentul fiscalizării nu este disponibil.', 404);
      if (input.warehouseId) {
        const [store] = await tx
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(
            and(eq(warehouses.companyId, actor.companyId), eq(warehouses.id, input.warehouseId)),
          );
        requireCondition(store, 'WAREHOUSE', 'Gestiunea nu există.', 404);
      }
      const [existing] = await tx
        .select({ id: cashRegisters.id })
        .from(cashRegisters)
        .where(
          and(eq(cashRegisters.companyId, actor.companyId), eq(cashRegisters.code, input.code)),
        );
      requireCondition(
        !existing,
        'REGISTER_EXISTS',
        `Casa de marcat ${input.code} este deja înregistrată.`,
        409,
      );
      const id = this.commands.ids();
      await tx.insert(cashRegisters).values({
        id,
        companyId: actor.companyId,
        code: input.code,
        fiscalSeries: input.fiscalSeries,
        location: input.location,
        warehouseId: input.warehouseId ?? null,
        activeFrom: input.activeFrom,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      return { id, code: input.code };
    });
  }

  recordEvent(actor: Actor, key: string, input: z.infer<typeof registerEventInput>) {
    return this.commands.run(actor, key, 'retail.registers.event', input, 'write', async (tx) => {
      const [register] = await tx
        .select()
        .from(cashRegisters)
        .where(
          and(eq(cashRegisters.companyId, actor.companyId), eq(cashRegisters.id, input.registerId)),
        );
      requireCondition(register, 'REGISTER', 'Casa de marcat nu există.', 404);
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Documentul nu este disponibil.', 404);
      requireCondition(
        input.date >= register.activeFrom,
        'REGISTER_DATE',
        `Casa de marcat este în folosință de la ${register.activeFrom}.`,
      );
      const [last] = await tx
        .select()
        .from(cashRegisterEvents)
        .where(
          and(
            eq(cashRegisterEvents.companyId, actor.companyId),
            eq(cashRegisterEvents.registerId, register.id),
          ),
        )
        .orderBy(desc(cashRegisterEvents.seq))
        .limit(1);
      requireCondition(
        last?.kind !== 'closed',
        'REGISTER_CLOSED',
        'Casa de marcat a fost scoasă din folosință.',
      );
      const seq = (last?.seq ?? 0) + 1;
      await tx.insert(cashRegisterEvents).values({
        companyId: actor.companyId,
        registerId: register.id,
        seq,
        kind: input.kind,
        date: input.date,
        reference: input.reference ?? null,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      return { registerId: register.id, seq, kind: input.kind };
    });
  }

  listRegisters(actor: Actor) {
    return this.commands.read(actor, 'retail.registers.list', async (tx) => {
      const registers = await tx
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.companyId, actor.companyId))
        .orderBy(asc(cashRegisters.code));
      const reports = (await zReports(tx, actor.companyId)).filter(
        (row, index, all) => all.findIndex((other) => other.root === row.root) === index,
      );
      const items = [];
      for (const register of registers) {
        const events = await tx
          .select()
          .from(cashRegisterEvents)
          .where(
            and(
              eq(cashRegisterEvents.companyId, actor.companyId),
              eq(cashRegisterEvents.registerId, register.id),
            ),
          )
          .orderBy(asc(cashRegisterEvents.seq));
        const own = reports
          .filter((row) => registerOf([register], row.body.register))
          .sort((a, b) => Number(a.body.number) - Number(b.body.number));
        items.push({
          id: register.id,
          code: register.code,
          fiscalSeries: register.fiscalSeries,
          location: register.location,
          warehouseId: register.warehouseId,
          activeFrom: register.activeFrom,
          closedOn: events.find((event) => event.kind === 'closed')?.date ?? null,
          events: events.map((event) => ({
            seq: event.seq,
            kind: event.kind,
            date: event.date,
            reference: event.reference,
          })),
          reports: {
            count: own.length,
            first: own[0] ? { number: own[0].body.number, date: own[0].body.issueDate } : null,
            last: own.at(-1)
              ? { number: own.at(-1)!.body.number, date: own.at(-1)!.body.issueDate }
              : null,
          },
          obligations: obligationsOf(register, events),
        });
      }
      return { items, next: null };
    });
  }

  /** Opens a warehouse's accounts at retail price: its goods and their VAT by rate, its markup. */
  setup(actor: Actor, key: string, input: z.infer<typeof setupInput>) {
    return this.commands.run(actor, key, 'retail.setup', input, 'manage', async (tx) => {
      const [store] = await tx
        .select()
        .from(warehouses)
        .where(
          and(eq(warehouses.companyId, actor.companyId), eq(warehouses.id, input.warehouseId)),
        );
      requireCondition(store, 'WAREHOUSE', 'Gestiunea nu există.', 404);
      requireCondition(
        retailCodePattern.test(store.code),
        'RETAIL_WAREHOUSE_CODE',
        `Codul gestiunii ${store.code} nu poate denumi conturi analitice: litere mari, cifre și _.`,
      );
      const wanted = [
        ...input.rates.map((rate) => ({
          code: `371.${store.code}-${rate}`,
          parent: '371',
          name: `Mărfuri la preț cu amănuntul, ${store.name}, cota ${rate}%`,
        })),
        { code: `378.${store.code}`, parent: '378', name: `Adaos comercial, ${store.name}` },
        ...input.rates
          .filter((rate) => rate !== '0')
          .map((rate) => ({
            code: `4428.${store.code}-${rate}`,
            parent: '4428',
            name: `TVA neexigibilă inclusă în prețul cu amănuntul, ${store.name}, cota ${rate}%`,
          })),
      ];
      const parents = new Map(
        (
          await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, actor.companyId),
                inArray(ledgerAccounts.code, ['371', '378', '4428']),
              ),
            )
        ).map((row) => [row.code, row]),
      );
      const existing = new Map(
        (
          await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, actor.companyId),
                inArray(
                  ledgerAccounts.code,
                  wanted.map((row) => row.code),
                ),
              ),
            )
        ).map((row) => [row.code, row]),
      );
      const created: string[] = [];
      for (const row of wanted) {
        const held = existing.get(row.code);
        if (held) {
          requireCondition(
            held.controlKind === 'retail',
            'ACCOUNT_EXISTS',
            `Contul ${row.code} există deja, în afara metodei prețului cu amănuntul.`,
            409,
          );
          continue;
        }
        const parent = parents.get(row.parent);
        requireCondition(
          parent?.postable,
          'ACCOUNT_PARENT',
          `Contul ${row.parent} nu este utilizabil.`,
        );
        await tx.insert(ledgerAccounts).values({
          companyId: actor.companyId,
          code: row.code,
          parentCode: row.parent,
          name: row.name,
          nature: parent!.nature,
          book: parent!.book,
          postable: true,
          controlKind: 'retail',
          saftAccount: parent!.saftAccount,
          validFrom: parent!.validFrom,
          chartVersion: 'company',
          createdBy: actor.actorId,
        });
        created.push(row.code);
      }
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        action: 'retail.setup.accounts',
        body: { warehouseId: store.id, created },
      });
      return { warehouseId: store.id, accounts: wanted.map((row) => row.code) };
    });
  }

  /** A register's daily file (A4203) into a Z report document: its register must be recorded. */
  importZ(actor: Actor, key: string, input: z.infer<typeof importZInput>) {
    return this.commands.run(actor, key, 'retail.importZ', input, 'write', async (tx) => {
      const [file] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Fișierul nu este disponibil.', 404);
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const bytes = new Uint8Array(await this.objects.get(actor.companyId, file.hash));
      const parsed = parseA4203(bytes, { name: company!.name, taxId: company!.cui });
      const { signed, ...body } = parsed;
      const registers = await tx
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.companyId, actor.companyId));
      const register = registerOf(registers, body.register);
      requireCondition(
        register,
        'REGISTER_UNKNOWN',
        `Casa de marcat ${body.register} nu este înregistrată (retail.registers.record).`,
      );
      const problems = zReportProblems(body);
      requireCondition(
        !problems.length,
        'AMEF_TOTALS',
        `Raportul Z al casei de marcat nu se potrivește: ${problems.join(' ')}`,
        422,
        { problems },
      );
      const sourceKey = `amef:${body.register}:${body.number}:${body.issueDate}`;
      const [taken] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, actor.companyId), eq(documents.sourceKey, sourceKey)));
      if (taken) {
        requireCondition(
          taken.bodyHash === hashOf(body),
          'DOCUMENT_CONFLICT',
          'Raportul Z este deja importat cu alt conținut.',
          409,
          { documentId: taken.id },
        );
        return {
          documentId: taken.id,
          created: false,
          register: body.register,
          number: body.number,
          date: body.issueDate,
          signed,
        };
      }
      const id = this.commands.ids();
      const identityKey = documentIdentity(zReportKind, body, company!.cui);
      await tx.insert(documents).values({
        id,
        companyId: actor.companyId,
        kind: zReportKind,
        schema: body.parserVersion,
        body: canonical(body),
        bodyHash: hashOf(body),
        sourceKey,
        evidenceId: file.id,
        origin: 'amef',
        docDate: body.issueDate,
        partyId: null,
        currency: body.currency,
        number: body.number,
        identityKey,
        authority: 'amef',
        createdBy: actor.actorId,
      });
      await joinIdentityGroup(tx, actor, { id, identityKey });
      return {
        documentId: id,
        created: true,
        register: body.register,
        number: body.number,
        date: body.issueDate,
        signed,
      };
    });
  }

  /** A warehouse at retail price on a date: its goods and the VAT they include by rate, its
   * markup, and their cost. */
  position(actor: Actor, input: z.infer<typeof positionInput>) {
    return this.commands.read(actor, 'retail.position', async (tx) => {
      const [store] = await tx
        .select()
        .from(warehouses)
        .where(
          and(eq(warehouses.companyId, actor.companyId), eq(warehouses.id, input.warehouseId)),
        );
      requireCondition(store, 'WAREHOUSE', 'Gestiunea nu există.', 404);
      const rows = await retailTurnover(
        tx,
        actor.companyId,
        store.code,
        '1900-01-01',
        input.date ?? '9999-12-31',
      );
      const balance = (account: string, side: 'D' | 'C') => {
        const row = rows.find((item) => item.account === account);
        return row ? (side === 'D' ? row.debit - row.credit : row.credit - row.debit) : 0n;
      };
      const rates = [
        ...new Set(
          rows.flatMap((row) =>
            row.account.startsWith('371.')
              ? [row.account.slice(row.account.lastIndexOf('-') + 1)]
              : [],
          ),
        ),
      ].sort();
      const view = rates.map((rate) => ({
        rate,
        goods: balance(`371.${store.code}-${rate}`, 'D'),
        vat: balance(`4428.${store.code}-${rate}`, 'C'),
      }));
      const markup = balance(`378.${store.code}`, 'C');
      const goods = view.reduce((sum, row) => sum + row.goods, 0n);
      const vat = view.reduce((sum, row) => sum + row.vat, 0n);
      return {
        warehouseId: store.id,
        code: store.code,
        date: input.date ?? null,
        rates: view.map((row) => ({ rate: row.rate, goods: lei(row.goods), vat: lei(row.vat) })),
        markup: lei(markup),
        cost: lei(goods - vat - markup),
      };
    });
  }
}
