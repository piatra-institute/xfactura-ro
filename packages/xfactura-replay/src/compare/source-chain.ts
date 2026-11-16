import type { D406Filed, D406FiledAccount } from 'xfactura-core/ro/saft/read';
import { delta } from './decimal';
import { difference, order, syntheticAccount, type Difference } from './differences';
import { filedBalance, followingDay, sourceAccounts, sourcePeriods } from './filed';

const accountForSummary = (account: D406FiledAccount) =>
  (account.standard && syntheticAccount(account.standard)) ?? account.id!;

/** Compare raw account identities before mapping, so renumbering cannot hide a break. */
export function checkSourceChain(source: readonly D406Filed[]) {
  const periods = sourcePeriods(source);
  const accounts = periods.map(({ filed }) => sourceAccounts(filed));
  const findings: Difference[] = [];
  // Check each stated balance before any mapped-account aggregation can net its two sides.
  for (let index = 0; index < periods.length; index++) {
    for (const [id, account] of accounts[index]!) {
      for (const field of ['opening', 'closing'] as const) {
        if (account[`${field}Debit`] === undefined || account[`${field}Credit`] === undefined)
          continue;
        findings.push(
          difference({
            kind: 'source-balance-both-sides',
            period: periods[index]!.period,
            locator: { sourceAccount: id, field },
            accounts: [accountForSummary(account)],
            source: { debit: account[`${field}Debit`]!, credit: account[`${field}Credit`]! },
            engine: null,
          }),
        );
      }
    }
  }
  let transitionsChecked = 0;
  let accountsCompared = 0;
  for (let index = 1; index < periods.length; index++) {
    const previous = periods[index - 1]!;
    const next = periods[index]!;
    if (followingDay(previous.to) !== next.from) {
      findings.push(
        difference({
          kind: 'source-chain-gap',
          period: next.period,
          locator: { previousPeriod: previous.period },
          source: previous.to,
          engine: next.from,
        }),
      );
      continue;
    }
    transitionsChecked++;
    const left = accounts[index - 1]!;
    const right = accounts[index]!;
    for (const id of [...new Set([...left.keys(), ...right.keys()])].sort(order)) {
      const a = left.get(id);
      const b = right.get(id);
      const locator = { sourceAccount: id, previousPeriod: previous.period };
      const summaryAccounts = [accountForSummary(b ?? a!)];
      if (!a || !b) {
        findings.push(
          difference({
            kind: a ? 'source-chain-only-previous' : 'source-chain-only-next',
            period: next.period,
            locator,
            accounts: summaryAccounts,
            source: a ? filedBalance(a, 'closing') : null,
            engine: b ? filedBalance(b, 'opening') : null,
          }),
        );
        continue;
      }
      accountsCompared++;
      const closing = filedBalance(a, 'closing');
      const opening = filedBalance(b, 'opening');
      for (const side of ['debit', 'credit'] as const) {
        const source = closing[side];
        const engine = opening[side];
        if (source !== null && engine !== null && source === engine) continue;
        findings.push(
          difference({
            kind:
              source === null || engine === null ? 'source-chain-evidence' : 'source-chain-balance',
            period: next.period,
            locator: { ...locator, field: side },
            accounts: summaryAccounts,
            source,
            engine,
            ...(source !== null && engine !== null ? { delta: delta(engine, source) } : {}),
          }),
        );
      }
    }
  }
  const byKind = new Map<string, number>();
  for (const finding of findings) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  return {
    findings,
    counts: {
      transitionsChecked,
      accountsCompared,
      byKind: Object.fromEntries([...byKind].sort(([a], [b]) => order(a, b))),
    },
  };
}
