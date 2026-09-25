/**
 * Platform administration.
 *
 * Spec section 2 gives this role a deliberately narrow job: "Can create firms,
 * suspend accounts, read audit metadata. Cannot decrypt anything."
 *
 * The Postgres role backs that up — `app_platform` holds privileges on `firms`,
 * `users` and `audit_log` and on nothing else. It is explicitly not granted on
 * `company_owners` or `worker_records`, so it cannot read the ciphertext, let
 * alone decrypt it.
 *
 * "Audit metadata" is read literally here. The reads below return actions,
 * actors and timestamps, and deliberately omit `reason` and `target_id`: a
 * reveal reason routinely names a person ("preparing the 1099 for Ada
 * Lovelace"), and a role that is not allowed to read a worker's name should not
 * receive it in free text through the back door.
 */
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { schema, withScope } from '../scoped';
import type { PlatformSession } from '../../auth/session';
import { audit } from '../../audit';
import { issueSetupToken } from '../../auth/staff-auth';
import { uuidv7 } from '../../uuid';

export interface FirmRow {
  id: string;
  name: string;
  contactEmail: string | null;
  status: string;
  createdAt: Date;
  companyCount: number;
  staffCount: number;
}

export async function listFirms(session: PlatformSession): Promise<FirmRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.firms.id,
        name: schema.firms.name,
        contactEmail: schema.firms.contactEmail,
        status: schema.firms.status,
        createdAt: schema.firms.createdAt,
        // Counts, not contents — and through a security-definer function
        // returning one integer, because app_platform has no privilege on
        // `companies` and must not be given one. A subquery over the table
        // fails with permission denied, which is the design working.
        companyCount: sql<number>`app.firm_company_count(${schema.firms.id})`,
        staffCount: sql<number>`(
          select count(*)::int from users u
           where u.firm_id = ${schema.firms.id} and u.company_id is null
        )`,
      })
      .from(schema.firms)
      .orderBy(desc(schema.firms.createdAt)),
  );
}

export interface CreatedFirm {
  firmId: string;
  adminUserId: string;
  setupToken: string;
}

/**
 * Creates a firm and its first administrator, in one transaction.
 *
 * The first firm admin is the one account in the system nobody else can create
 * — a firm with no way in is a support call, and a firm created without one
 * leaves a tenant that exists and cannot be used.
 */
export async function createFirm(
  session: PlatformSession,
  input: { name: string; contactEmail: string; adminName: string; adminEmail: string },
): Promise<CreatedFirm> {
  const firmId = uuidv7();
  const adminUserId = uuidv7();

  return withScope(session, async (db) => {
    await db.insert(schema.firms).values({
      id: firmId,
      name: input.name,
      contactEmail: input.contactEmail,
      status: 'active',
    });

    await db.insert(schema.users).values({
      id: adminUserId,
      email: input.adminEmail,
      name: input.adminName,
      role: 'FIRM_ADMIN',
      firmId,
      companyId: null,
      status: 'pending',
    });

    const setupToken = await issueSetupToken(db, adminUserId);

    await audit(db, session, {
      action: 'COMPANY_CREATED',
      firmId,
      targetType: 'firms',
      targetId: firmId,
      metadata: { operation: 'firm_created', name: input.name },
    });

    return { firmId, adminUserId, setupToken };
  });
}

/**
 * Suspends or reactivates a firm.
 *
 * Suspension does not cascade to `firm_company_grants`. That is deliberate: a
 * suspended firm's staff cannot log in, so the grants are already unreachable,
 * and revoking them would destroy the record of who had access to what — which
 * is the thing an investigation into why the firm was suspended would want.
 */
export async function setFirmStatus(
  session: PlatformSession,
  firmId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  await withScope(session, async (db) => {
    await db.update(schema.firms).set({ status }).where(eq(schema.firms.id, firmId));

    // Staff of a suspended firm cannot authenticate. resolveStaffSession
    // refuses any user whose status is not `active`, so this closes live
    // sessions on their next request as well as blocking new logins.
    await db
      .update(schema.users)
      .set({
        // Reactivation restores what each account was, which is `pending` for
        // anyone who never enrolled an authenticator — a firm admin may have
        // suspended an invitee individually before the firm itself was
        // suspended. `users_totp_ck` refuses those rows in `active`, and the
        // violation would take the whole firm's reactivation down with it.
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
          eq(schema.users.firmId, firmId),
          // Only staff who had completed setup. A pending invitee stays pending
          // rather than being silently activated by a reactivation.
          eq(schema.users.status, status === 'suspended' ? 'active' : 'suspended'),
        ),
      );

    await audit(db, session, {
      action: status === 'suspended' ? 'GRANT_REVOKED' : 'GRANT_CREATED',
      firmId,
      targetType: 'firms',
      targetId: firmId,
      metadata: { operation: 'firm_status', status },
    });
  });
}

export interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  firmId: string | null;
  lastLoginAt: Date | null;
  totpEnabledAt: Date | null;
}

export async function listAllStaff(session: PlatformSession): Promise<StaffRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        status: schema.users.status,
        firmId: schema.users.firmId,
        lastLoginAt: schema.users.lastLoginAt,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt))
      .limit(500),
  );
}

export interface AuditSummaryRow {
  action: string;
  actorRole: string;
  occurrences: number;
  mostRecent: Date;
}

/**
 * Audit metadata: what happened, how often, by which role, and when — with no
 * reason text, no target ids, and no company names.
 *
 * A platform admin investigating "is anything odd happening on this
 * installation" gets everything they need from shape and volume. Reading the
 * individual rows is a firm's job, on their own companies, on the activity tab.
 */
export async function auditSummary(
  session: PlatformSession,
  sinceDays = 30,
): Promise<AuditSummaryRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  return withScope(session, async (db) =>
    db
      .select({
        action: schema.auditLog.action,
        actorRole: schema.auditLog.actorRole,
        occurrences: count(),
        mostRecent: sql<Date>`max(${schema.auditLog.createdAt})`,
      })
      .from(schema.auditLog)
      .where(gte(schema.auditLog.createdAt, since))
      .groupBy(schema.auditLog.action, schema.auditLog.actorRole)
      .orderBy(desc(sql`max(${schema.auditLog.createdAt})`)),
  );
}
