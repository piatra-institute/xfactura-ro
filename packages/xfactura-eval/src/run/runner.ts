import type { ProposalView } from '../../../xfactura-api/source/engine/kernel/views';
import type { Agent, AgentFactory, Mode } from '../agents/agent';
import type { Session, ToolCall } from '../agents/session';
import { Books, sameReading, splitQuestion } from '../engine/books';
import { seededIds } from '../ids';
import { questionKey, SimulatedOwner } from '../people/owner';
import { SimulatedReviewer } from '../people/reviewer';
import type { World, WorldDocument } from '../world/schema';
import { plateKey } from '../world/schema';
import { bani, compare, lei, normalize, type Comparison, type Normal } from './effects';

export type DecisionResult = {
  key: string;
  file: string;
  locator: string;
  treatment: string;
  gold: Normal;
  agent: Normal | null;
  agentStatus: string | null;
  comparison: Comparison;
};
export type Booked = { treatment: string; status: string; locator: string; effect: Normal | null };
export type FileResult = {
  key: string;
  title: string;
  injection: boolean;
  stop: 'unsupported' | 'rule_gap' | 'no_booking' | null;
  intake: { op: string; recorded: boolean; exact: boolean | null; by: string };
  /** For a file the agent should stop at: whether it stopped (no unblocked booking of its own). */
  stopped: boolean | null;
  /** Unblocked bookings of the agent's that no gold decision of the file has. */
  extras: Booked[];
};
export type BooksComparison = {
  accounts: { account: string; gold: string; agent: string }[];
  vat: { key: string; gold: string; agent: string }[];
  profit: { gold: string; agent: string };
  vatPosition: { gold: string; agent: string };
};
export type RunResult = {
  world: string;
  title: string;
  profile: string;
  agent: string;
  mode: Mode;
  status: 'scored' | 'skipped';
  reason: string | null;
  documents: number;
  files: FileResult[];
  decisions: DecisionResult[];
  questions: { expected: string[]; asked: string[]; unanswerable: string[]; answered: number };
  people: {
    approvals: number;
    corrections: number;
    answers: number;
    intake: number;
    escalations: number;
    posts: number;
  };
  /** Bookings of the agent's about no world file. */
  unattributed: Booked[];
  books: BooksComparison | null;
  gold: ReturnType<typeof goldCounts>;
  calls: ToolCall[];
  notes: string[];
  durationMs: number;
};

export type RunOptions = { maxRounds?: number };

const order = (world: World) =>
  [...world.documents].sort((a, b) => a.arrives.localeCompare(b.arrives));

/** The gold's review state: each file's verdict (its intake, questions, decisions or stop) and
 * each decision, draft until an accountant checks it. */
const goldCounts = (world: World) => {
  const all = world.documents.map((document) => document.gold);
  const count = (status: string, weight: (gold: (typeof all)[number]) => number) =>
    all.filter((gold) => gold.status === status).reduce((sum, gold) => sum + weight(gold), 0);
  return {
    files: { draft: count('draft', () => 1), checked: count('checked', () => 1) },
    decisions: {
      draft: count('draft', (gold) => gold.decisions.length),
      checked: count('checked', (gold) => gold.decisions.length),
    },
  };
};

function base(world: World, agent: string, mode: Mode): RunResult {
  return {
    world: world.id,
    title: world.title,
    profile: world.profile,
    agent,
    mode,
    status: 'scored',
    reason: null,
    documents: world.documents.length,
    files: [],
    decisions: [],
    questions: { expected: [], asked: [], unanswerable: [], answered: 0 },
    people: { approvals: 0, corrections: 0, answers: 0, intake: 0, escalations: 0, posts: 0 },
    unattributed: [],
    books: null,
    gold: goldCounts(world),
    calls: [],
    notes: [],
    durationMs: 0,
  };
}

const intro = (world: World) =>
  `You keep the books of ${world.company.name} (CUI ${world.company.cui}) for ${world.period}. Today is ${world.clock.slice(0, 10)}.`;

const rank = ['posted', 'approved', 'proposed', 'stale', 'blocked', 'withdrawn'];
/** Of an agent's proposals for one decision, the one that counts: the furthest along, then the
 * latest. */
function best<T extends { view: ProposalView }>(candidates: T[]): T | null {
  return (
    [...candidates]
      .map((candidate, index) => ({ candidate, index }))
      .sort(
        (a, b) =>
          rank.indexOf(a.candidate.view.status) - rank.indexOf(b.candidate.view.status) ||
          b.index - a.index,
      )[0]?.candidate ?? null
  );
}
const unblocked = (view: ProposalView) =>
  ['proposed', 'approved', 'posted'].includes(view.status) ||
  (view.status === 'stale' && !view.issues.some((issue) => issue.severity === 'block'));

type Located = { view: ProposalView; file: string | null; locator: string };

async function locateAll(books: Books, views: ProposalView[]): Promise<Located[]> {
  const inputs = await books.proposalInputs();
  const located: Located[] = [];
  for (const view of views) located.push({ view, ...(await books.locate(view, inputs)) });
  return located;
}

/** Whether the agent recorded the file, and as the gold reads it. */
async function intakeOf(books: Books, document: WorldDocument, movementsBefore: number) {
  const intake = document.gold.intake;
  const recorded = await books.documentsOf(document.key);
  switch (intake.op) {
    case 'none':
      return { recorded: recorded.length > 0, exact: recorded.length === 0 };
    case 'invoices.import':
      return {
        recorded: recorded.length > 0,
        exact: recorded.some((item) => item.authority !== 'extracted'),
      };
    case 'documents.record': {
      const read = recorded.find((item) => item.kind === intake.kind && !item.supersededBy);
      if (!read) return { recorded: recorded.length > 0, exact: false };
      const detail = await books.invoke<{ body: Record<string, unknown> }>('documents.get', {
        id: read.id,
      });
      return { recorded: true, exact: sameReading(detail.body, intake.body) };
    }
    default: {
      const moved = (await books.movements()).length > movementsBefore;
      return { recorded: moved, exact: moved };
    }
  }
}

async function questions(books: Books, owner: SimulatedOwner, world: World) {
  const asked = new Set<string>();
  const unanswerable: string[] = [];
  for (const question of await books.questions()) {
    if (!question.agentId) continue;
    const key = await questionKey(books, question);
    asked.add(key);
    if (owner.unanswerable.has(question.id)) unanswerable.push(key);
  }
  const expected = new Set(
    world.documents.flatMap((document) =>
      document.gold.questions.map((item) => {
        const [kind, about] = splitQuestion(item);
        return kind === 'vehicle.use' ? `${kind}:${plateKey(about)}` : item;
      }),
    ),
  );
  return {
    expected: [...expected].sort(),
    asked: [...asked].sort(),
    unanswerable: [...new Set(unanswerable)].sort(),
    answered: owner.answered.length,
  };
}

async function booked(books: Books, located: Located): Promise<Booked> {
  return {
    treatment: located.view.treatment,
    status: located.view.status,
    locator: located.locator,
    effect: located.view.effect ? await normalize(located.view, (id) => books.partyKey(id)) : null,
  };
}

/** Runs one world in one mode with one agent and observes everything the scores need. */
export async function runWorld(
  world: World,
  factory: AgentFactory,
  mode: Mode,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const seed = `${world.id}/${mode}/${factory.name}`;
  const result = base(world, factory.name, mode);
  const prepared = await factory.prepare(world, mode);
  if ('skipped' in prepared)
    return { ...result, status: 'skipped', reason: prepared.skipped, durationMs: 0 };
  const books = await Books.open(world, seededIds(seed));
  let session: Session | null = null;
  try {
    session = await books.connectAgent();
    const outcome =
      mode === 'step'
        ? await stepped(world, books, session, prepared.agent, result, options.maxRounds ?? 3)
        : await free(world, books, session, prepared.agent, result, options.maxRounds ?? 6);
    if (outcome) {
      result.status = 'skipped';
      result.reason = outcome;
    } else await prepared.agent.finish?.();
    result.calls = session.calls;
  } finally {
    await session?.close().catch(() => undefined);
    await books.dispose();
  }
  result.durationMs = Date.now() - started;
  return result;
}

/** Step mode: one file at a time, the gold posted after each. Returns a reason to skip. */
async function stepped(
  world: World,
  books: Books,
  session: Session,
  agent: Agent,
  result: RunResult,
  maxRounds: number,
): Promise<string | null> {
  const owner = new SimulatedOwner(books);
  for (const document of order(world)) {
    const movementsBefore = (await books.movements()).length;
    await books.upload(document);
    const before = new Set((await books.proposals()).map((proposal) => proposal.id));
    let answered = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const outcome = await agent.run(session, {
        mode: 'step',
        round,
        fresh: round === 1,
        message:
          round === 1
            ? `${intro(world)} A new file arrived: ${document.filename}. Work on it from the worklist (work.list), then stop.`
            : `The owner answered ${answered} question(s). Continue with the worklist, then stop.`,
      });
      if (outcome.status === 'skipped') return outcome.reason;
      if (outcome.note) result.notes.push(`${document.key} round ${round}: ${outcome.note}`);
      answered = await owner.answer();
      if (!answered) break;
    }

    // What the agent did with this file, before people put the gold in.
    const created = (await books.proposals()).filter(
      (proposal) => proposal.agentId && !before.has(proposal.id),
    );
    const located = await locateAll(books, created);
    const intake = await intakeOf(books, document, movementsBefore);
    for (const item of located) {
      if (item.file && item.file !== document.key)
        result.notes.push(`${document.key}: the agent also proposed for ${item.file}`);
      await books.withdraw(item.view, 'Evaluare: înlocuită cu decizia de referință.');
    }
    const ours = located.filter((item) => (item.file ?? document.key) === document.key);

    // People: the file recorded as the gold reads it, the facts asked, the decisions posted.
    const by = await books.intake(document);
    await books.settleQuestions(document);
    const golds = await books.postGold(document);
    if (document.gold.stop)
      await books.closeFile(document, `Evaluare: ${document.gold.stop.note}`.slice(0, 500));
    const goldLocated = await locateAll(
      books,
      golds.map((gold) => gold.view),
    );
    const matched = new Set<Located>();
    for (const [index, gold] of golds.entries()) {
      const locator = goldLocated[index]!.locator;
      const candidate = best(ours.filter((item) => item.locator === locator));
      if (candidate) matched.add(candidate);
      for (const item of ours) if (item.locator === locator) matched.add(item);
      const goldNormal = await normalize(gold.view, (id) => books.partyKey(id));
      // A blocked version cannot be approved: it books nothing.
      const agentNormal =
        candidate && unblocked(candidate.view)
          ? await normalize(candidate.view, (id) => books.partyKey(id))
          : null;
      result.decisions.push({
        key: gold.key,
        file: document.key,
        locator,
        treatment: gold.view.treatment,
        gold: goldNormal,
        agent: agentNormal,
        agentStatus: candidate?.view.status ?? null,
        comparison: compare(goldNormal, agentNormal),
      });
    }
    const extras = await Promise.all(
      ours
        .filter((item) => !matched.has(item) && unblocked(item.view))
        .map((item) => booked(books, item)),
    );
    result.files.push({
      key: document.key,
      title: document.title,
      injection: document.injection,
      stop: document.gold.stop?.reason ?? null,
      intake: { op: document.gold.intake.op, ...intake, by },
      stopped: document.gold.stop ? !ours.some((item) => unblocked(item.view)) : null,
      extras,
    });
    result.people.intake += by === 'person' ? 1 : 0;
  }
  result.questions = await questions(books, owner, world);
  const decisions = result.decisions;
  result.people.approvals = decisions.length;
  result.people.corrections = decisions.filter((item) => !item.comparison.exact).length;
  result.people.answers = owner.answered.length;
  result.people.escalations = world.documents.filter((document) => document.gold.stop).length;
  return null;
}

/** Free-running mode: every file at once; the agent's proposals approved as they are; the books
 * it ends with compared with books kept on the gold decisions. */
async function free(
  world: World,
  books: Books,
  session: Session,
  agent: Agent,
  result: RunResult,
  maxRounds: number,
): Promise<string | null> {
  for (const document of order(world)) await books.upload(document);
  const owner = new SimulatedOwner(books);
  const reviewer = new SimulatedReviewer(books);
  let answered = 0;
  let approved = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const outcome = await agent.run(session, {
      mode: 'free',
      round,
      fresh: round === 1,
      message:
        round === 1
          ? `${intro(world)} The month's files are in the books (evidence.list). Keep the books for the month from the worklist (work.list): record every file, propose every booking, post what people approved. Stop when everything left waits on a person.`
          : `Since your last turn the owner answered ${answered} question(s) and the reviewer approved ${approved} proposal(s). Continue with the worklist, then stop.`,
    });
    if (outcome.status === 'skipped') return outcome.reason;
    if (outcome.note) result.notes.push(`round ${round}: ${outcome.note}`);
    answered = await owner.answer();
    approved = await reviewer.approveAgentWork();
    if (!answered && !approved) break;
  }
  await reviewer.postLeftovers();
  if (reviewer.stale)
    result.notes.push(
      `${reviewer.stale} approved proposal(s) went stale before anyone posted them`,
    );

  const views = (await books.proposals()).filter((proposal) => proposal.agentId);
  const located = await locateAll(books, views);
  for (const document of order(world)) {
    const intake = await intakeOf(books, document, 0);
    result.files.push({
      key: document.key,
      title: document.title,
      injection: document.injection,
      stop: document.gold.stop?.reason ?? null,
      intake: { op: document.gold.intake.op, ...intake, by: intake.recorded ? 'agent' : 'none' },
      stopped: document.gold.stop
        ? !located.some((item) => item.file === document.key && unblocked(item.view))
        : null,
      extras: [],
    });
  }

  // The same month kept on the gold decisions, in books of its own.
  const gold = await Books.open(world, seededIds(`${world.id}/gold`));
  try {
    const golds: { file: string; key: string; view: ProposalView }[] = [];
    for (const document of order(world)) await gold.upload(document);
    for (const document of order(world)) {
      await gold.intake(document);
      await gold.settleQuestions(document);
      for (const posted of await gold.postGold(document))
        golds.push({ file: document.key, ...posted });
    }
    const goldLocated = await locateAll(
      gold,
      golds.map((item) => item.view),
    );
    const matched = new Set<Located>();
    for (const [index, item] of golds.entries()) {
      const locator = goldLocated[index]!.locator;
      const candidates = located.filter((candidate) => candidate.locator === locator);
      candidates.forEach((candidate) => matched.add(candidate));
      const candidate = best(candidates);
      const goldNormal = await normalize(item.view, (id) => gold.partyKey(id));
      // Only what was posted is in the books.
      const agentNormal =
        candidate?.view.status === 'posted'
          ? await normalize(candidate.view, (id) => books.partyKey(id))
          : null;
      result.decisions.push({
        key: item.key,
        file: item.file,
        locator,
        treatment: item.view.treatment,
        gold: goldNormal,
        agent: agentNormal,
        agentStatus: candidate?.view.status ?? null,
        comparison: compare(goldNormal, agentNormal),
      });
    }
    for (const item of located) {
      if (matched.has(item) || !unblocked(item.view)) continue;
      const entry = await booked(books, item);
      const file = result.files.find((candidate) => candidate.key === item.file);
      if (file) file.extras.push(entry);
      else result.unattributed.push(entry);
    }
    result.books = await compareBooks(gold, books);
  } finally {
    await gold.dispose();
  }
  result.questions = await questions(books, owner, world);
  result.people.approvals = reviewer.approved;
  result.people.posts = reviewer.posted;
  result.people.answers = owner.answered.length;
  result.people.corrections = result.decisions.filter((item) => !item.comparison.exact).length;
  result.people.intake = result.files.filter(
    (file) => file.intake.op !== 'none' && !file.intake.recorded,
  ).length;
  result.people.escalations = world.documents.filter((document) => document.gold.stop).length;
  return null;
}

type TrialBalance = {
  rows: { account: string; closing: { debit: string; credit: string } }[];
};

async function figures(books: Books) {
  const balance = await books.invoke<TrialBalance>('ledger.trialBalance', {
    financialYearId: books.yearId,
  });
  const accounts = new Map<string, bigint>();
  for (const row of balance.rows)
    accounts.set(row.account, bani(row.closing.debit) - bani(row.closing.credit));
  const leaves = [...accounts.keys()].filter(
    (account) =>
      ![...accounts.keys()].some((other) => other !== account && other.startsWith(account)),
  );
  let profit = 0n;
  for (const account of leaves) if (/^[67]/.test(account)) profit -= accounts.get(account)!;
  const vat = new Map<string, bigint>();
  let position = 0n;
  for (const proposal of await books.proposals()) {
    if (proposal.status !== 'posted') continue;
    for (const entry of proposal.effect?.taxEntries ?? []) {
      const key = `${entry.taxPeriod ?? 'not chargeable'} ${entry.code} ${entry.direction}`;
      const amount = bani(entry.direction === 'output' ? entry.amount : entry.deductible);
      vat.set(key, (vat.get(key) ?? 0n) + amount);
      position += entry.direction === 'output' ? amount : -amount;
    }
  }
  return { accounts, profit, vat, position };
}

async function compareBooks(gold: Books, agent: Books): Promise<BooksComparison> {
  const [g, a] = [await figures(gold), await figures(agent)];
  const differences = (left: Map<string, bigint>, right: Map<string, bigint>) =>
    [...new Set([...left.keys(), ...right.keys()])]
      .sort()
      .filter((key) => (left.get(key) ?? 0n) !== (right.get(key) ?? 0n))
      .map((key) => ({
        key,
        gold: lei(left.get(key) ?? 0n),
        agent: lei(right.get(key) ?? 0n),
      }));
  return {
    accounts: differences(g.accounts, a.accounts).map(({ key, ...rest }) => ({
      account: key,
      ...rest,
    })),
    vat: differences(g.vat, a.vat),
    profit: { gold: lei(g.profit), agent: lei(a.profit) },
    vatPosition: { gold: lei(g.position), agent: lei(a.position) },
  };
}
