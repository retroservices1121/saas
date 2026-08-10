/**
 * The five isolation tests from spec section 5.
 *
 * "Required integration tests, all must pass before any feature work
 *  continues."
 *
 * Nothing in this file mocks the database. Each assertion exercises the real
 * policies, the real column grants, and the real DAL, because those three are
 * what the guarantee actually rests on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAdmin,
  countSecurityViolations,
  destroyCompany,
  revokeGrant,
  seedCompany,
  type CompanyFixture,
} from './fixtures';
import {
  findByIdInScope,
  getCompanyProfile,
  listDocumentsForCompany,
  listNotesForCompany,
  listOwnersForCompany,
  listWorkersForCompany,
} from '../lib/db/queries/company';
import { withScope, withScopeOrNull, ScopeViolationError, schema } from '../lib/db/scoped';
import type { CompanySession, FirmSession } from '../lib/auth/session';
import { evictDek } from '../lib/security/field-encryption';

let A: CompanyFixture;
let B: CompanyFixture;

function companySession(f: CompanyFixture): CompanySession {
  return {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: f.companyAdminUserId,
    firmId: f.firmId,
    companyId: f.companyId,
    ip: '203.0.113.10',
    userAgent: 'vitest',
  };
}

function firmSession(f: CompanyFixture, companyIds: string[]): FirmSession {
  return {
    kind: 'firm',
    role: 'FIRM_STAFF',
    userId: f.firmStaffUserId,
    firmId: f.firmId,
    companyIds,
    ip: '203.0.113.11',
    userAgent: 'vitest',
  };
}

beforeAll(async () => {
  A = await seedCompany('A');
  B = await seedCompany('B');
});

afterAll(async () => {
  evictDek();
  if (A) await destroyCompany(A);
  if (B) await destroyCompany(B);
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('1. cross-tenant reads by direct id', () => {
  const TABLES = [
    'companies',
    'workers',
    'company_owners',
    'documents',
    'notes',
    'worker_records',
  ] as const;

  it('Company A, authenticated, cannot fetch any entity type of Company B', async () => {
    const session = companySession(A);

    // Ids are handed to the query directly, as an attacker enumerating uuids
    // would. Nothing filters by company id in the call — the scope does.
    const targets: Record<(typeof TABLES)[number], string> = {
      companies: B.companyId,
      workers: B.workerId,
      company_owners: B.ownerId,
      documents: B.companyVisibleDocId,
      notes: B.firmOnlyNoteId,
      worker_records: B.workerRecordId,
    };

    for (const table of TABLES) {
      const found = await findByIdInScope(session, table, targets[table]);
      expect(found, `${table} of company B leaked to company A`).toBeNull();
    }
  });

  it("A's own list views contain none of B's rows", async () => {
    const session = companySession(A);

    const [workers, owners, docs, notes] = await Promise.all([
      listWorkersForCompany(session),
      listOwnersForCompany(session),
      listDocumentsForCompany(session),
      listNotesForCompany(session),
    ]);

    expect(workers.map((w) => w.id)).not.toContain(B.workerId);
    expect(owners.map((o) => o.id)).not.toContain(B.ownerId);
    expect(docs.map((d) => d.id)).not.toContain(B.companyVisibleDocId);
    expect(notes.map((n) => n.id)).not.toContain(B.firmOnlyNoteId);

    // And the positive case, so a bug that returns nothing at all still fails.
    expect(workers.map((w) => w.id)).toContain(A.workerId);
  });

  it('a firm cannot reach another firm\'s company even with a forged scope', async () => {
    // Firm A's session, with company B injected into the scope array — exactly
    // what a bug in scope derivation, or a tampered session, would produce.
    //
    // Layer 1 does not take the scope's word for it: app.can_read_company()
    // re-checks firm_company_grants for a live grant held by THIS firm. Firm A
    // has no grant on company B, so the row stays invisible.
    const forged = firmSession(A, [A.companyId, B.companyId]);

    expect(await findByIdInScope(forged, 'companies', B.companyId)).toBeNull();
    expect(await findByIdInScope(forged, 'workers', B.workerId)).toBeNull();
    expect(await findByIdInScope(forged, 'worker_records', B.workerRecordId)).toBeNull();

    // A's own company is still readable, so the check is discriminating rather
    // than simply refusing everything.
    expect(await findByIdInScope(forged, 'companies', A.companyId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('2. COMPANY_ADMIN vs worker_records', () => {
  it('returns not-found for its OWN company, and records a SECURITY_VIOLATION', async () => {
    const session = companySession(A);
    const before = await countSecurityViolations(A.companyId);

    // Its own worker, its own company, its own record. Still refused.
    const found = await findByIdInScope(session, 'worker_records', A.workerRecordId);
    expect(found).toBeNull();

    const after = await countSecurityViolations(A.companyId);
    expect(after, 'no SECURITY_VIOLATION row was written').toBeGreaterThan(before);
  });

  it('the underlying error is a privilege violation, not an empty result', async () => {
    const session = companySession(A);

    // withScope (not withScopeOrNull) surfaces the raw failure. The distinction
    // matters: an empty result would look like missing data and would be
    // triaged as a data-quality bug rather than a security defect.
    await expect(
      withScope(session, async (db) =>
        db.select().from(schema.workerRecords).limit(1),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('a company cannot read tin_last4 from company_owners either', async () => {
    const session = companySession(A);

    // "Never sees worker or owner sensitive fields, not even last-4."
    await expect(
      withScope(session, async (db) =>
        db
          .select({ tinLast4: schema.companyOwners.tinLast4 })
          .from(schema.companyOwners)
          .limit(1),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('a firm session CAN read the same record — the test is not passing vacuously', async () => {
    const session = firmSession(A, [A.companyId]);
    const rows = await withScope(session, async (db) =>
      db.select({ id: schema.workerRecords.id }).from(schema.workerRecords),
    );
    expect(rows.map((r) => r.id)).toContain(A.workerRecordId);
  });
});

// ---------------------------------------------------------------------------

describe('3. COMPANY_ADMIN vs a FIRM_ONLY document', () => {
  it('cannot fetch it by id, in its own company', async () => {
    const session = companySession(A);
    expect(await findByIdInScope(session, 'documents', A.firmOnlyDocId)).toBeNull();
  });

  it('the file does not appear in the document list at all', async () => {
    const session = companySession(A);
    const docs = await listDocumentsForCompany(session);
    const ids = docs.map((d) => d.id);

    expect(ids).not.toContain(A.firmOnlyDocId);
    expect(ids).toContain(A.companyVisibleDocId);
  });

  it('the trigger forced FIRM_ONLY even though the fixture inserted COMPANY_VISIBLE', async () => {
    // The fixture deliberately writes sensitivity = 'COMPANY_VISIBLE' for a
    // worker-uploaded voided check. Spec section 4: default to FIRM_ONLY for
    // anything a worker or owner uploads, with no override.
    const session = firmSession(A, [A.companyId]);
    const rows = await withScope(session, async (db) =>
      db
        .select({ id: schema.documents.id, sensitivity: schema.documents.sensitivity })
        .from(schema.documents),
    );
    const doc = rows.find((r) => r.id === A.firmOnlyDocId);
    expect(doc?.sensitivity).toBe('FIRM_ONLY');
  });

  it('a worker-authored note is likewise forced firm-only and hidden', async () => {
    const session = companySession(A);
    const notes = await listNotesForCompany(session);
    expect(notes.map((n) => n.id)).not.toContain(A.firmOnlyNoteId);
  });
});

// ---------------------------------------------------------------------------

describe('4. FIRM_STAFF vs a revoked grant', () => {
  it('a company with a revoked grant is not found', async () => {
    // Before revocation, with the grant live, the company is visible.
    const live = firmSession(A, [A.companyId]);
    expect(await findByIdInScope(live, 'companies', A.companyId)).not.toBeNull();

    await revokeGrant(A.grantId);

    // Scope is recomputed from live grants at session start. After revocation
    // the id is simply absent, which is why this reads as not-found rather than
    // as forbidden — there is nothing to distinguish it from a company that was
    // never granted.
    const afterRevoke = await resolveFirmScope(A.firmId);
    expect(afterRevoke).not.toContain(A.companyId);

    const stale = firmSession(A, afterRevoke);
    expect(await findByIdInScope(stale, 'companies', A.companyId)).toBeNull();
    expect(await findByIdInScope(stale, 'workers', A.workerId)).toBeNull();
    expect(await findByIdInScope(stale, 'worker_records', A.workerRecordId)).toBeNull();
  });
});

/**
 * How a firm session's scope is derived at login: live grants only, read
 * server-side, never accepted from the client.
 */
async function resolveFirmScope(firmId: string): Promise<string[]> {
  const bootstrap: FirmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: A.firmAdminUserId,
    firmId,
    companyIds: [],
  };
  const rows = await withScope(bootstrap, async (db) =>
    db
      .select({ companyId: schema.firmCompanyGrants.companyId })
      .from(schema.firmCompanyGrants),
  );
  return rows.map((r) => r.companyId);
}

// ---------------------------------------------------------------------------

describe('5. no sensitive substring escapes a company-scoped response', () => {
  const FORBIDDEN = ['_enc', 'tin', 'routing', 'account'];

  it('every company-scoped read serializes without _enc, tin, routing, or account', async () => {
    const session = companySession(B);

    const responses: Record<string, unknown> = {
      profile: await getCompanyProfile(session),
      workers: await listWorkersForCompany(session),
      owners: await listOwnersForCompany(session),
      documents: await listDocumentsForCompany(session),
      notes: await listNotesForCompany(session),
    };

    for (const [name, payload] of Object.entries(responses)) {
      const json = JSON.stringify(payload);
      for (const needle of FORBIDDEN) {
        expect(
          json.toLowerCase().includes(needle),
          `company-scoped response "${name}" contains "${needle}": ${json.slice(0, 400)}`,
        ).toBe(false);
      }
    }
  });

  it('the scanner would actually catch a leak', async () => {
    // A scanner that never fires is indistinguishable from one that is broken.
    // This proves the assertion above has teeth.
    const leaky = JSON.stringify({ tinLast4: '6789' });
    const caught = FORBIDDEN.some((n) => leaky.toLowerCase().includes(n));
    expect(caught).toBe(true);
  });

  it('no ciphertext is ever serializable from a company session', async () => {
    const session = companySession(B);
    const result = await withScopeOrNull(session, async (db) =>
      db.select().from(schema.workerRecords),
    );
    // Refused outright, so there is nothing to serialize.
    expect(result).toBeNull();
  });
});
