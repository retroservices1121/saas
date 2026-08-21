/**
 * Background jobs run as the table owner, on purpose.
 *
 * Every other path in this system goes through `withScope` and a reduced
 * Postgres role. These do not, and the reason is the retention job: purging a
 * superseded record means UPDATE on `worker_records`, and that privilege is
 * revoked from every application role — including app_firm, including app_user
 * — precisely so the table is append-only. Granting a job role UPDATE on it to
 * make the purge possible would give away the property the purge exists to
 * bound.
 *
 * So purging is an owner-level operation, run out of band, from a connection
 * the web process does not hold. `ADMIN_DATABASE_URL` is not in the runtime
 * environment of the app; it is used by migrations and by these jobs.
 *
 * What that costs, and what is done about it:
 *
 *   RLS does not apply. Every query here therefore names its own predicates in
 *   full, and there is no "and it would be filtered anyway" reasoning available.
 *
 *   The audit trail is the only record. Each job writes rows attributed to a
 *   `SYSTEM` actor, so a purge or a reminder is as visible afterwards as a
 *   human action.
 *
 * `.eslintrc.json` exempts this directory from the import ban, which makes the
 * exception visible in the config rather than buried in a file.
 */
// eslint-disable-next-line no-restricted-imports
import postgres from 'postgres';

export type AdminSql = ReturnType<typeof postgres>;

/** The actor recorded for anything a job does. */
export const SYSTEM_ACTOR = 'SYSTEM';

export function openAdminConnection(): AdminSql {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error(
      'ADMIN_DATABASE_URL is not set. Background jobs run as the table owner — see ' +
        'the note at the top of lib/jobs/context.ts for why.',
    );
  }
  return postgres(url, { max: 2, onnotice: () => {} });
}

export interface JobResult {
  name: string;
  examined: number;
  acted: number;
  /** Human-readable lines for the operator running the job. */
  notes: string[];
}

/** Writes an audit row attributed to the system actor. */
export async function auditSystem(
  sql: AdminSql,
  event: {
    firmId?: string | null;
    companyId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    reason?: string | null;
    /**
     * JSON-serializable only. Cast to `never` at the call below because
     * postgres.js types `sql.json` against a recursive JSONValue that a plain
     * `Record<string, unknown>` cannot be proven to satisfy — the values here
     * are literals written a few lines away in each caller.
     */
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await sql`
    insert into audit_log (firm_id, company_id, actor_user_id, actor_role, action,
                           target_type, target_id, reason, metadata)
    values (
      ${event.firmId ?? null}, ${event.companyId ?? null}, null, ${SYSTEM_ACTOR},
      ${event.action}::audit_action, ${event.targetType ?? null}, ${event.targetId ?? null},
      ${event.reason ?? null},
      -- sql.json(), not JSON.stringify(). postgres.js serializes a JS value
      -- for a jsonb parameter itself, so handing it a pre-stringified one
      -- produced a jsonb *string* rather than an object. The column type was
      -- still jsonb and the insert still succeeded, so the only symptom was
      -- that every metadata lookup on a job-written row returned null.
      ${event.metadata ? sql.json(event.metadata as never) : null}
    )
  `;
}

/**
 * A cluster-wide lock, so two schedulers cannot run the same job at once.
 *
 * Railway skips a cron execution while the previous one is still Active, which
 * covers the ordinary case. It does not cover an operator running
 * `pnpm jobs nightly` by hand while the scheduled run is in flight, or a second
 * environment pointed at the same database, or a migration from Railway cron to
 * something else that overlaps during the switch.
 *
 * Two concurrent reminder runs are the case that bites: both read
 * `reminders_sent = 0` for the same worker before either writes, and the worker
 * gets two text messages. The jobs are individually idempotent; they are not
 * idempotent against themselves running twice at the same instant.
 *
 * `pg_try_advisory_lock` returns immediately rather than queueing, which is
 * what a scheduled job wants: skip this run and take the next one, rather than
 * pile up behind a stuck predecessor.
 *
 * The lock lives on the session and is released when the connection closes, so
 * a crashed job does not leave it held.
 */
/**
 * An arbitrary constant. Advisory lock keys share one namespace across the
 * whole database, so this is written down rather than derived from a string
 * hash — a collision with something else that takes advisory locks would be
 * invisible until two unrelated things quietly blocked each other.
 */
const JOB_LOCK_KEY = 8_154_209_311;

export async function withJobLock<T>(
  sql: AdminSql,
  fn: () => Promise<T>,
): Promise<T | 'skipped'> {
  const [row] = await sql<{ locked: boolean }[]>`
    select pg_try_advisory_lock(${JOB_LOCK_KEY}) as locked
  `;

  if (!row?.locked) return 'skipped';

  try {
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock(${JOB_LOCK_KEY})`;
  }
}
