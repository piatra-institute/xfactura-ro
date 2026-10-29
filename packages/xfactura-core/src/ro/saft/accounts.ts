import { chartAmendments, referenceChart, type ChartAccount } from '../chart';
import { standardAccounts } from './data/accounts';

/**
 * How the engine's OMFP 1802/2014 accounts map to ANAF's standard chart for general commercial
 * companies (PlanConturiBalSocCom, TaxAccountingBasis A). ANAF's chart is OMFP 1802 with its
 * amendments, so every postable synthetic account of the engine's chart is a standard account
 * of the same code, except where ANAF lists subdivisions the engine posts on the synthetic: those
 * are ambiguous and the caller names the standard account.
 */

/** Synthetic accounts whose standard account the caller chooses, with the choices. 635 keeps its
 * own code for the taxes 6351 does not cover. */
export const d406AmbiguousAccounts: Readonly<Record<string, readonly string[]>> = {
  '605': ['6051', '6052', '6053', '6058'],
  '612': ['6121', '6122', '6123'],
  '623': ['6231', '6232'],
  '635': ['635', '6351'],
  '646': ['6461', '6462'],
};

const engineAccounts = new Map<string, ChartAccount>(
  [...referenceChart.accounts, ...chartAmendments.flatMap((amendment) => amendment.accounts)].map(
    (account) => [account.code, account],
  ),
);

/** The synthetic account of an engine code: 4111.01 → 4111. */
export const syntheticOf = (code: string) => code.split('.')[0]!;

/** The engine chart's account of a synthetic code, amendments included. */
export const chartAccount = (synthetic: string) => engineAccounts.get(synthetic);

/**
 * StandardAccountID of an engine account: the synthetic's own code, or for an ambiguous
 * synthetic the caller's choice when it is one of the choices. Undefined when unmapped.
 */
export function d406StandardAccount(code: string, choice?: string): string | undefined {
  const synthetic = syntheticOf(code);
  const choices = d406AmbiguousAccounts[synthetic];
  if (choices) return choice !== undefined && choices.includes(choice) ? choice : undefined;
  if (choice !== undefined) return choice === synthetic ? synthetic : undefined;
  return standardAccounts[synthetic] === undefined ? undefined : synthetic;
}

/** AccountType: the balance side of the synthetic in the engine's chart. */
export function d406AccountType(code: string): 'Activ' | 'Pasiv' | 'Bifunctional' | undefined {
  const balance = chartAccount(syntheticOf(code))?.balance;
  if (balance === undefined) return undefined;
  return balance === 'debit' ? 'Activ' : balance === 'credit' ? 'Pasiv' : 'Bifunctional';
}

/**
 * AccountID: the validator reads it as an integer whose first three or four digits are an
 * account of the standard chart (ANAF's example: 4426 analytical 0001 is 44260001). An engine
 * code with numeric segments writes as its digits (4111.01 → 411101). Undefined, so that the
 * caller gives one, when a segment is not numeric or when a three-digit synthetic with
 * four-digit subdivisions would read as one of them (605.1 → 6051).
 */
export function d406AccountId(code: string): string | undefined {
  if (!/^[1-9]\d{1,3}(?:\.\d+)*$/.test(code)) return undefined;
  const synthetic = syntheticOf(code);
  const digits = code.replace(/\./g, '');
  if (
    digits !== synthetic &&
    synthetic.length === 3 &&
    Object.keys(standardAccounts).some((other) => other.length === 4 && other.startsWith(synthetic))
  )
    return undefined;
  return digits;
}

const standardCodes = Object.keys(standardAccounts);

/**
 * Whether an AccountID passes the validator's plan check: its first three digits are an account
 * of the standard chart and, while the chart subdivides the prefix, the id at full length is not
 * an unknown subdivision (4429 fails, 44290001 and 411101 pass).
 */
export function d406InStandardChart(id: string): boolean {
  let prefix = id.slice(0, 3);
  if (standardAccounts[prefix] === undefined) return false;
  let children = standardCodes;
  for (let length = 4; length <= id.length; length += 1) {
    const parent = prefix;
    children = children.filter((code) => code !== parent && code.startsWith(parent));
    if (!children.length) return true;
    prefix = id.slice(0, length);
    if (!children.includes(prefix) && id.length === length) return false;
  }
  return true;
}

/** Postable engine accounts (classes 1–8, amendments included) and their standard accounts;
 * ambiguous ones map to their choices. */
export function d406AccountMapping(): { code: string; standard: string | readonly string[] }[] {
  return [...engineAccounts.values()]
    .filter((account) => account.postable && /^[1-8]/.test(account.code))
    .map((account) => ({
      code: account.code,
      standard: d406AmbiguousAccounts[account.code] ?? d406StandardAccount(account.code) ?? [],
    }));
}
