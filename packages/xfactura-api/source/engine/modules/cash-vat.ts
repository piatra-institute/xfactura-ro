import { and, eq, gte, inArray, isNotNull, isNull, lte, not, like, sql } from 'drizzle-orm';
import { profileAt } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { cashVatClauses } from 'xfactura-core/ro/cash-vat';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { entries, lines, openItems, taxEntries } from '../db/schema';
import type { CloseCheck, Finding } from '../kernel/periods';
import { loadState } from '../kernel/state';

const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;
const invoiceOf = sql<string>`json_extract(${taxEntries.attributes}, '$.invoice')`;

/**
 * Month-close warnings of VAT on collection: invoices settled in full whose VAT is still deferred
 * on 4428 (a settlement outside collections and payments, which releases nothing), a company in
 * the system whose turnover of the year exceeds the system's ceiling (art. 282 alin. (5), with
 * the notification of art. 324 alin. (14)), and a company leaving the system during the year,
 * which alin. (5) allows only past the ceiling or by notification after its first year.
 */
export function cashVatChecks(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): CloseCheck[] {
  return [
    {
      id: 'vat.cashUnreleased',
      async run(tx, companyId, month) {
        const end = monthEnd(month as Month);
        // The deferral each invoice still holds at the month's end.
        const deferred = await tx
          .select({
            invoice: invoiceOf,
            vat: sql<bigint>`sum(${taxEntries.taxBani})`.mapWith(BigInt),
            ledger: sql<bigint>`sum(${taxEntries.ledgerBani})`.mapWith(BigInt),
          })
          .from(taxEntries)
          .innerJoin(
            entries,
            and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
          )
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.tax, 'VAT'),
              isNull(taxEntries.exigibility),
              isNotNull(invoiceOf),
              lte(entries.date, end),
            ),
          )
          .groupBy(invoiceOf);
        const open = deferred.filter((row) => row.vat !== 0n || row.ledger !== 0n);
        if (!open.length) return [];
        // Their invoices' receivables and payables, settled by the month's end.
        const items = await tx
          .select({
            documentId: openItems.documentId,
            balance: sql<bigint>`coalesce(sum(${sign} * ${lines.bani}), 0)`.mapWith(BigInt),
          })
          .from(openItems)
          .innerJoin(
            lines,
            and(eq(lines.companyId, openItems.companyId), eq(lines.openItemId, openItems.id)),
          )
          .innerJoin(
            entries,
            and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
          )
          .where(
            and(
              eq(openItems.companyId, companyId),
              inArray(openItems.kind, ['receivable', 'payable']),
              inArray(
                openItems.documentId,
                open.map((row) => row.invoice),
              ),
              lte(entries.date, end),
            ),
          )
          .groupBy(openItems.id);
        const settled = new Set(
          items.filter((item) => item.balance === 0n).map((item) => item.documentId),
        );
        const stuck = open.filter((row) => settled.has(row.invoice));
        return stuck.length
          ? [
              {
                code: 'CASH_VAT_UNRELEASED',
                severity: 'warn' as const,
                message: `${stuck.length} facturi în sistemul TVA la încasare sunt stinse la ${end}, dar TVA lor (${formatMoney(
                  stuck.reduce((sum, row) => sum + row.vat, 0n),
                  'RON',
                )} lei) a rămas neexigibilă în 4428: stingerea nu a fost o încasare sau o plată. Compensările și cesiunile de creanțe sunt încasări (norme pct. 26 alin. (7)–(9)); verificați și stornați nota care a stins factura.`,
                count: stuck.length,
                items: stuck.slice(0, 20).map((row) => row.invoice),
              },
            ]
          : [];
      },
    },
    {
      id: 'vat.cashCeiling',
      async run(tx, companyId, month) {
        const end = monthEnd(month as Month);
        const { loaded } = await loadState(tx, companyId, { profile: true });
        if (profileAt(loaded, 'vat.cash', end) !== 'yes') return [];
        const start = `${month}-01` as LocalDate;
        let ceiling: string;
        try {
          ceiling = (await rules(tx, companyId)).param<string>(
            'ro.vat.cash.ceiling',
            'reporting_period_start',
            start,
          );
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          return [{ code: 'RULE_GAP', severity: 'warn', message: error.message }];
        }
        // The turnover as the returns of the year declare it: the base of the supplies whose
        // VAT became chargeable, taxable or with the place of supply abroad (norme pct. 26
        // alin. (4)); a reverse charge's collected side is an acquisition.
        const [row] = await tx
          .select({ base: sql<bigint>`coalesce(sum(${taxEntries.baseBani}), 0)`.mapWith(BigInt) })
          .from(taxEntries)
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.tax, 'VAT'),
              eq(taxEntries.direction, 'output'),
              isNotNull(taxEntries.exigibility),
              gte(taxEntries.exigibility, `${month.slice(0, 4)}-01-01`),
              lte(taxEntries.exigibility, end),
              not(like(taxEntries.code, 'RC-%')),
            ),
          );
        const turnover = row?.base ?? 0n;
        const findings: Finding[] = [];
        if (turnover > parseMoney(ceiling, 'RON'))
          findings.push({
            code: 'CASH_VAT_CEILING',
            severity: 'warn',
            message: `Cifra de afaceri declarată în ${month.slice(0, 4)} până la ${end} (${formatMoney(turnover, 'RON')} lei) depășește plafonul sistemului TVA la încasare (${ceiling} lei, ${cashVatClauses.chargeability}): compania notifică depășirea până la data de 20 a lunii următoare perioadei fiscale în care a avut loc (art. 324 alin. (14)) și aplică sistemul până la sfârșitul perioadei fiscale următoare (art. 282 alin. (5)); înregistrați ieșirea din sistem în profil.`,
          });
        return findings;
      },
    },
    {
      id: 'vat.cashExit',
      async run(tx, companyId, month) {
        const end = monthEnd(month as Month);
        const { loaded } = await loadState(tx, companyId, { profile: true });
        const exit = loaded.profile.find(
          (fact) =>
            fact.axis === 'vat.cash' &&
            fact.value === 'no' &&
            fact.effectiveFrom.startsWith(month) &&
            !fact.effectiveFrom.endsWith('-01-01'),
        );
        if (!exit || profileAt(loaded, 'vat.cash', end) !== 'no') return [];
        const before = loaded.profile.filter(
          (fact) => fact.axis === 'vat.cash' && fact.effectiveFrom < exit.effectiveFrom,
        );
        if (before.at(-1)?.value !== 'yes') return [];
        return [
          {
            code: 'CASH_VAT_EXIT',
            severity: 'warn',
            message: `Compania iese din sistemul TVA la încasare la ${exit.effectiveFrom}, în cursul anului: sistemul se aplică cel puțin până la sfârșitul anului, cu excepția depășirii plafonului (până la sfârșitul perioadei fiscale următoare) și a renunțării notificate între 1 și 20 ale lunii, nu în primul an (art. 282 alin. (5) din Codul fiscal). Facturile emise înainte de ieșire rămân în sistem (alin. (7) lit. b)).`,
          },
        ];
      },
    },
  ];
}
