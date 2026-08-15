/**
 * Layer 2 of access enforcement (spec section 5).
 *
 * Every query in the application passes through this module. It opens a
 * transaction, drops into the least-privileged Postgres role for the session,
 * publishes the session's scope as transaction-local settings that the RLS
 * policies read, and hands back a bound builder.
 *
 * No route handler imports lib/db/client.ts. The ESLint rule makes that a build
 * error, not a convention.
 */
import { sql } from 'drizzle-orm';
// eslint-disable-next-line no-restricted-imports
import { rawDb, schema } from './client';
import {
  actorUserIdOf,
  dbRoleOf,
  firmIdOf,
  scopeOf,
  type DbRole,
  type Session,
} from '../auth/session';

export type ScopedDb = Parameters<Parameters<typeof rawDb.transaction>[0]>[0];

const ALLOWED_DB_ROLES: readonly DbRole[] = [
  'app_platform',
  'app_firm',
  'app_company',
  'app_subject',
  'app_auth',
];

/** Postgres error code for insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Thrown when a session touches a table or column its Postgres role has no
 * privilege on — a COMPANY_ADMIN reaching worker_records, for example. Callers
 * surface this as not-found. Leaking "forbidden" would confirm the row exists.
 */
export class ScopeViolationError extends Error {
  readonly table: string | undefined;
  constructor(message: string, table?: string) {
    super(message);
    this.name = 'ScopeViolationError';
    this.table = table;
  }
}

let bootChecked = false;

/**
 * Refuse to run as a role that bypasses RLS. A superuser or a BYPASSRLS role
 * silently disables layer 1 entirely, and every isolation test would still pass
 * for the wrong reason. Fail loudly at boot instead.
 */
async function assertRlsCapableRole(): Promise<void> {
  if (bootChecked) return;
  const rows = await rawDb.execute<{
    is_superuser: boolean;
    bypassrls: boolean;
    rolname: string;
  }>(sql`
    select rolname, rolsuper as is_superuser, rolbypassrls as bypassrls
    from pg_roles
    where rolname = current_user
  `);
  const row = rows[0];
  if (!row) throw new Error('Could not determine the current database role.');
  if (row.is_superuser || row.bypassrls) {
    throw new Error(
      `DATABASE_URL connects as "${row.rolname}", which bypasses Row Level Security. ` +
        'Point it at the app_user role created by `pnpm db:setup-roles`. ' +
        'Running the application as a superuser disables layer 1 of access enforcement.',
    );
  }
  bootChecked = true;
}

function assertKnownRole(role: DbRole): DbRole {
  // SET ROLE cannot be parameterized, so the value is interpolated. It comes
  // from a closed union derived from the session kind, never from input, and
  // this assertion keeps that true if the union ever grows.
  if (!ALLOWED_DB_ROLES.includes(role)) {
    throw new Error(`Refusing to SET ROLE to an unrecognized role: ${role}`);
  }
  return role;
}

/**
 * Run `fn` inside a transaction scoped to `session`.
 *
 * Settings published for the RLS policies (all transaction-local, so they
 * cannot leak onto the next borrower of a pooled connection):
 *   app.actor_role     the application role name
 *   app.actor_scope    comma-separated company ids this session may touch
 *   app.actor_user_id  staff user id, or empty for a subject session
 *   app.subject_id     worker/owner id for a subject session, else empty
 *   app.firm_id        owning firm, or empty
 */
export async function withScope<T>(
  session: Session,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  await assertRlsCapableRole();

  const dbRole = assertKnownRole(dbRoleOf(session));
  const scope = scopeOf(session);
  const subjectId = session.kind === 'subject' ? session.subjectId : '';

  try {
    return await rawDb.transaction(async (tx) => {
      // Order matters. Settings are written first, while still running as the
      // login role, because the reduced roles may not have privileges the
      // set_config path needs. SET LOCAL ROLE is applied last and is reverted
      // automatically at commit or rollback.
      await tx.execute(sql`
        select
          set_config('app.actor_role',    ${session.role},                 true),
          set_config('app.actor_scope',   ${scope.join(',')},              true),
          set_config('app.actor_user_id', ${actorUserIdOf(session) ?? ''}, true),
          set_config('app.subject_id',    ${subjectId},                    true),
          set_config('app.firm_id',       ${firmIdOf(session) ?? ''},      true)
      `);
      await tx.execute(sql.raw(`set local role ${dbRole}`));

      return await fn(tx);
    });
  } catch (err) {
    const pgErr = err as { code?: string; table_name?: string; message?: string };
    if (pgErr?.code === INSUFFICIENT_PRIVILEGE) {
      throw new ScopeViolationError(
        pgErr.message ?? 'Insufficient privilege for this session scope.',
        pgErr.table_name,
      );
    }
    throw err;
  }
}

/**
 * Same as withScope, but converts a privilege violation into `null` after
 * recording it. Use this at the read boundary of any handler that must answer
 * "not found" rather than "forbidden".
 *
 * The audit row is written on a fresh transaction: the original one is already
 * aborted by the time Postgres reports the error, so nothing can be inserted
 * on it.
 */
export async function withScopeOrNull<T>(
  session: Session,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T | null> {
  try {
    return await withScope(session, fn);
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      await recordSecurityViolation(session, err);
      return null;
    }
    throw err;
  }
}

/**
 * Writes a SECURITY_VIOLATION row. Required by spec section 5: a COMPANY_ADMIN
 * reaching forbidden data is a bug, and it must throw and log rather than
 * quietly return empty.
 *
 * Deliberately best-effort: if the audit insert itself fails we swallow it,
 * because throwing here would replace a useful "not found" with a 500 and hide
 * the original violation from the caller. The failure is still surfaced on the
 * server console, which the redaction filter has already scrubbed.
 */
export async function recordSecurityViolation(
  session: Session,
  err: ScopeViolationError,
): Promise<void> {
  const scope = scopeOf(session);
  try {
    await rawDb.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.actor_role',  ${session.role},    true),
          set_config('app.actor_scope', ${scope.join(',')}, true)
      `);
      await tx.execute(sql.raw(`set local role ${assertKnownRole(dbRoleOf(session))}`));
      await tx.insert(schema.auditLog).values({
        firmId: firmIdOf(session),
        companyId: scope[0] ?? null,
        actorUserId: actorUserIdOf(session),
        actorRole: session.role,
        action: 'SECURITY_VIOLATION',
        targetType: err.table ?? null,
        targetId: null,
        reason: null,
        ip: session.ip ?? null,
        userAgent: session.userAgent ?? null,
        metadata: {
          // The Postgres message names the table and role. It contains no row
          // data, so it is safe to retain, and it is what makes the row useful
          // during an investigation.
          pgMessage: err.message,
          sessionKind: session.kind,
        },
      });
    });
  } catch (auditErr) {
    console.error('[audit] failed to record SECURITY_VIOLATION', auditErr);
  }
}

/**
 * Why some inserts in this codebase are hand-written SQL.
 *
 * Drizzle builds an INSERT naming EVERY column of the table, passing `default`
 * for the ones the caller did not supply:
 *
 *   insert into company_owners ("id", "company_id", ..., "tin_enc", "tin_last4", ...)
 *   values ($1, $2, ..., default, default, ...)
 *
 * Postgres checks INSERT privilege on every column *mentioned*, and `default`
 * mentions it. So a role holding column-level INSERT on seven columns cannot
 * perform a Drizzle insert on a twenty-three-column table at all — it fails with
 * `permission denied for table`, which reads like a missing grant rather than
 * like the ORM naming columns nobody asked it to.
 *
 * That leaves two options. Widen the grants to every column, which would let a
 * company session write `tin_enc` on an owner row — precisely what
 * "el empleador no debe ver ni recolectar estos datos directamente" forbids;
 * collecting is named in that sentence alongside seeing. Or name the columns
 * explicitly. This helper is the second option.
 *
 * The column list here matches the GRANT in the migration exactly, which makes
 * the two readable against each other — arguably better documentation than a
 * values object that says nothing about what the role may write.
 */
export function insertColumns(
  table: string,
  values: Record<string, unknown>,
): ReturnType<typeof sql> {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error('Refusing to build an insert with no columns.');
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  for (const column of columns) {
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`Unsafe column name: ${column}`);
  }

  const columnList = sql.raw(columns.map((c) => `"${c}"`).join(', '));
  const placeholders = sql.join(
    // Drizzle's typed insert builder maps JS values onto column types; a raw
    // `sql` fragment does not, and postgres.js refuses to bind a Date. ISO 8601
    // with an explicit offset is unambiguous to `timestamptz` and to `date`.
    columns.map((c) => {
      const value = values[c];
      return sql`${value instanceof Date ? value.toISOString() : value}`;
    }),
    sql`, `,
  );

  return sql`insert into ${sql.raw(`"${table}"`)} (${columnList}) values (${placeholders})`;
}

export { schema };
