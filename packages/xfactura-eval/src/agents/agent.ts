import type { World } from '../world/schema';
import type { Session } from './session';

/**
 * - `step`: files arrive one at a time; after each, the gold decisions are posted, so one error
 *   does not carry into the next file;
 * - `free`: every file is there at the start; the agent's own proposals are approved and posted,
 *   and the books it ends with are compared with the gold books.
 */
export type Mode = 'step' | 'free';

/** One call of the agent: it works until it has nothing left it can do, then returns. */
export type Turn = {
  mode: Mode;
  round: number;
  /** A new conversation: the first round of a run or, in step mode, of a file. */
  fresh: boolean;
  /** What the harness tells the agent, in English. */
  message: string;
};

export type Outcome = { status: 'done'; note?: string } | { status: 'skipped'; reason: string };

export interface Agent {
  run(session: Session, turn: Turn): Promise<Outcome>;
  /** After a run that was not skipped. */
  finish?(): Promise<void>;
}

/** Makes an agent for one run, or says why it cannot run (never a pass). */
export interface AgentFactory {
  readonly name: string;
  prepare(world: World, mode: Mode): Promise<{ agent: Agent } | { skipped: string }>;
}
