import { createServer } from 'node:net';
import { e2ePorts } from '../playwright.config';

async function isPortFree(port: number): Promise<boolean> {
  // Check wildcard and loopback addresses because macOS lets a specific-IP bind
  // succeed even when another process holds the wildcard port, and vice versa.
  for (const host of [undefined, '0.0.0.0', '127.0.0.1', '::1']) {
    const free = await new Promise<boolean>((resolve, reject) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
        else if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') resolve(true);
        else reject(error);
      });
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

const checks = [
  { port: e2ePorts.web, env: 'XFACTURA_E2E_WEB_PORT', role: 'web' },
  { port: e2ePorts.api, env: 'XFACTURA_E2E_API_PORT', role: 'API' },
];
const busy: typeof checks = [];
for (const check of checks) {
  if (!(await isPortFree(check.port))) busy.push(check);
}
if (busy.length > 0) {
  for (const { port, env, role } of busy) {
    console.error(
      `E2E ${role} port ${port} is already in use. Free port ${port} or set ${env} to a free port.`,
    );
  }
  process.exit(1);
}

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
