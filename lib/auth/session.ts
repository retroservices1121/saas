/**
 * Session shapes. The scope carried here is derived server-side at session
 * start and is never accepted from the client — spec section 5, layer 1.
 */

export type StaffRole =
  | 'PLATFORM_ADMIN'
  | 'FIRM_ADMIN'
  | 'FIRM_STAFF'
  | 'COMPANY_ADMIN'
  | 'COMPANY_STAFF';

export type SubjectRole = 'OWNER' | 'WORKER';

/**
 * Nobody, yet. The login and invite-lookup paths need to read a row in order to
 * decide who the caller is, which is a question that cannot be answered by a
 * session that already knows.
 */
export type AnonymousRole = 'ANONYMOUS';

export type ActorRole = StaffRole | SubjectRole | AnonymousRole;

/** Maps an actor role onto the Postgres role the transaction runs as. */
export type DbRole =
  | 'app_platform'
  | 'app_firm'
  | 'app_company'
  | 'app_subject'
  | 'app_auth';

interface BaseSession {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface PlatformSession extends BaseSession {
  kind: 'platform';
  role: 'PLATFORM_ADMIN';
  userId: string;
}

export interface FirmSession extends BaseSession {
  kind: 'firm';
  role: 'FIRM_ADMIN' | 'FIRM_STAFF';
  userId: string;
  firmId: string;
  /**
   * Company ids with a live grant, resolved from firm_company_grants at session
   * start. A revoked grant means the id is simply absent, which is why a
   * revoked-grant read returns not-found rather than forbidden.
   */
  companyIds: string[];
}

export interface CompanySession extends BaseSession {
  kind: 'company';
  role: 'COMPANY_ADMIN' | 'COMPANY_STAFF';
  userId: string;
  firmId: string;
  companyId: string;
}

/**
 * A worker or owner inside a live invite session. No login, no user row, single
 * company, single subject. This is the only non-firm session that may decrypt,
 * and only its own data.
 */
export interface SubjectSession extends BaseSession {
  kind: 'subject';
  role: SubjectRole;
  subjectId: string;
  companyId: string;
  inviteId: string;
}

/**
 * The pre-authentication scope. It exists so that even the login lookup runs
 * through withScope rather than around it — an unscoped escape hatch for "just
 * this one query" is how layer 2 stops being a boundary.
 *
 * `app_auth` holds nothing but what a login needs: the users table, the session
 * and setup-token tables, and INSERT on the audit log. It cannot name a company,
 * a worker, or an owner at all.
 */
export interface AnonymousSession extends BaseSession {
  kind: 'anonymous';
  role: 'ANONYMOUS';
}

export type Session =
  | PlatformSession
  | FirmSession
  | CompanySession
  | SubjectSession
  | AnonymousSession;

export function anonymousSession(
  request: { ip?: string | undefined; userAgent?: string | undefined } = {},
): AnonymousSession {
  return { kind: 'anonymous', role: 'ANONYMOUS', ...request };
}

export function isFirmSession(s: Session): s is FirmSession {
  return s.kind === 'firm';
}

export function isCompanySession(s: Session): s is CompanySession {
  return s.kind === 'company';
}

export function isSubjectSession(s: Session): s is SubjectSession {
  return s.kind === 'subject';
}

/** The company ids this session may touch. Empty means it may touch nothing. */
export function scopeOf(session: Session): string[] {
  switch (session.kind) {
    case 'platform':
      // PLATFORM_ADMIN has no company scope at all. It reads audit metadata and
      // manages firms; it never reads company data, sensitive or otherwise.
      return [];
    case 'firm':
      return session.companyIds;
    case 'company':
      return [session.companyId];
    case 'subject':
      return [session.companyId];
    case 'anonymous':
      return [];
  }
}

export function dbRoleOf(session: Session): DbRole {
  switch (session.kind) {
    case 'platform':
      return 'app_platform';
    case 'firm':
      return 'app_firm';
    case 'company':
      return 'app_company';
    case 'subject':
      return 'app_subject';
    case 'anonymous':
      return 'app_auth';
  }
}

export function actorUserIdOf(session: Session): string | null {
  return session.kind === 'subject' || session.kind === 'anonymous' ? null : session.userId;
}

export function firmIdOf(session: Session): string | null {
  switch (session.kind) {
    case 'firm':
    case 'company':
      return session.firmId;
    default:
      return null;
  }
}
