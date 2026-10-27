const children = [
  ['bun', '--watch', 'packages/xfactura-api/source/index.ts'],
  ['bun', '--watch', 'packages/xfactura-api/source/accounting/worker.ts'],
  ['bun', 'run', '--cwd', 'packages/xfactura-web', 'dev'],
].map((command, index) =>
  Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: index === 2 ? { ...process.env, PORT: process.env.WEB_PORT ?? '3000' } : process.env,
  }),
);

const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await Promise.race(children.map((child) => child.exited));
} finally {
  stop();
}
