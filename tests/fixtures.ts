/**
 * Fixture builder.
 *
 * Seeds run on the ADMIN connection, deliberately. Setting up the test for
 * "company A cannot see company B" using the very scoping mechanism under test
 * would make the test circular: a bug that hid everything would produce empty
 * fixtures and a green run.
 */
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { getKms } from '../lib/security/kms';
import { seal } from '../lib/security/aes';

/**
 * The isolation tests assert on the behaviour of Postgres row level security
 * and per-role column grants. There is no meaningful way to fake that — an
 * in-memory or mocked database would pass every assertion while proving
 * nothing about the guarantee. They require a real Postgres 16.
 */
if (!process.env.DATABASE_URL || !process.env.ADMIN_DATABASE_URL) {
  throw new Error(
    [
      '',
      'The isolation tests need a real Postgres 16.',
      '',
      '  ADMIN_DATABASE_URL  owning role, used to seed fixtures past RLS',
      '  DATABASE_URL        the app_user role, used for everything under test',
      '',
      'Provision one, then:  pnpm db:bootstrap',
      '',
      'They cannot be stubbed. RLS is the thing being tested.',
      '',
    ].join('\n'),
  );
}

const admin = postgres(process.env.ADMIN_DATABASE_URL, { max: 4, onnotice: () => {} });

export interface CompanyFixture {
  firmId: string;
  companyId: string;
  companyAdminUserId: string;
  firmAdminUserId: string;
  firmStaffUserId: string;
  workerId: string;
  workerRecordId: string;
  ownerId: string;
  firmOnlyDocId: string;
  companyVisibleDocId: string;
  firmOnlyNoteId: string;
  grantId: string;
  dek: Buffer;
}

/** A tag unique to one test run, so parallel runs and leftovers never collide. */
export function runTag(): string {
  return randomBytes(6).toString('hex');
}

export async function seedCompany(label: string): Promise<CompanyFixture> {
  const tag = runTag();
  const firmId = randomUUID();
  const companyId = randomUUID();

  const dataKey = await getKms().generateDataKey({ companyId });

  const firmAdminUserId = randomUUID();
  const firmStaffUserId = randomUUID();
  const companyAdminUserId = randomUUID();
  const workerId = randomUUID();
  const workerRecordId = randomUUID();
  const ownerId = randomUUID();
  const firmOnlyDocId = randomUUID();
  const companyVisibleDocId = randomUUID();
  const firmOnlyNoteId = randomUUID();
  const grantId = randomUUID();

  await admin.begin(async (tx) => {
    await tx`
      insert into firms (id, name, contact_email, status)
      values (${firmId}, ${`Firm ${label} ${tag}`}, ${`firm-${tag}@example.test`}, 'active')
    `;

    await tx`
      insert into companies (
        id, firm_id, legal_name, ein, contact_email,
        dek_ciphertext, dek_key_id, onboarding_status, status, wc_status
      ) values (
        ${companyId}, ${firmId}, ${`Company ${label} ${tag}`}, '12-3456789',
        ${`co-${tag}@example.test`},
        ${dataKey.ciphertext}, ${dataKey.keyId}, 'PENDING', 'active', 'PENDING'
      )
    `;

    await tx`
      insert into firm_company_grants (id, firm_id, company_id, granted_at)
      values (${grantId}, ${firmId}, ${companyId}, now())
    `;

    // users_totp_pair_ck: a row claiming enrollment must hold a secret. The
    // value is never verified here — these fixtures exercise RLS, not login —
    // but the constraint is real and the fixture has to satisfy it.
    const totpSecret = seal(dataKey.plaintext, 'JBSWY3DPEHPK3PXP', companyId);

    await tx`
      insert into users (id, email, name, role, firm_id, status,
                         totp_secret_enc, totp_enabled_at)
      values
        (${firmAdminUserId}, ${`fa-${tag}@example.test`}, 'Firm Admin', 'FIRM_ADMIN',
         ${firmId}, 'active', ${totpSecret}, now()),
        (${firmStaffUserId}, ${`fs-${tag}@example.test`}, 'Firm Staff', 'FIRM_STAFF',
         ${firmId}, 'active', ${totpSecret}, now())
    `;

    await tx`
      insert into users (id, email, name, role, firm_id, company_id, status)
      values (${companyAdminUserId}, ${`ca-${tag}@example.test`}, 'Company Admin',
              'COMPANY_ADMIN', ${firmId}, ${companyId}, 'active')
    `;

    // Company-entered payroll row.
    await tx`
      insert into workers (
        id, company_id, worker_type, display_name, phone_e164,
        preferred_locale, status, job_title, pay_type, pay_frequency, work_state
      ) values (
        ${workerId}, ${companyId}, 'EMPLOYEE', ${`Worker ${label}`}, '+15555550100',
        'es', 'SUBMITTED', 'Installer', 'HOURLY', 'WEEKLY', 'NY'
      )
    `;

    // Worker-supplied record. The values are real-shaped so that the response
    // scanner in test 5 has something meaningful to fail on.
    const tin = seal(dataKey.plaintext, '123456789', companyId);
    const routing = seal(dataKey.plaintext, '021000021', companyId);
    const account = seal(dataKey.plaintext, '000123456789', companyId);

    await tx`
      insert into worker_records (
        id, worker_id, company_id, version, is_current,
        legal_first_name, legal_last_name, date_of_birth,
        tin_type, tin_enc, tin_last4,
        bank_name, bank_account_type, routing_enc, routing_last4,
        account_enc, account_last4, submitted_via
      ) values (
        ${workerRecordId}, ${workerId}, ${companyId}, 1, true,
        'Ada', 'Lovelace', '1990-04-01',
        'SSN', ${tin}, '6789',
        'Test Bank', 'CHECKING', ${routing}, '0021',
        ${account}, '6789', 'WORKER_FORM'
      )
    `;

    const ownerTin = seal(dataKey.plaintext, '987654321', companyId);
    await tx`
      insert into company_owners (
        id, company_id, display_name, ownership_percent, phone_e164,
        preferred_locale, status, legal_first_name, legal_last_name,
        date_of_birth, tin_type, tin_enc, tin_last4, submitted_at
      ) values (
        ${ownerId}, ${companyId}, ${`Owner ${label}`}, 100.00, '+15555550200',
        'en', 'SUBMITTED', 'Grace', 'Hopper',
        '1980-12-09', 'SSN', ${ownerTin}, '4321', now()
      )
    `;

    // A worker-uploaded voided check. Firm-only, and the trigger enforces that
    // regardless of what is passed here.
    await tx`
      insert into documents (
        id, company_id, subject_type, subject_id, doc_type, label,
        s3_key, content_type, size_bytes, uploaded_by_role, sensitivity
      ) values (
        ${firmOnlyDocId}, ${companyId}, 'WORKER', ${workerId}, 'VOIDED_CHECK',
        'voided check', ${`s3://test/${tag}/check.jpg`}, 'image/jpeg', 12345,
        'WORKER', 'COMPANY_VISIBLE'
      )
    `;

    await tx`
      insert into documents (
        id, company_id, subject_type, subject_id, doc_type, label,
        s3_key, content_type, size_bytes, uploaded_by_role, sensitivity
      ) values (
        ${companyVisibleDocId}, ${companyId}, 'COMPANY', ${companyId},
        'ARTICLES_OF_INCORPORATION', 'articles',
        ${`s3://test/${tag}/articles.pdf`}, 'application/pdf', 4242,
        'COMPANY_ADMIN', 'COMPANY_VISIBLE'
      )
    `;

    // The case the client document names by hand.
    await tx`
      insert into notes (
        id, company_id, subject_type, subject_id, body, author_role, visibility
      ) values (
        ${firmOnlyNoteId}, ${companyId}, 'WORKER', ${workerId},
        'My ITIN application is still pending.', 'WORKER', 'COMPANY_AND_FIRM'
      )
    `;
  });

  return {
    firmId,
    companyId,
    companyAdminUserId,
    firmAdminUserId,
    firmStaffUserId,
    workerId,
    workerRecordId,
    ownerId,
    firmOnlyDocId,
    companyVisibleDocId,
    firmOnlyNoteId,
    grantId,
    dek: dataKey.plaintext,
  };
}

export async function revokeGrant(grantId: string): Promise<void> {
  await admin`update firm_company_grants set revoked_at = now() where id = ${grantId}`;
}

export async function countSecurityViolations(companyId: string): Promise<number> {
  const rows = await admin<{ n: string }[]>`
    select count(*)::text as n from audit_log
    where company_id = ${companyId} and action = 'SECURITY_VIOLATION'
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Removes everything a fixture created, in FK-safe order. */
export async function destroyCompany(f: CompanyFixture): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`delete from audit_log where company_id = ${f.companyId}`;
    await tx`delete from notes where company_id = ${f.companyId}`;
    await tx`delete from documents where company_id = ${f.companyId}`;
    await tx`delete from signatures where company_id = ${f.companyId}`;
    await tx`delete from reminders where company_id = ${f.companyId}`;
    await tx`delete from invites where company_id = ${f.companyId}`;
    await tx`delete from worker_records where company_id = ${f.companyId}`;
    await tx`delete from workers where company_id = ${f.companyId}`;
    await tx`delete from company_owners where company_id = ${f.companyId}`;
    await tx`delete from exports where firm_id = ${f.firmId}`;
    await tx`delete from firm_company_grants where company_id = ${f.companyId}`;
    await tx`delete from users where firm_id = ${f.firmId}`;
    await tx`delete from companies where id = ${f.companyId}`;
    await tx`delete from firms where id = ${f.firmId}`;
  });
}

export async function closeAdmin(): Promise<void> {
  await admin.end();
}

// ---------------------------------------------------------------------------
// Staff auth fixtures
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export interface StaffFixture {
  firmId: string;
  companyId: string;
  userId: string;
  email: string;
  /** The raw setup-link token. Only its hash is stored, as in production. */
  setupToken: string;
}

/**
 * A firm user in `pending` state holding a live setup token — the state
 * `createCompany` and firm-staff invitation leave a new user in.
 *
 * Seeded on the admin connection like every other fixture, so that a bug in the
 * scoped path cannot quietly produce an empty fixture and a green test.
 */
export async function seedPendingStaffUser(
  role: 'FIRM_ADMIN' | 'FIRM_STAFF' | 'COMPANY_ADMIN' = 'FIRM_ADMIN',
): Promise<StaffFixture> {
  const tag = runTag();
  const firmId = randomUUID();
  const companyId = randomUUID();
  const userId = randomUUID();
  const email = `staff-${tag}@example.test`;
  const setupToken = randomBytes(32).toString('base64url');

  const dataKey = await getKms().generateDataKey({ companyId });

  await admin.begin(async (tx) => {
    await tx`
      insert into firms (id, name, status)
      values (${firmId}, ${`Firm ${tag}`}, 'active')
    `;
    await tx`
      insert into companies (
        id, firm_id, legal_name, dek_ciphertext, dek_key_id, wc_status, status
      ) values (
        ${companyId}, ${firmId}, ${`Company ${tag}`},
        ${dataKey.ciphertext}, ${dataKey.keyId}, 'PENDING', 'active'
      )
    `;
    await tx`
      insert into firm_company_grants (firm_id, company_id, granted_at)
      values (${firmId}, ${companyId}, now())
    `;
    await tx`
      insert into users (id, email, name, role, firm_id, company_id, status)
      values (
        ${userId}, ${email}, 'Test Staff', ${role}, ${firmId},
        ${role === 'COMPANY_ADMIN' ? companyId : null}, 'pending'
      )
    `;
    await tx`
      insert into user_setup_tokens (user_id, token_hash, expires_at)
      values (
        ${userId},
        ${createHash('sha256').update(setupToken).digest('hex')},
        now() + interval '24 hours'
      )
    `;
  });

  return { firmId, companyId, userId, email, setupToken };
}

export async function destroyStaffFixture(f: StaffFixture): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`delete from audit_log where firm_id = ${f.firmId}`;
    await tx`delete from login_attempts where identifier = ${f.email}`;
    await tx`delete from staff_sessions where user_id = ${f.userId}`;
    await tx`delete from user_setup_tokens where user_id = ${f.userId}`;
    await tx`delete from firm_company_grants where company_id = ${f.companyId}`;
    await tx`delete from users where firm_id = ${f.firmId}`;
    await tx`delete from companies where id = ${f.companyId}`;
    await tx`delete from firms where id = ${f.firmId}`;
  });
}

/** Row state a test needs to assert on directly. */
export async function readUserAuthState(userId: string): Promise<{
  status: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  totpEnabledAt: Date | null;
  totpLastCounter: number | null;
}> {
  const rows = await admin<
    {
      status: string;
      failed_login_count: number;
      locked_until: Date | null;
      totp_enabled_at: Date | null;
      totp_last_counter: string | null;
    }[]
  >`
    select status, failed_login_count, locked_until, totp_enabled_at, totp_last_counter
    from users where id = ${userId}
  `;
  const row = rows[0]!;
  return {
    status: row.status,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    totpEnabledAt: row.totp_enabled_at,
    totpLastCounter: row.totp_last_counter === null ? null : Number(row.totp_last_counter),
  };
}

export async function countAuditRows(firmId: string, action: string): Promise<number> {
  const rows = await admin<{ n: string }[]>`
    select count(*)::text as n from audit_log
    where firm_id = ${firmId} and action = ${action}::audit_action
  `;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Firm-only fixture, for tests that create their own companies
// ---------------------------------------------------------------------------

export interface FirmFixture {
  firmId: string;
  firmAdminUserId: string;
  firmStaffUserId: string;
}

/**
 * A firm with two active staff users and no companies.
 *
 * Tests that exercise `createCompany` need the firm to exist and the company
 * not to, which no other fixture provides — seedCompany deliberately builds a
 * finished tenant.
 */
export async function seedFirm(): Promise<FirmFixture> {
  const tag = runTag();
  const firmId = randomUUID();
  const firmAdminUserId = randomUUID();
  const firmStaffUserId = randomUUID();

  // The TOTP secret is never used here; users_totp_pair_ck requires the column
  // to travel with totp_enabled_at, and these users must be `active`.
  const filler = Buffer.from(randomBytes(60));

  await admin.begin(async (tx) => {
    await tx`
      insert into firms (id, name, contact_email, status)
      values (${firmId}, ${`Firm ${tag}`}, ${`firm-${tag}@example.test`}, 'active')
    `;
    await tx`
      insert into users (id, email, name, role, firm_id, status,
                         totp_secret_enc, totp_enabled_at)
      values
        (${firmAdminUserId}, ${`fa-${tag}@example.test`}, 'Firm Admin', 'FIRM_ADMIN',
         ${firmId}, 'active', ${filler}, now()),
        (${firmStaffUserId}, ${`fs-${tag}@example.test`}, 'Firm Staff', 'FIRM_STAFF',
         ${firmId}, 'active', ${filler}, now())
    `;
  });

  return { firmId, firmAdminUserId, firmStaffUserId };
}

/** Removes a firm and every company it created during a test. */
export async function destroyFirm(firmId: string): Promise<void> {
  await admin.begin(async (tx) => {
    const companies = await tx<{ id: string }[]>`
      select id from companies where firm_id = ${firmId}
    `;
    for (const { id } of companies) {
      await tx`delete from audit_log where company_id = ${id}`;
      await tx`delete from notes where company_id = ${id}`;
      await tx`delete from documents where company_id = ${id}`;
      await tx`delete from signatures where company_id = ${id}`;
      await tx`delete from reminders where company_id = ${id}`;
      await tx`delete from invites where company_id = ${id}`;
      await tx`delete from worker_records where company_id = ${id}`;
      await tx`delete from workers where company_id = ${id}`;
      await tx`delete from company_owners where company_id = ${id}`;
      await tx`delete from firm_company_grants where company_id = ${id}`;
    }
    await tx`delete from audit_log where firm_id = ${firmId}`;
    await tx`delete from exports where firm_id = ${firmId}`;
    await tx`delete from user_setup_tokens where user_id in (
      select id from users where firm_id = ${firmId}
    )`;
    await tx`delete from staff_sessions where user_id in (
      select id from users where firm_id = ${firmId}
    )`;
    await tx`delete from users where firm_id = ${firmId}`;
    await tx`delete from companies where firm_id = ${firmId}`;
    await tx`delete from firms where id = ${firmId}`;
  });
}

/** Reads a stored object back past RLS, to assert what actually landed. */
export async function readRow<T extends Record<string, unknown>>(
  query: string,
  ...params: unknown[]
): Promise<T | null> {
  const rows = await admin.unsafe<T[]>(query, params as never[]);
  return rows[0] ?? null;
}
