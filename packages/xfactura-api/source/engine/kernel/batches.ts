import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { effectAmount } from 'xfactura-core/templates';
import { bucharestDate } from 'xfactura-core/time';
import type { ActionHandler } from './actions';
import { selfApproval, segregationOn } from './controls';
import type { BatchMember, MemberState, Proposals } from './proposals';
import type { StoredEffect } from './views';

/*
 * Batch approval (`proposals.batch`): a person approves up to 200 exact proposal versions at
 * once, on a preview of what they book together, totals per account and per tax code. It is a
 * reviewed action: anyone who may write requests it, a person approves its preview hash, and the
 * execution (an agent may run it) recomputes the preview and, only if nothing changed, records
 * one approval per member in the decider's name and posts every member, in one transaction.
 * A version with warnings to acknowledge is approved alone, never in a batch.
 */

const member = z
  .object({
    proposalId: z.uuid(),
    version: z.number().int().positive(),
    effectHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const batchInput = z
  .object({ members: z.array(member).min(1).max(200) })
  .strict()
  .refine(
    (input) => new Set(input.members.map((item) => item.proposalId)).size === input.members.length,
    { message: 'Fiecare propunere apare o singură dată în lot.', path: ['members'] },
  );
export type BatchInput = z.infer<typeof batchInput>;

/** Why a member cannot be approved in a batch, as the preview's blocking findings name it. */
const findings: Record<Exclude<MemberState, 'ready'>, { code: string; message: string }> = {
  missing: { code: 'BATCH_MISSING', message: 'Propunerea nu există.' },
  superseded: {
    code: 'BATCH_SUPERSEDED',
    message: 'Propunerea are o versiune mai nouă decât cea din lot.',
  },
  changed: { code: 'BATCH_CHANGED', message: 'Amprenta efectului diferă de versiunea propunerii.' },
  posted: { code: 'BATCH_POSTED', message: 'Propunerea este deja contabilizată.' },
  withdrawn: { code: 'BATCH_WITHDRAWN', message: 'Propunerea a fost retrasă.' },
  blocked: { code: 'BATCH_BLOCKED', message: 'Propunerea are probleme care împiedică aprobarea.' },
  acknowledgement: {
    code: 'BATCH_ACKNOWLEDGEMENT',
    message: 'Propunerea are avertismente de confirmat: se aprobă separat, nu în lot.',
  },
  stale: {
    code: 'BATCH_STALE',
    message: 'Registrele s-au schimbat de la evaluarea propunerii: revizuiți-o.',
  },
};

type MemberView = {
  proposalId: string;
  version: number;
  effectHash: string;
  state: MemberState;
  treatment: string | null;
  subject: string | null;
  date: string | null;
  description: string | null;
  amount: string | null;
};
type Preview = {
  members: MemberView[];
  totals: {
    accounts: { account: string; debit: string; credit: string }[];
    taxes: {
      tax: string;
      code: string;
      direction: string;
      base: string;
      amount: string;
      deductible: string;
    }[];
    gross: string;
  };
  count: number;
  findings: { code: string; severity: 'block'; message: string; items: string[] }[];
};

const ron = (bani: bigint) => formatMoney(bani, 'RON');

/** The reviewed batch approval, on the engine's proposals and clock. */
export function batchHandler(proposals: Proposals, clock: () => number): ActionHandler<BatchInput> {
  /** Each member re-evaluated, with what the ready ones book together. */
  const preview: ActionHandler<BatchInput>['preview'] = async (tx, companyId, input) => {
    const members: MemberView[] = [];
    const accounts = new Map<string, { debit: bigint; credit: bigint }>();
    const taxes = new Map<string, { base: bigint; amount: bigint; deductible: bigint }>();
    let gross = 0n;
    for (const named of input.members) {
      const found = await proposals.batchMember(tx, companyId, named);
      const effect = found.row?.effect ? (JSON.parse(found.row.effect) as StoredEffect) : null;
      members.push({
        ...named,
        state: found.state,
        treatment: found.proposal?.treatmentId ?? null,
        subject: found.proposal?.subjectKey ?? null,
        date: effect?.date ?? null,
        description: effect?.description ?? null,
        amount: effect ? ron(effectAmount(effect)) : null,
      });
      if (found.state !== 'ready' || !effect) continue;
      gross += effectAmount(effect);
      for (const line of effect.lines) {
        const totals = accounts.get(line.account) ?? { debit: 0n, credit: 0n };
        if (line.side === 'D') totals.debit += BigInt(line.bani);
        else totals.credit += BigInt(line.bani);
        accounts.set(line.account, totals);
      }
      for (const entry of effect.taxEntries) {
        const key = `${entry.tax}|${entry.code}|${entry.direction}`;
        const totals = taxes.get(key) ?? { base: 0n, amount: 0n, deductible: 0n };
        totals.base += BigInt(entry.baseBani);
        totals.amount += BigInt(entry.taxBani);
        totals.deductible += BigInt(entry.deductibleBani);
        taxes.set(key, totals);
      }
    }
    const refused = Object.entries(findings).flatMap(([state, finding]) => {
      const items = members.filter((item) => item.state === state).map((item) => item.proposalId);
      return items.length ? [{ ...finding, severity: 'block' as const, items }] : [];
    });
    const value: Preview = {
      members,
      totals: {
        accounts: [...accounts.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([account, totals]) => ({
            account,
            debit: ron(totals.debit),
            credit: ron(totals.credit),
          })),
        taxes: [...taxes.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, totals]) => {
            const [tax, code, direction] = key.split('|') as [string, string, string];
            return {
              tax,
              code,
              direction,
              base: ron(totals.base),
              amount: ron(totals.amount),
              deductible: ron(totals.deductible),
            };
          }),
        gross: ron(gross),
      },
      count: members.length,
      findings: refused,
    };
    return { blocking: refused.length > 0, preview: JSON.parse(canonical(value)) as JsonValue };
  };

  return {
    operation: 'proposals.batch',
    permission: 'write',
    input: batchInput,
    preview,

    /** Segregation of duties holds per member: the decider may approve every version. */
    async approvable(tx, companyId, decider, input) {
      const segregation = await segregationOn(tx, companyId, bucharestDate(clock()));
      if (segregation === 'off') return;
      const refused: string[] = [];
      for (const named of input.members) {
        const work = await proposals.authorOf(tx, companyId, named);
        if (work && selfApproval(segregation, decider, work)) refused.push(named.proposalId);
      }
      requireCondition(
        !refused.length,
        'SEGREGATION',
        'Separarea atribuțiilor: lotul cuprinde propuneri pe care nu le puteți aproba; scoateți-le din lot.',
        403,
        { segregation, members: refused },
      );
    },

    /** The members whose line in the preview changed, and what they are now. */
    changes(approved, current) {
      const before = new Map(
        ((approved as Preview).members ?? []).map((item) => [item.proposalId, item]),
      );
      return {
        members: ((current as Preview).members ?? [])
          .filter((item) => {
            const was = before.get(item.proposalId);
            return !was || canonical(was) !== canonical(item);
          })
          .map((item) => ({
            proposalId: item.proposalId,
            before: before.get(item.proposalId)?.state ?? null,
            after: item.state,
          })),
      };
    },

    async execute(tx, actor, input, requestId, _preview, { decision }) {
      const segregation = await segregationOn(tx, actor.companyId, bucharestDate(clock()));
      const posted = [];
      for (const named of input.members as BatchMember[])
        posted.push(
          await proposals.postBatchMember(tx, actor, named, {
            requestId,
            decidedBy: decision.decidedBy,
            decidedEpoch: decision.decidedEpoch,
            segregation,
          }),
        );
      return { posted, count: posted.length };
    },
  };
}
