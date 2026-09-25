/**
 * Firm-facing reads and writes.
 *
 * A firm session is the only one that ever sees sensitive data, so every list
 * here still returns masked values — last-4 and nothing more. Plaintext comes
 * from exactly one function in the codebase, `decryptField`, and it is never
 * reached from a list view.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, withScope } from '../scoped';
import type { FirmSession } from '../../auth/session';
import { audit } from '../../audit';
import { generateCompanyDek } from '../../security/field-encryption';
import { issueSetupToken } from '../../auth/staff-auth';
import { uuidv7 } from '../../uuid';
import type { CreateCompanyInput } from '../../validation/forms';

// ---------------------------------------------------------------------------
// 7.1 Firm onboards a company
// ---------------------------------------------------------------------------

export interface CreatedCompany {
  companyId: string;
  adminUserId: string;
  /** The raw setup-link token. Emailed once, never stored. */
  setupToken: string;
}

/**
 * Creates the company, its data key, the grant, and the pending company admin,
 * in one transaction (spec section 7.1).
 *
 * All four succeed or none do. A company without a DEK cannot accept a single
 * sensitive field; a company without a grant is invisible to the firm that just
 * created it; an admin without a setup token is an account nobody can ever
 * reach. Each of those is a support ticket that looks like a different bug from
 * the one that caused it.
 *
 * Ids are generated here rather than by the column default because this session
 * cannot read the rows it is writing — see lib/uuid.ts.
 */
export async function createCompany(
  session: FirmSession,
  input: CreateCompanyInput,
): Promise<CreatedCompany> {
  const companyId = uuidv7();
  const adminUserId = uuidv7();

  // Outside the transaction: this is a KMS round trip, and holding a database
  // transaction open across a network call to another service is how connection
  // pools are exhausted by a provider having a slow afternoon.
  const dek = await generateCompanyDek(companyId);

  return withScope(session, async (db) => {
    await db.insert(schema.companies).values({
      id: companyId,
      firmId: session.firmId,
      legalName: input.legalName,
      dbaName: input.dbaName ?? null,
      ein: input.ein ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone ?? null,
      dekCiphertext: dek.ciphertext,
      dekKeyId: dek.keyId,
    });

    await db.insert(schema.firmCompanyGrants).values({
      id: uuidv7(),
      firmId: session.firmId,
      companyId,
      grantedBy: session.userId,
    });

    await db.insert(schema.users).values({
      id: adminUserId,
      email: input.adminEmail,
      name: input.adminName,
      role: 'COMPANY_ADMIN',
      firmId: session.firmId,
      companyId,
      status: 'pending',
    });

    const setupToken = await issueSetupToken(db, adminUserId);

    await audit(db, session, {
      action: 'COMPANY_CREATED',
      companyId,
      targetType: 'companies',
      targetId: companyId,
      metadata: { legalName: input.legalName },
    });
    await audit(db, session, {
      action: 'GRANT_CREATED',
      companyId,
      targetType: 'firm_company_grants',
      targetId: companyId,
    });

    return { companyId, adminUserId, setupToken };
  });
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * Ends a firm's access to a company. The row is kept and stamped rather than
 * deleted: "who had access, and until when" is a question an incident review
 * will ask, and a deleted row answers it with silence.
 */
export async function revokeGrant(
  session: FirmSession,
  companyId: string,
): Promise<boolean> {
  return withScope(session, async (db) => {
    const revoked = await db
      .update(schema.firmCompanyGrants)
      .set({ revokedAt: new Date(), revokedBy: session.userId })
      .where(
        and(
          eq(schema.firmCompanyGrants.firmId, session.firmId),
          eq(schema.firmCompanyGrants.companyId, companyId),
          isNull(schema.firmCompanyGrants.revokedAt),
        ),
      )
      .returning({ id: schema.firmCompanyGrants.id });

    if (revoked.length === 0) return false;

    await audit(db, session, {
      action: 'GRANT_REVOKED',
      companyId,
      targetType: 'firm_company_grants',
      targetId: companyId,
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface FirmCompanyRow {
  id: string;
  legalName: string;
  dbaName: string | null;
  onboardingStatus: string;
  status: string;
  workerCount: number;
  ownerCount: number;
  pendingWorkers: number;
  pendingOwners: number;
}

/**
 * The firm's company list, with completion counts.
 *
 * Counts come from correlated subqueries rather than from joins with GROUP BY:
 * two left joins onto the same company multiply each other's rows, and the
 * resulting counts are silently wrong in a way that looks plausible on a small
 * test dataset.
 */
export async function listCompaniesForFirm(session: FirmSession): Promise<FirmCompanyRow[]> {
  if (session.companyIds.length === 0) return [];

  return withScope(session, async (db) =>
    db
      .select({
        id: schema.companies.id,
        legalName: schema.companies.legalName,
        dbaName: schema.companies.dbaName,
        onboardingStatus: schema.companies.onboardingStatus,
        status: schema.companies.status,
        workerCount: sql<number>`(
          select count(*)::int from workers w where w.company_id = ${schema.companies.id}
        )`,
        ownerCount: sql<number>`(
          select count(*)::int from company_owners o where o.company_id = ${schema.companies.id}
        )`,
        pendingWorkers: sql<number>`(
          select count(*)::int from workers w
           where w.company_id = ${schema.companies.id}
             and w.status in ('INVITED','IN_PROGRESS','NEEDS_ATTENTION')
        )`,
        pendingOwners: sql<number>`(
          select count(*)::int from company_owners o
           where o.company_id = ${schema.companies.id}
             and o.status in ('INVITED','IN_PROGRESS')
        )`,
      })
      .from(schema.companies)
      .orderBy(desc(schema.companies.createdAt)),
  );
}

/** Full company detail for a firm. Banking is last-4 only; there is no plaintext here. */
export async function getCompanyForFirm(session: FirmSession, companyId: string) {
  return withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.companies.id,
        legalName: schema.companies.legalName,
        dbaName: schema.companies.dbaName,
        ein: schema.companies.ein,
        addressLine1: schema.companies.addressLine1,
        addressLine2: schema.companies.addressLine2,
        city: schema.companies.city,
        state: schema.companies.state,
        postalCode: schema.companies.postalCode,
        contactEmail: schema.companies.contactEmail,
        contactPhone: schema.companies.contactPhone,
        operatingStates: schema.companies.operatingStates,
        bankName: schema.companies.bankName,
        bankRoutingLast4: schema.companies.bankRoutingLast4,
        bankAccountLast4: schema.companies.bankAccountLast4,
        wcStatus: schema.companies.wcStatus,
        wcPolicyNumber: schema.companies.wcPolicyNumber,
        wcCarrier: schema.companies.wcCarrier,
        wcExpiresOn: schema.companies.wcExpiresOn,
        disabilityPolicyNumber: schema.companies.disabilityPolicyNumber,
        disabilityCarrier: schema.companies.disabilityCarrier,
        disabilityExpiresOn: schema.companies.disabilityExpiresOn,
        onboardingStatus: schema.companies.onboardingStatus,
        status: schema.companies.status,
        createdAt: schema.companies.createdAt,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);

    return rows[0] ?? null;
  });
}

export interface FirmWorkerRow {
  id: string;
  displayName: string;
  workerType: string;
  status: string;
  jobTitle: string | null;
  startDate: string | null;
  workState: string | null;
  submittedAt: Date | null;
  /** Masked. The firm sees the shape of the data before deciding to reveal it. */
  tinLast4: string | null;
  accountLast4: string | null;
  hasCurrentRecord: boolean;
}

export async function listWorkersForFirm(
  session: FirmSession,
  companyId: string,
): Promise<FirmWorkerRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.workers.id,
        displayName: schema.workers.displayName,
        workerType: schema.workers.workerType,
        status: schema.workers.status,
        jobTitle: schema.workers.jobTitle,
        startDate: schema.workers.startDate,
        workState: schema.workers.workState,
        submittedAt: schema.workers.submittedAt,
        tinLast4: schema.workerRecords.tinLast4,
        accountLast4: schema.workerRecords.accountLast4,
        hasCurrentRecord: sql<boolean>`${schema.workerRecords.id} is not null`,
      })
      .from(schema.workers)
      .leftJoin(
        schema.workerRecords,
        and(
          eq(schema.workerRecords.workerId, schema.workers.id),
          eq(schema.workerRecords.isCurrent, true),
        ),
      )
      .where(eq(schema.workers.companyId, companyId))
      .orderBy(desc(schema.workers.createdAt)),
  );
}

/**
 * The current version of one worker's record, masked.
 *
 * The ciphertext columns are selected because the reveal action needs them, and
 * they are stripped by `maskWorkerRecord` before anything reaches a response.
 * Selecting them lazily in a second query would mean a second round trip on
 * every reveal, and the reveal is the path where latency is most visible.
 */
export async function getWorkerRecordForFirm(
  session: FirmSession,
  workerId: string,
  version?: number,
) {
  return withScope(session, async (db) => {
    const rows = await db
      .select()
      .from(schema.workerRecords)
      .where(
        and(
          eq(schema.workerRecords.workerId, workerId),
          version === undefined
            ? eq(schema.workerRecords.isCurrent, true)
            : eq(schema.workerRecords.version, version),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  });
}

/** Every version of a worker's record, for the corrections history. */
export async function listWorkerRecordVersions(session: FirmSession, workerId: string) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.workerRecords.id,
        version: schema.workerRecords.version,
        effectiveFrom: schema.workerRecords.effectiveFrom,
        supersededAt: schema.workerRecords.supersededAt,
        isCurrent: schema.workerRecords.isCurrent,
        submittedVia: schema.workerRecords.submittedVia,
      })
      .from(schema.workerRecords)
      .where(eq(schema.workerRecords.workerId, workerId))
      .orderBy(desc(schema.workerRecords.version)),
  );
}

export async function listOwnersForFirm(session: FirmSession, companyId: string) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.companyOwners.id,
        displayName: schema.companyOwners.displayName,
        ownershipPercent: schema.companyOwners.ownershipPercent,
        status: schema.companyOwners.status,
        legalFirstName: schema.companyOwners.legalFirstName,
        legalLastName: schema.companyOwners.legalLastName,
        dateOfBirth: schema.companyOwners.dateOfBirth,
        city: schema.companyOwners.city,
        state: schema.companyOwners.state,
        email: schema.companyOwners.email,
        tinType: schema.companyOwners.tinType,
        tinLast4: schema.companyOwners.tinLast4,
        submittedAt: schema.companyOwners.submittedAt,
      })
      .from(schema.companyOwners)
      .where(eq(schema.companyOwners.companyId, companyId))
      .orderBy(desc(schema.companyOwners.createdAt)),
  );
}

/**
 * Strips every ciphertext column and leaves the masked view.
 *
 * Called at the boundary of anything that leaves the server. `_enc` values are
 * Buffers, which serialize to a JSON object of byte values rather than to
 * something obviously wrong, so a forgotten strip does not look like a bug in
 * review — it looks like a slightly large response.
 */
export function maskWorkerRecord<T extends Record<string, unknown>>(
  record: T | null,
): Omit<T, 'tinEnc' | 'routingEnc' | 'accountEnc'> | null {
  if (!record) return null;

  // Deleting from a copy rather than destructuring the keys away: the
  // destructured bindings are unused by construction, and a lint rule that
  // objects to unused bindings is right to — a `_t` that stops being unused is
  // a ciphertext someone started using.
  const copy: Record<string, unknown> = { ...record };
  delete copy.tinEnc;
  delete copy.routingEnc;
  delete copy.accountEnc;
  return copy as Omit<T, 'tinEnc' | 'routingEnc' | 'accountEnc'>;
}

// ---------------------------------------------------------------------------
// Audit reads
// ---------------------------------------------------------------------------

export async function listAuditForCompany(
  session: FirmSession,
  companyId: string,
  limit = 100,
) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        actorRole: schema.auditLog.actorRole,
        actorUserId: schema.auditLog.actorUserId,
        targetType: schema.auditLog.targetType,
        targetId: schema.auditLog.targetId,
        reason: schema.auditLog.reason,
        createdAt: schema.auditLog.createdAt,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.companyId, companyId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit),
  );
}

/**
 * Notes as the firm sees them: everything, including the FIRM_ONLY ones a
 * worker wrote. That asymmetry is the point of the visibility column.
 */
export async function listNotesForFirm(session: FirmSession, companyId: string) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.notes.id,
        body: schema.notes.body,
        authorRole: schema.notes.authorRole,
        visibility: schema.notes.visibility,
        subjectType: schema.notes.subjectType,
        subjectId: schema.notes.subjectId,
        createdAt: schema.notes.createdAt,
      })
      .from(schema.notes)
      .where(eq(schema.notes.companyId, companyId))
      .orderBy(desc(schema.notes.createdAt)),
  );
}

// ---------------------------------------------------------------------------
// Firm staff (spec section 2: FIRM_ADMIN "can manage firm staff")
// ---------------------------------------------------------------------------

export interface FirmStaffRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  totpEnabledAt: Date | null;
}

/**
 * The firm's own staff. `company_id is null` separates them from the company
 * admins this firm created, who share the same `firm_id` but belong to a
 * tenant below it.
 */
export async function listFirmStaff(session: FirmSession): Promise<FirmStaffRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        status: schema.users.status,
        lastLoginAt: schema.users.lastLoginAt,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.users)
      .where(and(eq(schema.users.firmId, session.firmId), isNull(schema.users.companyId)))
      .orderBy(desc(schema.users.createdAt)),
  );
}

export interface InvitedStaff {
  userId: string;
  setupToken: string;
}

/**
 * Adds a member of firm staff.
 *
 * Created `pending` with a 24-hour setup link, exactly like a company admin.
 * The firm admin never sets a password for anyone: `users_totp_ck` refuses to
 * let a firm user reach `active` without an enrolled authenticator, so the only
 * path to an active firm account runs through that person's own device.
 */
export async function inviteFirmStaff(
  session: FirmSession,
  input: { name: string; email: string; role: 'FIRM_ADMIN' | 'FIRM_STAFF' },
): Promise<InvitedStaff> {
  if (session.role !== 'FIRM_ADMIN') {
    throw new Error('Only a FIRM_ADMIN may manage firm staff (spec section 2).');
  }

  const userId = uuidv7();

  return withScope(session, async (db) => {
    await db.insert(schema.users).values({
      id: userId,
      email: input.email,
      name: input.name,
      role: input.role,
      firmId: session.firmId,
      companyId: null,
      status: 'pending',
    });

    const setupToken = await issueSetupToken(db, userId);

    await audit(db, session, {
      action: 'GRANT_CREATED',
      targetType: 'users',
      targetId: userId,
      metadata: { operation: 'staff_invited', role: input.role },
    });

    return { userId, setupToken };
  });
}

/**
 * Suspends or reactivates a member of firm staff.
 *
 * Takes effect on their next request: `resolveStaffSession` refuses any user
 * whose status is not `active`, so a live session dies without waiting for its
 * expiry. Suspending yourself is refused — an administrator who locks
 * themselves out of the only FIRM_ADMIN account needs the platform admin to
 * undo it.
 *
 * Reactivation restores the status the account had, which is not always
 * `active`. Somebody suspended before they ever opened their setup link has no
 * authenticator, and `users_totp_ck` refuses a firm user in `active` without
 * one — so reactivating them wrote a constraint violation into a server action
 * and the page rendered "a server-side exception has occurred". Worse, they
 * were stuck there: `completeSetup` only finishes an account that is still
 * `pending`, so the setup link they were holding had stopped working too.
 * Sending them back to `pending` is both what the constraint permits and what
 * the word means — their invitation is live again, and `resendStaffSetup`
 * below can put a fresh link in front of them.
 */
export async function setStaffStatus(
  session: FirmSession,
  userId: string,
  status: 'active' | 'suspended',
): Promise<'active' | 'pending' | 'suspended' | null> {
  if (session.role !== 'FIRM_ADMIN') {
    throw new Error('Only a FIRM_ADMIN may manage firm staff (spec section 2).');
  }
  if (userId === session.userId) {
    throw new Error('Refusing to change your own account status.');
  }

  return withScope(session, async (db) => {
    const updated = await db
      .update(schema.users)
      .set({
        // Decided in SQL rather than by reading the row first: two admins
        // reactivating the same account would both read `totp_enabled_at` as
        // null, and one of them would then write `active` over an enrollment
        // that had just landed.
        status:
          status === 'suspended'
            ? 'suspended'
            : sql`case
                     when ${schema.users.totpEnabledAt} is null then 'pending'::user_status
                     else 'active'::user_status
                   end`,
      })
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.firmId, session.firmId),
          isNull(schema.users.companyId),
        ),
      )
      .returning({ status: schema.users.status });

    const applied = updated[0]?.status;
    if (!applied) return null;

    await audit(db, session, {
      action: status === 'suspended' ? 'GRANT_REVOKED' : 'GRANT_CREATED',
      targetType: 'users',
      targetId: userId,
      // The status that was actually written, not the one that was asked for.
      metadata: { operation: 'staff_status', status: applied },
    });
    return applied;
  });
}

export interface StaffSetupLink {
  email: string;
  name: string;
  /** The raw token. Emailed once, never stored. */
  setupToken: string;
}

/**
 * Issues a replacement setup link for a staff member who has not finished.
 *
 * For the two ways the first one fails: it expired after its 24 hours, or it
 * never arrived. Outstanding links are retired first — one live link per
 * person, so a resend genuinely supersedes rather than accumulates.
 *
 * Returns null rather than throwing when there is nobody to re-invite, so that
 * a stale page whose button is still on screen after the person completed
 * setup is a no-op instead of an error. An account that is already `active`
 * does not need an invitation; it needs a password reset, which is a different
 * feature and not one this system has yet.
 */
export async function resendStaffSetup(
  session: FirmSession,
  userId: string,
): Promise<StaffSetupLink | null> {
  if (session.role !== 'FIRM_ADMIN') {
    throw new Error('Only a FIRM_ADMIN may manage firm staff (spec section 2).');
  }

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        email: schema.users.email,
        name: schema.users.name,
        status: schema.users.status,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.firmId, session.firmId),
          isNull(schema.users.companyId),
        ),
      )
      .limit(1);

    const user = rows[0];
    // Both halves matter. `pending` alone would re-invite a suspended account
    // back into existence; a null `totp_enabled_at` alone would hand a live
    // password-and-authenticator link to somebody who already has both.
    if (!user || user.status !== 'pending' || user.totpEnabledAt !== null) return null;

    await db
      .update(schema.userSetupTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.userSetupTokens.userId, userId),
          isNull(schema.userSetupTokens.consumedAt),
        ),
      );

    const setupToken = await issueSetupToken(db, userId);

    await audit(db, session, {
      action: 'INVITE_SENT',
      targetType: 'users',
      targetId: userId,
      metadata: { operation: 'staff_setup_resent' },
    });

    return { email: user.email, name: user.name, setupToken };
  });
}
