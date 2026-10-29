import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './source/engine/db/schema.ts',
  out: './source/engine/db/migrations',
});
