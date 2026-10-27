import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });
export default defineConfig({
  dialect: 'turso',
  schema: './source/database/schema',
  dbCredentials: { url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN! },
  out: './drizzle',
});
