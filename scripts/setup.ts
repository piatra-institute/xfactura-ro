import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

await mkdir('.accounting', { recursive: true, mode: 0o700 });
let existing = '';
try {
  existing = await readFile('.env', 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const defaults = {
  DATABASE_URL: 'file:.accounting/xfactura.db',
  ACCOUNTING_AUTH_SECRET: randomBytes(32).toString('hex'),
  ACCOUNTING_PUBLIC_URL: 'http://localhost:3000',
  ACCOUNTING_OBJECT_DIR: '.accounting/objects',
  PORT: '8089',
};
let configured = existing;
for (const [key, value] of Object.entries(defaults)) {
  const pattern = new RegExp(`^${key}=(.*)$`, 'm');
  const match = configured.match(pattern);
  if (!match) configured = `${configured.trimEnd()}\n${key}=${value}\n`;
  else if (
    /^(?:\s*|""|'')$/.test(match[1]) ||
    (key === 'ACCOUNTING_AUTH_SECRET' && match[1].startsWith('replace-with-'))
  )
    configured = configured.replace(pattern, `${key}=${value}`);
}
if (configured !== existing) await writeFile('.env', configured.trimStart(), { mode: 0o600 });
await chmod('.env', 0o600);
console.log('Local configuration ready. Existing values were retained.');
console.log('Next: bun run db:migrate, bun run account:create, then bun run dev.');
