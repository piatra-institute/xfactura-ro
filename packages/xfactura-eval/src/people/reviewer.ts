import { CallError, type Books } from '../engine/books';

/**
 * The simulated reviewer of free-running mode: approves each version the agent proposes as it
 * stands, acknowledging its warnings, so that the books end up as the agent kept them. It never
 * approves a blocked or stale version (the engine would refuse it anyway). What the agent leaves
 * approved and unposted at the end, the reviewer posts.
 */
export class SimulatedReviewer {
  approved = 0;
  posted = 0;
  /** Approved versions the books moved past before anyone posted them. */
  stale = 0;

  constructor(private readonly books: Books) {}

  async approveAgentWork() {
    let count = 0;
    for (const proposal of await this.books.proposals()) {
      if (proposal.agentId === null || proposal.status !== 'proposed') continue;
      await this.books.approve(proposal);
      count += 1;
    }
    this.approved += count;
    await this.books.project();
    return count;
  }

  async postLeftovers() {
    for (const proposal of await this.books.proposals()) {
      if (proposal.agentId === null || proposal.status !== 'approved') continue;
      try {
        await this.books.post(proposal);
        this.posted += 1;
      } catch (error) {
        if (!(error instanceof CallError) || error.code !== 'STALE') throw error;
        this.stale += 1;
      }
      await this.books.project();
    }
  }
}
