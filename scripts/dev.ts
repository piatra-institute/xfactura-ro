const children = [
  ['bun', '--watch', 'packages/xfactura-api/source/index.ts'],
  ['bun', '--watch', 'packages/xfactura-api/source/engine/worker.ts'],
  ['bun', 'run', '--cwd', 'packages/xfactura-web', 'dev'],
].map((command, index) =>
  Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: index === 2 ? { ...process.env, PORT: process.env.WEB_PORT ?? '3000' } : process.env,
  }),
);

// Ctrl+C reaches every process of the terminal's group. A child still running after the grace
// period (an open keep-alive socket, or `bun --watch` waiting for changes after its script ended)
// is killed, so the terminal always gets its prompt back.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(0);
  }, 3000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(children.map((child) => child.exited));
stop();
await Promise.all(children.map((child) => child.exited));
process.exit(0);
