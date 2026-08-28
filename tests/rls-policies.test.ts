/**
 * Row level security, exercised directly against the policies.
 *
 * tests/isolation.test.ts goes through the data access layer, which means it
 * proves the two layers together and cannot tell you which one is holding. This
 * file drops to the Postgres roles and asks layer 1 on its own — because "the
 * hand-written WHERE clause happens to be right" and "the policy would stop it"
 * are different guarantees, and only the second one survives a refactor.
 *
 * Two holes were found this way and are pinned here:
 *
 *   A `FOR ALL` policy applies its USING clause to SELECT as well, and multiple
 *   permissive policies are OR-ed per command. `users_write` was FOR ALL with no
 *   firm predicate, so it OR-ed itself over `users_select` and a firm admin
 *   could read every user row in the database — password hashes included.
 *
 *   `app.can_read_company()` is true for a subject's own company, so an invite
 *   policy written as `can_read_company(company_id) OR subject_id = ...` made
 *   the second clause dead code: one worker could read every other worker's
 *   draft, which holds their name, date of birth and address in plaintext.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeAdmin, destroyFirm, seedFirm, type FirmFixture } from './fixtures';
import { createCompany } from '../lib/db/queries/firm';
import { inviteOwner, inviteWorker } from '../lib/db/queries/subjects';
import { resolveFirmScope } from '../lib/auth/scope';
import { evictDek } from '../lib/security/field-encryption';
import { __setEmailProvider } from '../lib/services/messaging';
import type { CompanySession, FirmSession } from '../lib/auth/session';

/** The app_user login role — the same credential the application runs on. */
const app = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {}, prepare: false });

interface Tenant {
  firm: FirmFixture;
  companyId: string;
  workerId: string;
  ownerId: string;
}

let a: Tenant;
let b: Tenant;

/** Runs `fn` under a specific application role and scope, as withScope would. */
async function asRole<T>(
  settings: {
    role: string;
    scope?: string;
    userId?: string;
    subjectId?: string;
    firmId?: string;
    dbRole: string;
  },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`
      select set_config('app.actor_role',    ${settings.role},          true),
             set_config('app.actor_scope',   ${settings.scope ?? ''},   true),
             set_config('app.actor_user_id', ${settings.userId ?? ''},  true),
             set_config('app.subject_id',    ${settings.subjectId ?? ''}, true),
             set_config('app.firm_id',       ${settings.firmId ?? ''},  true)
    `;
    await tx.unsafe(`set local role ${settings.dbRole}`);
    return fn(tx);
  }) as Promise<T>;
}

async function seedTenant(label: string): Promise<Tenant> {
  const firm = await seedFirm();
  const session: FirmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
  };

  const created = await createCompany(session, {
    legalName: `RLS ${label}`,
    dbaName: null,
    ein: '12-3456789',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    contactEmail: `office-${label}-${Date.now()}@rls.test`,
    contactPhone: null,
    adminName: 'Admin',
    adminEmail: `rls-${label}-${Date.now()}@rls.test`,
  });

  const companySession: CompanySession = {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: created.adminUserId,
    firmId: firm.firmId,
    companyId: created.companyId,
  };

  const worker = await inviteWorker(companySession, created.companyId, {
    displayName: `Worker ${label}`,
    workerType: 'EMPLOYEE',
    inviteEmail: `worker-${label}@personal.test`,
    phoneE164: '+15555559000',
    preferredLocale: 'en',
    jobTitle: null,
    startDate: null,
    payType: null,
    payFrequency: null,
    workState: null,
  });

  const owner = await inviteOwner(companySession, created.companyId, {
    displayName: `Owner ${label}`,
    ownershipPercent: 100,
    inviteEmail: `owner-${label}@personal.test`,
    phoneE164: '+15555559001',
    preferredLocale: 'en',
  });

  void (await resolveFirmScope(firm.firmId, firm.firmAdminUserId));

  return {
    firm,
    companyId: created.companyId,
    workerId: worker.subjectId,
    ownerId: owner.subjectId,
  };
}

beforeAll(async () => {
  __setEmailProvider({ name: 'test', async send() {} });
  a = await seedTenant('A');
  b = await seedTenant('B');
});

afterAll(async () => {
  evictDek();
  __setEmailProvider(undefined);
  if (a) await destroyFirm(a.firm.firmId);
  if (b) await destroyFirm(b.firm.firmId);
  await app.end();
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('users, as the policies see them', () => {
  it('a firm admin cannot read another firm\'s users', async () => {
    const rows = await asRole(
      {
        role: 'FIRM_ADMIN',
        userId: a.firm.firmAdminUserId,
        firmId: a.firm.firmId,
        dbRole: 'app_firm',
      },
      (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from users where firm_id = ${b.firm.firmId}
      `,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('a firm admin cannot name a password hash or a TOTP secret at all', async () => {
    // Column-level, so this fails with insufficient_privilege rather than
    // returning nulls. Firm code never needs these — authentication runs as
    // app_auth — and a role that cannot name a column cannot leak it through a
    // hand-written query either.
    for (const column of ['password_hash', 'totp_secret_enc', 'totp_last_counter']) {
      await expect(
        asRole(
          {
            role: 'FIRM_ADMIN',
            userId: a.firm.firmAdminUserId,
            firmId: a.firm.firmId,
            dbRole: 'app_firm',
          },
          (tx) => tx.unsafe(`select ${column} from users limit 1`),
        ),
        `app_firm could name users.${column}`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('a firm admin can still read its own staff', async () => {
    // The check is discriminating rather than simply refusing everything.
    const rows = await asRole(
      {
        role: 'FIRM_ADMIN',
        userId: a.firm.firmAdminUserId,
        firmId: a.firm.firmId,
        dbRole: 'app_firm',
      },
      (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from users where firm_id = ${a.firm.firmId}
      `,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('a firm admin cannot move a user into another firm', async () => {
    await expect(
      asRole(
        {
          role: 'FIRM_ADMIN',
          userId: a.firm.firmAdminUserId,
          firmId: a.firm.firmId,
          dbRole: 'app_firm',
        },
        (tx) => tx`update users set firm_id = ${a.firm.firmId} where firm_id = ${b.firm.firmId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('invites, as the policies see them', () => {
  it('a subject sees only its own invite, not its colleagues\'', async () => {
    const rows = await asRole(
      {
        role: 'WORKER',
        scope: a.companyId,
        subjectId: a.workerId,
        dbRole: 'app_subject',
      },
      (tx) => tx<{ subject_id: string }[]>`select subject_id from invites`,
    );

    // The company has both a worker invite and an owner invite.
    expect(rows.map((row) => row.subject_id)).toEqual([a.workerId]);
  });

  it('a subject cannot read another subject\'s draft', async () => {
    // The draft holds the legal name, date of birth and home address in
    // plaintext. One worker reading another's is the same disclosure the
    // worker/worker_records split exists to prevent.
    const rows = await asRole(
      { role: 'WORKER', scope: a.companyId, subjectId: a.workerId, dbRole: 'app_subject' },
      (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from invites where subject_id = ${a.ownerId}
      `,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('a subject cannot rewrite another subject\'s invite', async () => {
    // Setting someone else's token_hash and verified_at would mint a session as
    // them, past the date-of-birth gate.
    const updated = await asRole(
      { role: 'WORKER', scope: a.companyId, subjectId: a.workerId, dbRole: 'app_subject' },
      (tx) => tx<{ id: string }[]>`
        update invites set verified_at = now()
         where subject_id = ${a.ownerId}
        returning id
      `,
    );
    expect(updated).toHaveLength(0);
  });

  it('a company still sees that its invites exist', async () => {
    const rows = await asRole(
      { role: 'COMPANY_ADMIN', scope: a.companyId, dbRole: 'app_company' },
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from invites`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('a firm still sees the invites of a company it holds a grant on', async () => {
    const rows = await asRole(
      {
        role: 'FIRM_ADMIN',
        scope: a.companyId,
        userId: a.firm.firmAdminUserId,
        firmId: a.firm.firmId,
        dbRole: 'app_firm',
      },
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from invites`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('no policy silently widens another', () => {
  it('has no FOR ALL policy on a table whose SELECT is meant to be narrower', async () => {
    // A FOR ALL policy applies its USING clause to SELECT too, and permissive
    // policies are OR-ed. That is how users_write quietly became the effective
    // read rule for the whole table. Any new FOR ALL policy on these tables
    // should be a deliberate decision, so this test makes it a visible one.
    const rows = await app<{ tablename: string; policyname: string }[]>`
      select tablename, policyname
        from pg_policies
       where schemaname = 'public'
         and cmd = 'ALL'
         and tablename in ('users', 'invites', 'companies', 'workers',
                           'worker_records', 'company_owners', 'documents', 'notes')
       order by tablename
    `;
    expect(rows.map((row) => `${row.tablename}.${row.policyname}`)).toEqual([]);
  });
});
