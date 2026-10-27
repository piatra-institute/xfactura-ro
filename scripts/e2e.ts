// All local requests share an IP. Give each viewport its own isolated server run
// rather than weakening the application's login rate limit for a growing suite.
const args = process.argv.slice(2);
const selectedProject = args.some((arg) => arg === '--project' || arg.startsWith('--project='));
const runs = selectedProject
  ? [args]
  : ['desktop', 'mobile'].map((project) => [
      ...args,
      `--project=${project}`,
      `--output=test-results/${project}`,
    ]);

for (const run of runs) {
  const child = Bun.spawn(['bun', 'x', 'playwright', 'test', ...run], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const code = await child.exited;
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
export {};
