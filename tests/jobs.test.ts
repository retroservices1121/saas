/**
 * The background jobs, against the real database.
 *
 * These are the parts of the system nobody watches run. A reminder job that
 * sends four messages at once after a weekend outage, or a purge that ignores a
 * legal hold, fails silently and is discovered by someone else — so the
 * properties worth asserting are idempotency, the hold, and the escalation
 * boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdmin, destroyFirm, readRow, seedFirm, type FirmFixture } from './fixtures';
import { openAdminConnection, type AdminSql } from '../lib/jobs/context';
import { runReminders } from '../lib/jobs/reminders';
import { expireExports, purgeRecords, pruneSessions } from '../lib/jobs/retention';
import { createCompany } from '../lib/db/queries/firm';
import { inviteWorker } from '../lib/db/queries/subjects';
import { __setSmsProvider, type SmsMessage } from '../lib/services/messaging';
import { __setStorageProvider } from '../lib/services/storage';
import { evictDek } from '../lib/security/field-encryption';
import { resolveFirmScope } from '../lib/auth/scope';
import type { CompanySession, FirmSession } from '../lib/auth/session';

let firm: FirmFixture;
let firmSession: FirmSession;
let companySession: CompanySession;
let companyId: string;
let workerId: string;
let sql: AdminSql;

const sent: SmsMessage[] = [];
const objects = new Map<string, Buffer>();

/** Moves a row's creation date back, to stand in for the passage of time. */
async function ageWorker(id: string, days: number): Promise<void> {
  await sql`
    update workers set created_at = now() - (${days} || ' days')::interval where id = ${id}
  `;
}

beforeAll(async () => {
  __setSmsProvider({
    name: 'test',
    async send(message) {
      sent.push(message);
    },
  });
  __setStorageProvider({
    name: 'test',
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) throw new Error('missing');
      return found;
    },
    async delete(key) {
      objects.delete(key);
    },
  });

  sql = openAdminConnection();
  firm = await seedFirm();

  firmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
  };

  const created = await createCompany(firmSession, {
    legalName: 'Job Test Co',
    dbaName: null,
    ein: '12-3456789',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    contactEmail: 'office@jobtest.test',
    contactPhone: null,
    adminName: 'Admin',
    adminEmail: `jobs-admin-${Date.now()}@jobtest.test`,
  });
  companyId = created.companyId;
  firmSession = { ...firmSession, companyIds: await resolveFirmScope(firm.firmId, firm.firmAdminUserId) };

  companySession = {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: created.adminUserId,
    firmId: firm.firmId,
    companyId,
  };

  const invited = await inviteWorker(companySession, companyId, {
    displayName: 'Slow Responder',
    workerType: 'EMPLOYEE',
    phoneE164: '+15555550999',
    preferredLocale: 'es',
    jobTitle: null,
    startDate: null,
    payType: null,
    payFrequency: null,
    workState: null,
  });
  workerId = invited.subjectId;
});

afterAll(async () => {
  evictDek();
  __setSmsProvider(undefined);
  __setStorageProvider(undefined);
  if (firm) await destroyFirm(firm.firmId);
  await sql.end();
  await closeAdmin();
});

beforeEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('reminders', () => {
  it('sends nothing before the third day', async () => {
    await ageWorker(workerId, 2);
    await runReminders(sql);

    // Filtered to this test's own worker, like every assertion below it.
    // `runReminders` sweeps every company in the database — that is what a
    // nightly job does — so anything else outstanding on the instance lands in
    // `sent` too. An unfiltered assertion here passes on a clean database and
    // fails three days after somebody runs `pnpm db:seed`.
    expect(sent.filter((message) => message.to === '+15555550999')).toHaveLength(0);
  });

  it('sends one on day three, in the subject\'s own language', async () => {
    await ageWorker(workerId, 3);
    await runReminders(sql);

    const mine = sent.filter((message) => message.to === '+15555550999');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.locale).toBe('es');
    // Generic prompt only. SMS is not a secure channel (spec section 11).
    expect(mine[0]?.body).not.toMatch(/tax|bank|SSN|ITIN/i);
    expect(mine[0]?.body).toContain('Job Test Co');
  });

  it('is idempotent — running it again the same day sends nothing', async () => {
    await runReminders(sql);
    expect(sent.filter((message) => message.to === '+15555550999')).toHaveLength(0);
  });

  it('issues a fresh link rather than resending the old one', async () => {
    // The raw token was never stored, only its sha256 — which is the property
    // that makes a database dump useless — so a reminder cannot resend the
    // original link and issues a new one instead.
    const live = await readRow<{ n: string }>(
      'select count(*)::text as n from invites where subject_id = $1 and consumed_at is null',
      workerId,
    );
    expect(Number(live?.n)).toBe(1);

    const superseded = await readRow<{ n: string }>(
      'select count(*)::text as n from invites where subject_id = $1 and consumed_at is not null',
      workerId,
    );
    expect(Number(superseded?.n)).toBeGreaterThan(0);
  });

  it('catches up to the right count rather than sending a burst', async () => {
    // A job that was down for a week must not send day-3, day-7 and day-14 all
    // at once when it comes back.
    await ageWorker(workerId, 7);
    await runReminders(sql);
    expect(sent.filter((message) => message.to === '+15555550999')).toHaveLength(1);
  });

  it('escalates to NEEDS_ATTENTION after fourteen days, and stops texting', async () => {
    await ageWorker(workerId, 15);
    await runReminders(sql);

    const worker = await readRow<{ status: string }>(
      'select status from workers where id = $1',
      workerId,
    );
    expect(worker?.status).toBe('NEEDS_ATTENTION');
    expect(sent.filter((message) => message.to === '+15555550999')).toHaveLength(0);

    const audited = await readRow<{ n: string }>(
      `select count(*)::text as n from audit_log
        where target_id = $1 and action = 'REMINDER_SENT'
          and metadata->>'escalated' = 'true'`,
      workerId,
    );
    expect(Number(audited?.n)).toBe(1);
  });

  it('does not escalate the same worker twice', async () => {
    const result = await runReminders(sql);
    const escalations = await readRow<{ n: string }>(
      `select count(*)::text as n from audit_log
        where target_id = $1 and metadata->>'escalated' = 'true'`,
      workerId,
    );
    expect(Number(escalations?.n)).toBe(1);
    expect(result.acted).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('retention', () => {
  let recordId: string;

  beforeEach(async () => {
    // A superseded record, old enough to be eligible.
    await sql`delete from worker_records where worker_id = ${workerId}`;
    const rows = await sql<{ id: string }[]>`
      insert into worker_records (
        worker_id, company_id, version, is_current, superseded_at,
        legal_first_name, legal_last_name, date_of_birth,
        tin_type, tin_enc, tin_last4, routing_enc, routing_last4,
        account_enc, account_last4, submitted_via
      ) values (
        ${workerId}, ${companyId}, 1, false, now() - interval '5 years',
        'Old', 'Version', '1990-01-01',
        'SSN', '\\x0102'::bytea, '6789', '\\x0304'::bytea, '0021',
        '\\x0506'::bytea, '6789', 'WORKER_FORM'
      ) returning id
    `;
    recordId = rows[0]!.id;
    await sql`update workers set legal_hold = false where id = ${workerId}`;
  });

  it('purges a record superseded more than four years ago', async () => {
    const result = await purgeRecords(sql);
    expect(result.acted).toBeGreaterThan(0);

    const record = await readRow<{
      tin_enc: Buffer | null;
      tin_last4: string | null;
      account_enc: Buffer | null;
      legal_first_name: string;
    }>(
      'select tin_enc, tin_last4, account_enc, legal_first_name from worker_records where id = $1',
      recordId,
    );

    expect(record?.tin_enc).toBeNull();
    expect(record?.tin_last4).toBeNull();
    expect(record?.account_enc).toBeNull();
    // The skeleton stays, because the audit log points at this row.
    expect(record?.legal_first_name).toBe('Old');

    const purged = await readRow<{ n: string }>(
      `select count(*)::text as n from audit_log
        where target_id = $1 and action = 'RECORD_PURGED'`,
      recordId,
    );
    expect(Number(purged?.n)).toBe(1);
  });

  it('a legal hold blocks the purge', async () => {
    await sql`update workers set legal_hold = true where id = ${workerId}`;
    await purgeRecords(sql);

    const record = await readRow<{ tin_enc: Buffer | null }>(
      'select tin_enc from worker_records where id = $1',
      recordId,
    );
    expect(record?.tin_enc).not.toBeNull();
  });

  it('leaves a current record alone however old the worker is', async () => {
    await sql`
      update worker_records set is_current = true, superseded_at = null where id = ${recordId}
    `;
    await purgeRecords(sql);

    const record = await readRow<{ tin_enc: Buffer | null }>(
      'select tin_enc from worker_records where id = $1',
      recordId,
    );
    // Still being paid, still needed.
    expect(record?.tin_enc).not.toBeNull();
  });

  it('a dry run changes nothing', async () => {
    const result = await purgeRecords(sql, { dryRun: true });
    expect(result.acted).toBe(0);

    const record = await readRow<{ tin_enc: Buffer | null }>(
      'select tin_enc from worker_records where id = $1',
      recordId,
    );
    expect(record?.tin_enc).not.toBeNull();
  });
});

describe('export expiry', () => {
  it('hard-deletes the artifact and the object after 24 hours', async () => {
    objects.set('demo/export.zip', Buffer.from('archive'));

    const rows = await sql<{ id: string }[]>`
      insert into exports (firm_id, requested_by, reason, include_sensitive, s3_key, expires_at)
      values (${firm.firmId}, ${firm.firmAdminUserId}, 'a reason long enough', true,
              'demo/export.zip', now() - interval '1 hour')
      returning id
    `;
    const exportId = rows[0]!.id;

    const result = await expireExports(sql);
    expect(result.acted).toBeGreaterThan(0);

    // The object is gone, and the key is cleared so nothing points at it.
    expect(objects.has('demo/export.zip')).toBe(false);

    const row = await readRow<{ deleted_at: Date | null; s3_key: string | null }>(
      'select deleted_at, s3_key from exports where id = $1',
      exportId,
    );
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.s3_key).toBeNull();
  });

  it('leaves an export that has not expired', async () => {
    objects.set('demo/fresh.zip', Buffer.from('archive'));
    await sql`
      insert into exports (firm_id, requested_by, reason, include_sensitive, s3_key, expires_at)
      values (${firm.firmId}, ${firm.firmAdminUserId}, 'still within its window', false,
              'demo/fresh.zip', now() + interval '12 hours')
    `;

    await expireExports(sql);
    expect(objects.has('demo/fresh.zip')).toBe(true);
  });
});

describe('session pruning', () => {
  it('removes sessions long past their ceiling and leaves recent ones', async () => {
    await sql`
      insert into staff_sessions (user_id, token_hash, expires_at, absolute_expires_at)
      values
        (${firm.firmAdminUserId}, ${'old-' + Date.now()},
         now() - interval '200 days', now() - interval '200 days'),
        (${firm.firmAdminUserId}, ${'new-' + Date.now()},
         now() + interval '1 hour', now() + interval '1 hour')
    `;

    const result = await pruneSessions(sql, { olderThanDays: 90 });
    expect(result.acted).toBeGreaterThan(0);

    const remaining = await readRow<{ n: string }>(
      `select count(*)::text as n from staff_sessions
        where user_id = $1 and absolute_expires_at > now()`,
      firm.firmAdminUserId,
    );
    expect(Number(remaining?.n)).toBeGreaterThan(0);
  });
});
