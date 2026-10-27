import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './source/accounting/schema.ts',
  out: './source/accounting/migrations',
});
