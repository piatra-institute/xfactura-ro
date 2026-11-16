import { z } from 'zod';
import type { D406Filed } from 'xfactura-core/ro/saft/read';
import { checkMapping, type MappingProblem } from '../mapping/check';
import {
  accountTargetSchema,
  partyBindingSchema,
  partyKey,
  partySourceSchema,
  type Mapping,
} from '../mapping/schema';

const reason = z.string().trim().min(1).max(500).optional();

/**
 * What an operator states for one lab run, in a file under `.private/`: proposed mapping entries
 * accepted as they stand, and unresolved accounts mapped to a stated target. The driver applies
 * them to an in-memory copy of the mapping only; it never writes the mapping file and never sets
 * `confirmedByPerson`.
 */
export const labAssumptionsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The mapping's `company`, when stated, must match it. */
  company: z.string().min(1).optional(),
  /** Who states them: the owner, or the orchestrator acting for the owner in this lab. */
  statedBy: z.string().trim().min(1).max(100),
  accept: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('account'), sourceId: z.string().min(1), reason }),
        z.strictObject({ kind: z.literal('partner'), source: partySourceSchema, reason }),
        z.strictObject({
          kind: z.literal('placeholder'),
          sourceAccountId: z.string().min(1),
          reason,
        }),
      ]),
    )
    .default([]),
  accounts: z
    .array(
      z.strictObject({
        sourceId: z.string().min(1),
        target: accountTargetSchema,
        /** The partner binding of a control account; non-control accounts take none. */
        party: partyBindingSchema.nullable().default(null),
        reason,
      }),
    )
    .default([]),
});
export type LabAssumptions = z.infer<typeof labAssumptionsSchema>;

/** One assumption as applied, named by its path in the assumptions file. */
export type AppliedAssumption = {
  id: string;
  kind: 'accept-account' | 'accept-partner' | 'accept-placeholder' | 'account-target';
  /** The source account it concerns (accounts, placeholders). */
  sourceAccountId?: string;
  /** The partner source it concerns (partners). */
  partner?: z.infer<typeof partySourceSchema>;
  /** The mapping path it applies to. */
  mappingPath: string;
};

export type AssumptionResult = {
  /** The mapping as the run uses it: the file's, with stated targets in memory only. */
  mapping: Mapping;
  applied: AppliedAssumption[];
  /** Mapping problems that still block the run, after the assumptions. */
  blockers: MappingProblem[];
  /** Mapping problems an acceptance waived, with the assumption that waived each. */
  waived: (MappingProblem & { assumption: string })[];
};

export class AssumptionError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`${code}: Presupunerea de laborator nu poate fi aplicată.`);
  }
}

/** Codes an accepted entry stands in for; every other problem still blocks. */
const waivable = new Set(['PLACEHOLDER_UNCONFIRMED', 'PERSON_DECISION_UNCONFIRMED']);

/**
 * Applies a run's lab assumptions to a copy of the mapping and checks it again. An assumption
 * about an entry the mapping does not hold, an acceptance of an unresolved entry, a target for
 * an entry that is not unresolved and two assumptions about one entry are refused.
 */
export function applyLabAssumptions(
  mapping: Mapping,
  filed: readonly D406Filed[],
  assumptions?: LabAssumptions,
): AssumptionResult {
  const effective = structuredClone(mapping);
  const applied: AppliedAssumption[] = [];
  const accepted = new Map<string, string>();
  if (assumptions) {
    if (assumptions.company !== undefined && assumptions.company !== mapping.company)
      throw new AssumptionError('ASSUMPTION_COMPANY_MISMATCH', 'company');
    const concerned = new Set<string>();
    const once = (key: string, path: string) => {
      if (concerned.has(key)) throw new AssumptionError('ASSUMPTION_DUPLICATE', path);
      concerned.add(key);
    };
    assumptions.accept.forEach((item, i) => {
      const id = `accept.${i}`;
      if (item.kind === 'account') {
        const index = mapping.accounts.findIndex((a) => a.sourceId === item.sourceId);
        if (index < 0) throw new AssumptionError('ASSUMPTION_ENTRY_UNKNOWN', id);
        if (mapping.accounts[index]!.target.status === 'unresolved')
          throw new AssumptionError('ASSUMPTION_ACCEPT_UNRESOLVED', id);
        once(`accounts.${index}`, id);
        accepted.set(`accounts.${index}`, id);
        applied.push({
          id,
          kind: 'accept-account',
          sourceAccountId: item.sourceId,
          mappingPath: `accounts.${index}`,
        });
      } else if (item.kind === 'partner') {
        const index = mapping.partners.findIndex(
          (p) => partyKey(p.source) === partyKey(item.source),
        );
        if (index < 0) throw new AssumptionError('ASSUMPTION_ENTRY_UNKNOWN', id);
        if (mapping.partners[index]!.target.status === 'unresolved')
          throw new AssumptionError('ASSUMPTION_ACCEPT_UNRESOLVED', id);
        once(`partners.${index}`, id);
        accepted.set(`partners.${index}`, id);
        applied.push({
          id,
          kind: 'accept-partner',
          partner: item.source,
          mappingPath: `partners.${index}`,
        });
      } else {
        const index = mapping.placeholders.findIndex(
          (p) => p.sourceAccountId === item.sourceAccountId,
        );
        if (index < 0) throw new AssumptionError('ASSUMPTION_ENTRY_UNKNOWN', id);
        once(`placeholders.${index}`, id);
        accepted.set(`placeholders.${index}`, id);
        applied.push({
          id,
          kind: 'accept-placeholder',
          sourceAccountId: item.sourceAccountId,
          mappingPath: `placeholders.${index}`,
        });
      }
    });
    assumptions.accounts.forEach((item, i) => {
      const id = `accounts.${i}`;
      const index = mapping.accounts.findIndex((a) => a.sourceId === item.sourceId);
      if (index < 0) throw new AssumptionError('ASSUMPTION_ENTRY_UNKNOWN', id);
      const entry = effective.accounts[index]!;
      if (entry.target.status !== 'unresolved')
        throw new AssumptionError('ASSUMPTION_TARGET_NOT_UNRESOLVED', id);
      once(`accounts.${index}`, id);
      // The decision stays the rule's: only the target is stated, in this copy.
      entry.target = {
        status: 'mapped',
        account: item.target,
        party: item.party,
        requiresOpenItem: entry.controlKind !== null && entry.controlKind !== 'tax',
      };
      applied.push({
        id,
        kind: 'account-target',
        sourceAccountId: item.sourceId,
        mappingPath: `accounts.${index}`,
      });
    });
  }
  const blockers: MappingProblem[] = [];
  const waived: AssumptionResult['waived'] = [];
  for (const problem of checkMapping(effective, filed)) {
    const assumption = waivable.has(problem.code) ? accepted.get(problem.path) : undefined;
    if (assumption) waived.push({ ...problem, assumption });
    else blockers.push(problem);
  }
  return { mapping: effective, applied, blockers, waived };
}
