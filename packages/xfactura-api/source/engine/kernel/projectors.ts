import type { Database } from '../db/database';
import type { AuditEvent } from './events';
import type { Consumer } from './jobs';
import { saveCheck, type Proposals } from './proposals';

/** A projection the worker keeps up to date from each company's audit log. */
export interface Projector {
  name: string;
  /** Brings the projection up to date with these events, idempotently; false when it stopped
   * short (a budget) and needs the same events again. */
  project(companyId: string, events: AuditEvent[]): Promise<boolean>;
}

/** The worker's `project` consumer: every projector over each company's new events. */
export function projectConsumer(projectors: Projector[]): Consumer {
  return {
    name: 'project',
    async handle(companyId, events) {
      let done = true;
      for (const projector of projectors)
        done = (await projector.project(companyId, events)) && done;
      return done;
    },
  };
}

/** Actions that change nothing a treatment reads: proposing and revising (a policy's posting is
 * its own `policies.applied` row), requesting reviewed actions and exports, deciding, policies,
 * templates and the automation switch, access, asking or withdrawing questions and disposing of
 * worklist items. Every other action may change the books; an answer changes what proposals
 * citing it read. */
const inert = new Set([
  'proposals.approve',
  'proposals.withdraw',
  'actions.approve',
  'actions.reject',
  'policies.create',
  'policies.revoke',
  'agents.issue',
  'agents.revoke',
  'company.invite',
  'company.acceptInvitation',
  'company.revoke',
  'questions.ask',
  'questions.withdraw',
  'work.dispose',
  'templates.revoke',
  'automation.pause',
  'automation.resume',
  'automation.criteria.record',
  'automation.demoted',
  'policies.swept',
]);
export const mayChangeBooks = (action: string) =>
  !inert.has(action) && !/\.(propose|revise|request)$/.test(action);

/**
 * Keeps `acc_proposal_checks` current. After an event that may change the books, the latest
 * version of every open proposal not yet checked since that event is re-evaluated, at most
 * `budget` per run. A re-evaluation that fails unexpectedly is cached as stale with its error,
 * so one broken proposal neither blocks the others nor shows as current.
 */
export function proposalStaleness(db: Database, proposals: Proposals, budget = 100): Projector {
  return {
    name: 'proposals.staleness',
    async project(companyId, events) {
      const changed = events.filter((event) => mayChangeBooks(event.operation)).at(-1);
      if (!changed) return true;
      const pending = await db.read((tx) =>
        proposals.unchecked(tx, companyId, changed.seq, budget + 1),
      );
      for (const proposalId of pending.slice(0, budget))
        try {
          await proposals.refreshCheck(companyId, proposalId);
        } catch (error) {
          const latest = await db.read((tx) => proposals.view(tx, companyId, proposalId));
          await db.write((tx) =>
            saveCheck(tx, companyId, {
              proposalId,
              version: latest.version,
              checkedSeq: changed.seq,
              stale: true,
              changed: [
                {
                  kind: 'error',
                  id: 'INTERNAL',
                  before: null,
                  after: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                },
              ],
            }),
          );
        }
      return pending.length <= budget;
    },
  };
}
