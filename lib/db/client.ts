/**
 * THE ONLY PLACE A DATABASE CONNECTION IS OPENED.
 *
 * Nothing outside lib/db/scoped.ts may import this file. That is enforced by
 * the `no-restricted-imports` rule in .eslintrc.json, which makes a bypass a
 * build failure rather than a code-review miss (spec section 5, layer 2).
 *
 * The client returned here is UNSCOPED. It has no RLS session variables set and
 * runs as the login role. Using it directly reads across every tenant.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. It must point at the unprivileged app_user role, not at the table owner.',
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

/**
 * Next dev-mode hot reload re-evaluates modules and would otherwise leak a
 * connection pool per reload until the database refuses new connections.
 */
const client =
  globalThis.__pgClient ??
  postgres(connectionString, {
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idle_timeout: 30,
    connect_timeout: 15,
    // Ciphertext columns must come back as binary, never as a hex string that
    // could end up in a log line or a JSON response.
    transform: undefined,
    onnotice: () => {},
    // A prepared-statement cache keyed per connection is fine, but the
    // transaction-scoped SET LOCAL ROLE below means plans must not be shared
    // across roles. Disable prepared statements to keep that guarantee simple.
    prepare: false,
  });

if (process.env.NODE_ENV !== 'production') globalThis.__pgClient = client;

export const rawDb = drizzle(client, { schema, logger: false });
export const sqlClient = client;
export { schema };
