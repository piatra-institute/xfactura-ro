import { z } from 'zod';
import {
  profileAt,
  type AssetState,
  type Effect,
  type Issue,
  type Loaded,
  type LineSpec,
  type Treatment,
} from '../../kernel';
import { divRound, formatMoney } from '../../money';
import { monthEnd, monthStart, type LocalDate, type Month } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

const policyMissing = (asset: AssetState) =>
  block(
    'POLICY_MISSING',
    `${asset.number}: înregistrați politica contabilă pentru luna scoaterii din funcțiune (policy.assets.disposal_month).`,
  );

export const depreciationInput = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
  .strict();
export type DepreciationInput = z.infer<typeof depreciationInput>;

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** Whether the month an asset is disposed of is depreciated: the company's accounting policy. */
const disposalMonth = (loaded: Loaded, date: string) =>
  profileAt(loaded, 'policy.assets.disposal_month', date as LocalDate) as
    'included' | 'excluded' | null;

/** Months of use an asset is depreciated for, up to its disposal under the company's policy. */
function monthsUsed(asset: AssetState, through: string, policy: 'included' | 'excluded') {
  return monthIndex(through) - monthIndex(asset.commissionedOn) - (policy === 'excluded' ? 1 : 0);
}

/** Straight-line depreciation booked by the end of the k-th month of use: the value in equal
 * monthly parts, each rounded so the parts add up, the last month reaching the full value. */
export function straightLine(asset: Pick<AssetState, 'value' | 'lifeMonths'>, months: number) {
  const k = BigInt(Math.max(0, Math.min(months, asset.lifeMonths)));
  return divRound(asset.value * k, BigInt(asset.lifeMonths), 'halfAwayFromZero');
}

/**
 * A month's straight-line depreciation of the fixed assets in the register (OMFP 1802/2014 pct.
 * 238): from the month after commissioning until the value is recovered, over the accounting
 * life. Each asset's line carries it as the item, so the ledger holds its accumulated
 * depreciation; a month missed or booked twice stops the next one.
 */
export const assetDepreciation: Treatment<DepreciationInput> = {
  id: 'assets.depreciate',
  version: 1,
  description: 'Amortizarea lunară, liniară, a mijloacelor fixe din registru.',
  input: depreciationInput,
  agent: true,
  summary: "The month's straight-line depreciation of the fixed assets in the register.",
  toolset: 'close',
  subject: (input) => `depreciation:${input.month}`,
  plan: () => ({ assets: true, profile: true }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const start = monthStart(input.month as Month);
    const end = monthEnd(input.month as Month);
    const due: { asset: AssetState; bani: bigint }[] = [];
    for (const asset of loaded.assets.values()) {
      if (asset.commissionedOn >= start) continue;
      if (asset.disposedOn && asset.disposedOn < start) continue;
      if (asset.disposedOn && asset.disposedOn <= end) {
        const policy = disposalMonth(loaded, asset.disposedOn);
        if (!policy) {
          issues.push(policyMissing(asset));
          continue;
        }
        if (policy === 'excluded') continue;
      }
      const k = monthIndex(start) - monthIndex(asset.commissionedOn);
      if (k > asset.lifeMonths) continue;
      const before = straightLine(asset, k - 1);
      if (asset.depreciated !== before) {
        issues.push(
          block(
            'DEPRECIATION_GAP',
            `${asset.number}: amortizarea înregistrată (${formatMoney(asset.depreciated, 'RON')} lei) nu este cea a lunilor anterioare (${formatMoney(before, 'RON')} lei).`,
          ),
        );
        continue;
      }
      const bani = straightLine(asset, k) - before;
      if (bani > 0n) due.push({ asset, bani });
    }
    if (!issues.length && !due.length)
      issues.push(
        block('NOTHING_TO_DEPRECIATE', `Nicio imobilizare de amortizat în ${input.month}.`),
      );
    if (issues.length) return { effect: null, issues };

    const expense = new Map<string, bigint>();
    for (const { asset, bani } of due)
      expense.set(asset.expenseAccount, (expense.get(asset.expenseAccount) ?? 0n) + bani);
    const lines: LineSpec[] = [
      ...[...expense].map(([account, bani]): LineSpec => ({ account, side: 'D', bani })),
      ...due.map(({ asset, bani }): LineSpec => ({
        account: asset.depreciationAccount,
        side: 'C',
        bani,
        analytics: { item: asset.id },
        memo: `${asset.number} ${asset.name}`,
      })),
    ];
    const total = due.reduce((sum, item) => sum + item.bani, 0n);
    const effect: Effect = {
      schema: 'effect@1',
      date: end,
      journalClass: 'general',
      journalCode: 'AMORTIZARE',
      description: `Amortizare ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${due.length} mijloace fixe, amortizare ${formatMoney(total, 'RON')} lei.`,
        details: {
          month: input.month,
          assets: due.map(({ asset, bani }) => ({
            number: asset.number,
            amount: formatMoney(bani, 'RON'),
            accumulated: formatMoney(asset.depreciated + bani, 'RON'),
            value: formatMoney(asset.value, 'RON'),
          })),
          clauses: ['OMFP1802/2014:pct.238'],
        },
      },
    };
    return { effect, issues };
  },
};

export const derecognitionInput = z.object({ assetId: z.uuid() }).strict();
export type DerecognitionInput = z.infer<typeof derecognitionInput>;

/**
 * An asset disposed of leaves the books on its disposal date: its depreciation booked (28x) and
 * the value not yet recovered (6583) against its value (20x, 21x). Its depreciation must first
 * be booked through the disposal, as the company's policy for the disposal month says. A sale's
 * invoice is recognized on its own.
 */
export const assetDerecognition: Treatment<DerecognitionInput> = {
  id: 'assets.derecognize',
  version: 1,
  description: 'Scoaterea din evidență a unui mijloc fix cedat sau casat.',
  input: derecognitionInput,
  agent: true,
  summary: 'Derecognition of a fixed asset that was sold or scrapped.',
  subject: (input) => `asset-disposal:${input.assetId}`,
  plan: () => ({ assets: true, profile: true }),
  evaluate(input, loaded) {
    const asset = loaded.assets.get(input.assetId);
    if (!asset)
      return { effect: null, issues: [block('ASSET', 'Mijlocul fix nu există.', 'assetId')] };
    if (!asset.disposedOn)
      return {
        effect: null,
        issues: [
          block('NOT_DISPOSED', 'Înregistrați întâi scoaterea din funcțiune (assets.dispose).'),
        ],
      };
    const policy = disposalMonth(loaded, asset.disposedOn);
    if (!policy) return { effect: null, issues: [policyMissing(asset)] };
    const due = straightLine(asset, monthsUsed(asset, asset.disposedOn, policy));
    if (asset.depreciated !== due)
      return {
        effect: null,
        issues: [
          block(
            'DEPRECIATION_DUE',
            `${asset.number}: amortizarea până la scoaterea din funcțiune este ${formatMoney(due, 'RON')} lei, înregistrată ${formatMoney(asset.depreciated, 'RON')} lei.`,
          ),
        ],
      };
    const remaining = asset.value - asset.depreciated;
    const lines: LineSpec[] = [
      ...(asset.depreciated
        ? [
            {
              account: asset.depreciationAccount,
              side: 'D' as const,
              bani: asset.depreciated,
              analytics: { item: asset.id },
            },
          ]
        : []),
      ...(remaining ? [{ account: '6583', side: 'D' as const, bani: remaining }] : []),
      {
        account: asset.account,
        side: 'C',
        bani: asset.value,
        memo: `${asset.number} ${asset.name}`,
      },
    ];
    const effect: Effect = {
      schema: 'effect@1',
      date: asset.disposedOn,
      journalClass: 'general',
      journalCode: 'IMOBILIZARI',
      description: `Scoatere din evidență ${asset.number} ${asset.name}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Valoare ${formatMoney(asset.value, 'RON')} lei, amortizată ${formatMoney(asset.depreciated, 'RON')} lei, rămasă ${formatMoney(remaining, 'RON')} lei.`,
        details: { asset: asset.number, policy },
      },
    };
    return { effect, issues: [] };
  },
};
