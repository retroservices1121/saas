import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Schema generation runs as the owning role, never as the runtime app_user.
 * The URL is optional so that `drizzle-kit generate` works offline, before a
 * database exists — only the commands that actually connect need it.
 */
const url = process.env.ADMIN_DATABASE_URL ?? '';

export default defineConfig({
  schema: './lib/db/schema/index.ts',
  out: './drizzle/generated',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
