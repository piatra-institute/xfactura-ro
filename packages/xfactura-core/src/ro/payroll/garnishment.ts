import type { RuleContext } from '../../rules';
import { monthStart, type Month } from '../../time';
import type { GarnishmentLimits } from './parameters';

/**
 * Garnishments on salary (popriri): what an employer, as garnishee, withholds from an employee's
 * net pay for the creditors whose orders it received, and owes them on 427.
 *
 * - The order of the creditors (Codul muncii art. 169 alin. (3)): maintenance, then contributions
 *   and taxes owed to the state, damages to public property, any other debt; the orders of one
 *   rank in the order they were received.
 * - The limits (Codul de procedură civilă art. 729, as consolidated on 14.12.2025): up to half of
 *   the net monthly income for maintenance, up to a third for any other debt, half in all when
 *   there are several; deductions together never more than half of the net salary (Codul muncii
 *   art. 169 alin. (4)). The third is read as one limit for all the debts other than maintenance
 *   together (`ro.garnishment.limits`, an interpretation awaiting review).
 * - Each order takes what it states (a monthly amount, or a share of the net), never more than its
 *   debt still owed nor the limits.
 *
 * Not computed, and refused: a net income below the net minimum wage (art. 729 alin. (3): only
 * the part above half of it; the code defines neither that minimum nor how the limits combine with
 * it), and a month with indemnities of temporary incapacity, maternity or child care, which the
 * code protects apart (alin. (4)–(7)).
 */

export const garnishmentKinds = ['maintenance', 'state', 'public_damage', 'other'] as const;
export type GarnishmentKind = (typeof garnishmentKinds)[number];

export interface GarnishmentOrder {
  id: string;
  kind: GarnishmentKind;
  /** When the employer received it: the order within a rank. */
  receivedOn: string;
  /** What the order says to withhold each month: an amount in bani, or a share of the net. */
  monthly: { amount: bigint } | { share: [number, number] };
  /** The debt still owed, in bani. */
  remaining: bigint;
}

export interface Garnished {
  orderId: string;
  amount: bigint;
}

export type GarnishmentIssue = { code: string; message: string };

const rank = (kind: GarnishmentKind) => garnishmentKinds.indexOf(kind);
const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
/** `amount × numerator / denominator`, rounded down to the leu: what is withheld is never more
 * than the limit. */
const part = (amount: bigint, [numerator, denominator]: readonly [number, number]) =>
  ((amount * BigInt(numerator)) / BigInt(denominator) / 100n) * 100n;

/**
 * What each order takes from a month's net pay (`net`, in bani: the money paid after CAS, CASS,
 * the tax and union dues), in the Labour Code's order and within the limits.
 */
export function garnish(
  month: Month,
  net: bigint,
  orders: readonly GarnishmentOrder[],
  context: { minimumNet: bigint | null; protectedIndemnities: boolean },
  rules: RuleContext,
): {
  withheld: Garnished[];
  issues: GarnishmentIssue[];
  steps: { code: string; amount: bigint; clauses: readonly string[] }[];
} {
  const issues: GarnishmentIssue[] = [];
  const steps: { code: string; amount: bigint; clauses: readonly string[] }[] = [];
  const active = orders.filter((order) => order.remaining > 0n);
  if (!active.length) return { withheld: [], issues, steps };
  if (context.protectedIndemnities)
    issues.push({
      code: 'GARNISHMENT_INDEMNITY',
      message:
        'În lună salariatul are indemnizații de asigurări sociale de sănătate, pe care Codul de procedură civilă (art. 729 alin. (4)–(7)) le urmărește separat: reținerea nu este calculată de aplicație.',
    });
  if (context.minimumNet === null || net < context.minimumNet)
    issues.push({
      code: 'GARNISHMENT_LOW_INCOME',
      message:
        'Venitul net este sub salariul minim net pe economie (sau acesta nu este cunoscut): Codul de procedură civilă (art. 729 alin. (3)) permite urmărirea doar a părții peste jumătatea lui, ceea ce aplicația nu calculează.',
    });
  if (net <= 0n)
    issues.push({ code: 'GARNISHMENT_NET', message: 'Nu există venit net din care să se rețină.' });
  if (issues.length) return { withheld: [], issues, steps };
  const limits = rules.param<GarnishmentLimits>(
    'ro.garnishment.limits',
    'payroll_month_start',
    monthStart(month),
  );
  const clauses = ['L134/2010-A:art.729', 'L53/2003-A:art.169'];
  const several = new Set(active.map((order) => order.id)).size > 1;
  let left = min(part(net, limits.cumulative), several ? part(net, limits.several) : net);
  let maintenanceLeft = part(net, limits.maintenance);
  let otherLeft = part(net, limits.other);
  steps.push({ code: 'garnishment.limit', amount: left, clauses });
  const withheld: Garnished[] = [];
  const sorted = [...active].sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      a.receivedOn.localeCompare(b.receivedOn) ||
      a.id.localeCompare(b.id),
  );
  for (const order of sorted) {
    const stated =
      'amount' in order.monthly ? order.monthly.amount : part(net, order.monthly.share);
    const kindLeft = order.kind === 'maintenance' ? maintenanceLeft : otherLeft;
    const amount = min(stated, order.remaining, left, kindLeft);
    if (amount <= 0n) continue;
    left -= amount;
    if (order.kind === 'maintenance') maintenanceLeft -= amount;
    else otherLeft -= amount;
    withheld.push({ orderId: order.id, amount });
    steps.push({ code: `garnishment.${order.kind}`, amount, clauses });
  }
  return { withheld, issues, steps };
}
