/**
 * Session scope derivation.
 *
 * A firm session's reach is the set of companies it holds a LIVE grant on —
 * granted and not revoked. That set is computed here, server-side, at session
 * start, and it is never accepted from the client (spec section 5, layer 1).
 *
 * Revocation is the case this function exists for. `firm_company_grants` keeps
 * revoked rows forever, because the audit trail needs to show that the access
 * existed and when it ended. So a query that forgets `revoked_at is null`
 * returns a superset that looks entirely plausible and silently restores access
 * the firm was supposed to have lost. The RLS predicate re-derives the grant
 * independently and would still refuse the read — but a session whose scope
 * claims companies it cannot actually read produces empty pages rather than a
 * clean "no access", so both layers need to agree.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { schema, withScope } from '../db/scoped';
import type { CompanySession, FirmSession, PlatformSession, Session } from './session';

/**
 * Company ids a firm user may touch right now.
 *
 * The bootstrap session deliberately starts with an empty scope: this query
 * reads `firm_company_grants`, whose policy is keyed on `app.firm_id` rather
 * than on the company scope, so it needs no scope to run. Anything that did
 * need one would be a circular derivation.
 */
export async function resolveFirmScope(
  firmId: string,
  userId: string,
  role: 'FIRM_ADMIN' | 'FIRM_STAFF' = 'FIRM_ADMIN',
): Promise<string[]> {
  const bootstrap: FirmSession = {
    kind: 'firm',
    role,
    userId,
    firmId,
    companyIds: [],
  };

  const rows = await withScope(bootstrap, async (db) =>
    db
      .select({ companyId: schema.firmCompanyGrants.companyId })
      .from(schema.firmCompanyGrants)
      .where(
        and(
          // Both predicates are already implied by the grants_select policy.
          // They stay because a policy is a backstop for a query, not a
          // substitute for writing the query correctly.
          eq(schema.firmCompanyGrants.firmId, firmId),
          isNull(schema.firmCompanyGrants.revokedAt),
        ),
      ),
  );

  return [...new Set(rows.map((r) => r.companyId))];
}

/**
 * Builds the session for an authenticated staff user from their stored row.
 * This is the only place a Session is constructed from persisted state; every
 * other producer is a test fixture or an invite session.
 */
export async function sessionForStaffUser(
  user: {
    id: string;
    role: 'PLATFORM_ADMIN' | 'FIRM_ADMIN' | 'FIRM_STAFF' | 'COMPANY_ADMIN' | 'COMPANY_STAFF';
    firmId: string | null;
    companyId: string | null;
  },
  request: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<Session> {
  switch (user.role) {
    case 'PLATFORM_ADMIN': {
      const session: PlatformSession = {
        kind: 'platform',
        role: 'PLATFORM_ADMIN',
        userId: user.id,
        ...request,
      };
      return session;
    }
    case 'FIRM_ADMIN':
    case 'FIRM_STAFF': {
      if (!user.firmId) throw new Error(`Firm user ${user.id} has no firm_id.`);
      const session: FirmSession = {
        kind: 'firm',
        role: user.role,
        userId: user.id,
        firmId: user.firmId,
        companyIds: await resolveFirmScope(user.firmId, user.id, user.role),
        ...request,
      };
      return session;
    }
    case 'COMPANY_ADMIN':
    case 'COMPANY_STAFF': {
      if (!user.firmId || !user.companyId) {
        throw new Error(`Company user ${user.id} is missing firm_id or company_id.`);
      }
      const session: CompanySession = {
        kind: 'company',
        role: user.role,
        userId: user.id,
        firmId: user.firmId,
        companyId: user.companyId,
        ...request,
      };
      return session;
    }
  }
}
