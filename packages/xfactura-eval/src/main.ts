import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentFactory, Mode } from './agents/agent';
import { llm, type LlmMode } from './agents/llm';
import { scripted } from './agents/scripted';
import { writeReport, type Report } from './run/report';
import { runWorld } from './run/runner';
import { score } from './run/score';
import { worlds } from './worlds';

const root = join(import.meta.dir, '..');

/**
 * `bun run eval`: every world in both modes with the scripted agent, and the LLM agent from its
 * recordings. Exits 1 when a run fails (a gold decision the engine refuses is a failure) or an
 * agent called outside its grant or tried to approve.
 */
export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string', multiple: true },
      world: { type: 'string', multiple: true },
      mode: { type: 'string', multiple: true },
      llm: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const env = process.env;
  const llmMode = (values.llm ?? env.EVAL_LLM ?? 'replay') as LlmMode;
  if (!['replay', 'record', 'off'].includes(llmMode)) throw new Error(`--llm ${llmMode}?`);
  const factories: AgentFactory[] = [
    scripted,
    llm({
      mode: llmMode,
      recordings: join(root, 'recordings'),
      key: env.EVAL_ANTHROPIC_API_KEY || undefined,
      baseUrl: env.EVAL_ANTHROPIC_BASE_URL || undefined,
      options: {
        model: env.EVAL_MODEL || 'claude-opus-5-5',
        effort: env.EVAL_EFFORT || 'high',
        maxTurns: Number(env.EVAL_MAX_TURNS || 40),
        maxResultCharacters: 40_000,
      },
    }),
  ].filter((factory) => !values.agent || values.agent.includes(factory.name));
  const chosen = worlds.filter((world) => !values.world || values.world.includes(world.id));
  const modes = (values.mode ?? ['step', 'free']) as Mode[];
  if (!factories.length || !chosen.length || !modes.length) {
    console.error('Nothing to run: check --agent, --world and --mode.');
    return 2;
  }

  const report: Report = { generatedAt: new Date().toISOString(), runs: [] };
  let failed = false;
  for (const factory of factories)
    for (const world of chosen)
      for (const mode of modes) {
        const label = `${world.id} · ${factory.name} · ${mode}`;
        try {
          const result = await runWorld(world, factory, mode);
          const scores = score(result);
          report.runs.push({ scores, result });
          console.log(
            scores.status === 'skipped'
              ? `${label}: skipped (${scores.reason})`
              : `${label}: exact ${scores.decisions.exact}/${scores.decisions.total}, questions ${scores.questions.matched}/${scores.questions.expected} expected (${scores.questions.asked} asked), stops ${scores.stops.stopped}/${scores.stops.total}, critical ${scores.critical.total}, touches/100 ${scores.touches.per100Documents}, outside grant ${scores.injection.outsideGrant}, approval attempts ${scores.injection.approvalAttempts}`,
          );
          if (scores.status === 'scored' && !scores.injection.passed) failed = true;
        } catch (error) {
          failed = true;
          console.error(`${label}: failed`, error);
        }
      }
  const written = writeReport(values.out ?? join(root, 'reports'), report);
  console.log(`Report: ${written.markdown} and ${written.json}`);
  return failed ? 1 : 0;
}
