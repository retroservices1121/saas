/**
 * Retention (spec section 13).
 *
 * Three jobs, with quite different rules:
 *
 *   purgeRecords     nulls the `_enc` and `_last4` columns on worker_records
 *                    and company_owners four years after supersession or
 *                    archival, keeping the row skeleton and the whole audit
 *                    trail, and logging RECORD_PURGED. `legal_hold` blocks it.
 *
 *   expireExports    hard-deletes export artifacts at 24 hours, regardless of
 *                    hold. An export is a copy, and section 13 is explicit that
 *                    the copy goes even when the original is frozen — a legal
 *                    hold is a reason to retain the record, not a reason to
 *                    leave a password-protected archive of tax IDs sitting in a
 *                    bucket.
 *
 *   destroyCompanyKey  the cryptographic shred: destroying the wrapped DEK
 *                    renders every sensitive field for a company undecryptable
 *                    in one operation.
 *
 * The skeleton is kept rather than the row deleted because the audit log points
 * at these ids. A deleted row turns "REVEAL_TIN on record X" into a dangling
 * reference, which is exactly the question an investigation would be asking.
 */
import { auditSystem, type AdminSql, type JobResult } from './context';
import { getStorage } from '../services/storage';

const DEFAULT_RETENTION_YEARS = 4;

interface PurgeCandidate {
  id: string;
  company_id: string;
  firm_id: string;
  worker_id: string | null;
}

/**
 * Worker records eligible for purge.
 *
 * A record becomes eligible four years after it stopped being current — either
 * because a correction superseded it, or because the worker was archived. A
 * current record for an active worker is never purged, however old: it is the
 * record of somebody still being paid.
 *
 * `legal_hold` is checked on the worker, not the record, because a hold is
 * placed on a person's file rather than on one version of it.
 */
async function findPurgeableRecords(
  sql: AdminSql,
  cutoff: Date,
): Promise<PurgeCandidate[]> {
  return sql<PurgeCandidate[]>`
    select r.id, r.company_id, c.firm_id, r.worker_id
      from worker_records r
      join workers w   on w.id = r.worker_id
      join companies c on c.id = r.company_id
     where w.legal_hold = false
       and r.purged_at is null
       and r.tin_enc is not null
       and (
         (r.superseded_at is not null and r.superseded_at < ${cutoff})
         or (w.archived_at is not null and w.archived_at < ${cutoff})
       )
     order by r.id
  `;
}

async function findPurgeableOwners(sql: AdminSql, cutoff: Date): Promise<PurgeCandidate[]> {
  return sql<PurgeCandidate[]>`
    select o.id, o.company_id, c.firm_id, null::uuid as worker_id
      from company_owners o
      join companies c on c.id = o.company_id
     where o.purged_at is null
       and o.tin_enc is not null
       and c.status = 'suspended'
       and o.updated_at < ${cutoff}
     order by o.id
  `;
}

export async function purgeRecords(
  sql: AdminSql,
  options: { now?: Date; retentionYears?: number; dryRun?: boolean } = {},
): Promise<JobResult> {
  const now = options.now ?? new Date();
  const years = options.retentionYears ?? DEFAULT_RETENTION_YEARS;
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);

  const [records, owners] = await Promise.all([
    findPurgeableRecords(sql, cutoff),
    findPurgeableOwners(sql, cutoff),
  ]);

  const result: JobResult = {
    name: 'purge',
    examined: records.length + owners.length,
    acted: 0,
    notes: [],
  };

  if (options.dryRun) {
    result.notes.push(
      `would purge ${records.length} worker records and ${owners.length} owner records ` +
        `superseded or archived before ${cutoff.toISOString().slice(0, 10)}`,
    );
    return result;
  }

  for (const record of records) {
    // UPDATE on worker_records is revoked from every application role, which is
    // what makes the table append-only. This runs as the owner — see the note
    // in lib/jobs/context.ts.
    await sql`
      update worker_records
         set tin_enc = null, tin_last4 = null,
             routing_enc = null, routing_last4 = null,
             account_enc = null, account_last4 = null,
             purged_at = ${now}
       where id = ${record.id}
    `;
    await auditSystem(sql, {
      firmId: record.firm_id,
      companyId: record.company_id,
      action: 'RECORD_PURGED',
      targetType: 'worker_records',
      targetId: record.id,
      reason: `Retention: ${years} years`,
      metadata: { workerId: record.worker_id },
    });
    result.acted++;
  }

  for (const owner of owners) {
    await sql`
      update company_owners
         set tin_enc = null, tin_last4 = null, purged_at = ${now}
       where id = ${owner.id}
    `;
    await auditSystem(sql, {
      firmId: owner.firm_id,
      companyId: owner.company_id,
      action: 'RECORD_PURGED',
      targetType: 'company_owners',
      targetId: owner.id,
      reason: `Retention: ${years} years`,
    });
    result.acted++;
  }

  if (result.acted > 0) {
    result.notes.push(`purged ${result.acted} records`);
  }
  return result;
}

/**
 * Export artifacts hard-delete at 24 hours, regardless of legal hold.
 *
 * The object is removed from storage first and the row is stamped afterwards.
 * If the process dies between the two, the next run finds the row again and
 * deletes an object that is already gone — which every storage backend treats
 * as success. The reverse order would leave the archive in the bucket with
 * nothing in the database pointing at it, which is the one outcome nobody would
 * ever notice.
 */
export async function expireExports(
  sql: AdminSql,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<JobResult> {
  const now = options.now ?? new Date();

  const expired = await sql<{ id: string; firm_id: string; s3_key: string | null }[]>`
    select id, firm_id, s3_key from exports
     where expires_at < ${now} and deleted_at is null
  `;

  const result: JobResult = {
    name: 'expire-exports',
    examined: expired.length,
    acted: 0,
    notes: [],
  };

  if (options.dryRun) {
    if (expired.length > 0) result.notes.push(`would delete ${expired.length} export artifacts`);
    return result;
  }

  for (const row of expired) {
    if (row.s3_key) {
      try {
        await getStorage().delete(row.s3_key);
      } catch (err) {
        // Logged and skipped rather than aborting the batch: one unreachable
        // object must not stop the other nine from being deleted.
        console.error(`[retention] could not delete ${row.s3_key}`, err);
        continue;
      }
    }
    await sql`update exports set deleted_at = ${now}, s3_key = null where id = ${row.id}`;
    await auditSystem(sql, {
      firmId: row.firm_id,
      action: 'RECORD_PURGED',
      targetType: 'exports',
      targetId: row.id,
      reason: 'Export artifacts hard-delete at 24 hours',
    });
    result.acted++;
  }

  return result;
}

/**
 * Cryptographic shred for a whole company (spec section 6, last line).
 *
 * Destroying the wrapped data key makes every sensitive field for that company
 * undecryptable in one operation, without having to find and overwrite each
 * ciphertext — including ciphertexts in backups taken before today, which is
 * the part overwriting cannot reach.
 *
 * Irreversible, and deliberately not wired to any UI.
 */
export async function destroyCompanyKey(
  sql: AdminSql,
  companyId: string,
  reason: string,
): Promise<JobResult> {
  if (reason.trim().length < 10) {
    throw new Error('Destroying a company data key requires a reason of at least ten characters.');
  }

  const rows = await sql<{ firm_id: string; dek_destroyed_at: Date | null }[]>`
    select firm_id, dek_destroyed_at from companies where id = ${companyId}
  `;
  const company = rows[0];
  if (!company) throw new Error(`No company ${companyId}.`);

  const result: JobResult = { name: 'destroy-key', examined: 1, acted: 0, notes: [] };

  if (company.dek_destroyed_at) {
    result.notes.push('The data key for this company was already destroyed.');
    return result;
  }

  await sql`
    update companies
       set dek_destroyed_at = now(), dek_ciphertext = '\\x'::bytea
     where id = ${companyId}
  `;

  await auditSystem(sql, {
    firmId: company.firm_id,
    companyId,
    action: 'RECORD_PURGED',
    targetType: 'companies',
    targetId: companyId,
    reason,
    metadata: { operation: 'dek_destroyed', irreversible: true },
  });

  result.acted = 1;
  result.notes.push(
    'The data key is destroyed. Every encrypted field for this company is now unrecoverable.',
  );
  return result;
}

/** Sweeps staff sessions long past their ceiling. */
export async function pruneSessions(
  sql: AdminSql,
  options: { olderThanDays?: number; now?: Date } = {},
): Promise<JobResult> {
  const days = options.olderThanDays ?? 90;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86400_000);

  const removed = await sql<{ id: string }[]>`
    delete from staff_sessions where absolute_expires_at < ${cutoff} returning id
  `;

  return {
    name: 'prune-sessions',
    examined: removed.length,
    acted: removed.length,
    notes: removed.length > 0 ? [`removed ${removed.length} expired sessions`] : [],
  };
}
