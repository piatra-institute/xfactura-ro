import type { D406Filed, D406FiledAccount, D406FiledTransaction } from 'xfactura-core/ro/saft/read';
import { addDays, isLocalDate, monthEnd, monthOf, parseLocalDate } from 'xfactura-core/time';
import { amount } from './decimal';
import { fail, order } from './differences';

export type Period = { period: string; from: string; to: string };
export type BalancePair = { debit: string | null; credit: string | null };

export function reportingPeriod(from: string | undefined, to: string | undefined): Period {
  if (!from || !to || !isLocalDate(from) || !isLocalDate(to) || from > to)
    fail('COMPARISON_PERIOD', 'Intervalul de raportare lipsește sau nu este valid.');
  const month = monthOf(parseLocalDate(from));
  return {
    from,
    to,
    period: from.endsWith('-01') && to === monthEnd(month) ? month : `${from}/${to}`,
  };
}

export const filedPeriod = (filed: D406Filed) =>
  reportingPeriod(filed.header.selection.start, filed.header.selection.end);
export const followingDay = (date: string) => addDays(parseLocalDate(date), 1);

export function transactionPeriod(transaction: D406FiledTransaction): string {
  if (
    !/^\d{4}$/.test(transaction.periodYear ?? '') ||
    !/^(?:0?[1-9]|1[0-2])$/.test(transaction.period ?? '')
  )
    fail(
      'COMPARISON_TRANSACTION_PERIOD',
      'Perioada notei lipsește sau nu este o lună calendaristică.',
    );
  return `${transaction.periodYear}-${transaction.period!.padStart(2, '0')}`;
}

export function sourcePeriods(source: readonly D406Filed[]) {
  const companies = new Set(
    source.flatMap((filed) => filed.header.company.registrationNumber ?? []),
  );
  if (companies.size > 1)
    fail('COMPARISON_COMPANY', 'Fișierele trebuie să aparțină aceleiași companii.');
  const periods = source
    .map((filed) => {
      if (filed.header.totalSegments && filed.header.totalSegments !== '1')
        fail(
          'COMPARISON_SEGMENTS',
          'Comparația necesită o declarație completă, fără segmente separate.',
        );
      return { ...filedPeriod(filed), filed };
    })
    .sort((a, b) => order(a.from, b.from));
  for (let index = 1; index < periods.length; index++)
    if (periods[index - 1]!.to >= periods[index]!.from)
      fail(
        'COMPARISON_PERIOD_OVERLAP',
        'Selectați o singură declarație pentru fiecare interval, fără suprapuneri.',
      );
  return periods;
}

export function sourceAccounts(filed: D406Filed): Map<string, D406FiledAccount> {
  const accounts = new Map<string, D406FiledAccount>();
  for (const account of filed.masterFiles.accounts) {
    if (!account.id) fail('COMPARISON_ACCOUNT_ID', 'Un cont sursă nu are identificator.');
    if (accounts.has(account.id))
      fail('COMPARISON_ACCOUNT_DUPLICATE', 'Un identificator de cont sursă este duplicat.');
    accounts.set(account.id, account);
  }
  return accounts;
}

/** D406 balances use a debit/credit choice. A stated side establishes the absent opposite
 * side as zero; neither side present (or an invalid stated side) remains unknown. */
export function filedBalance(account: D406FiledAccount, field: 'opening' | 'closing'): BalancePair {
  const debit = amount(account[`${field}Debit`]);
  const credit = amount(account[`${field}Credit`]);
  return {
    debit: account[`${field}Debit`] === undefined && credit !== null ? '0' : debit,
    credit: account[`${field}Credit`] === undefined && debit !== null ? '0' : credit,
  };
}
