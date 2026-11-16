import { addDays, parseLocalDate } from 'xfactura-core/time';
import type { Engine } from '../../../xfactura-api/source/engine/engine';
import type { ProposalView } from '../../../xfactura-api/source/engine/kernel/views';
import type { EngineBalancePeriod } from './balances';
import type { EngineJournalEntry } from './journals';
import { fail } from './differences';
import { reportingPeriod } from './filed';

export type ReadOperation = <T>(operation: string, input: unknown) => Promise<T>;
type TrialBalance = Awaited<ReturnType<Engine['reports']['trialBalance']>>;
type Journal = Awaited<ReturnType<Engine['reports']['journal']>>;

/** Reads complete operation results as a person permitted to read the private books.
 * Opening balances are obtained from the engine, never recomputed from annual turnover. */
export async function readEngineBalances(
  read: ReadOperation,
  financialYearId: string,
  from: string,
  to: string,
): Promise<EngineBalancePeriod> {
  const period = reportingPeriod(from, to);
  const current = await read<TrialBalance>('ledger.trialBalance', { financialYearId, from, to });
  if (current.from !== from || current.to !== to)
    fail('COMPARISON_ENGINE_RANGE', 'Motorul a returnat alt interval de raportare.');
  const previous =
    from === current.year.from
      ? null
      : await read<TrialBalance>('ledger.trialBalance', {
          financialYearId,
          from: current.year.from,
          to: addDays(parseLocalDate(from), -1),
        });
  const openings = new Map(previous?.rows.map((row) => [row.account, row.closing]));
  if (
    previous &&
    (previous.from !== current.year.from || previous.to !== addDays(parseLocalDate(from), -1))
  )
    fail('COMPARISON_ENGINE_RANGE', 'Motorul a returnat alt interval pentru soldul inițial.');
  return {
    ...period,
    rows: current.rows.map((row) => ({
      account: row.account,
      values: {
        opening: openings.get(row.account) ?? row.opening,
        debitTurnover: row.current.debit,
        creditTurnover: row.current.credit,
        closing: row.closing,
      },
    })),
  };
}

/** ledger.journal supplies posted lines; proposals.get supplies the bound subject and taxes.
 * Refuse incomplete/redacted reads rather than comparing a partial journal. */
export async function readEngineJournals(
  read: ReadOperation,
  from: string,
  to: string,
  limit = 500,
): Promise<EngineJournalEntry[]> {
  reportingPeriod(from, to);
  const result: EngineJournalEntry[] = [];
  const ids = new Set<string>();
  let after = 0;
  for (;;) {
    const page = await read<Journal>('ledger.journal', { from, to, after, limit });
    for (const entry of page.entries) {
      if (
        ids.has(entry.id) ||
        entry.seq <= after ||
        ('redacted' in entry && entry.redacted) ||
        entry.lines.some(
          (line) => typeof line.amount !== 'string' || ('includes' in line && line.includes),
        )
      )
        fail('COMPARISON_ENGINE_REDACTED', 'Registrul este incomplet, duplicat sau redactat.');
      ids.add(entry.id);
      const proposal = await read<ProposalView>('proposals.get', {
        id: entry.proposalId,
        recheck: false,
      });
      if (proposal.redacted) fail('COMPARISON_ENGINE_REDACTED', 'Propunerea este redactată.');
      if (
        !proposal.effect ||
        proposal.entry?.id !== entry.id ||
        proposal.effect.date !== entry.date ||
        proposal.status !== 'posted'
      )
        fail('COMPARISON_ENGINE_BINDING', 'Propunerea citită nu este legată de nota înregistrată.');
      result.push({
        id: entry.id,
        subject: proposal.subject,
        date: entry.date,
        lines: entry.lines.map((line) => ({
          account: line.account,
          side: line.side,
          amount: line.amount!,
        })),
        taxEntries: proposal.effect.taxEntries.map((tax) => ({
          code: tax.code,
          base: tax.base,
          tax: tax.amount,
          deductible: tax.deductible,
          period: tax.taxPeriod,
        })),
      });
    }
    if (page.next === null) return result;
    if (page.next <= after || !page.entries.length || page.next !== page.entries.at(-1)!.seq)
      fail('COMPARISON_ENGINE_CURSOR', 'Paginarea registrului nu avansează.');
    after = page.next;
  }
}
