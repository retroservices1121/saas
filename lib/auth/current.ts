/**
 * The bridge between a request and a Session.
 *
 * Server components and server actions call `requireFirm()`, `requireCompany()`
 * or `requireStaff()` and get back a Session whose scope was derived
 * server-side from live grants. Nothing here accepts a company id, a firm id,
 * or a role from the request — the whole point of layer 1 is that the scope is
 * not something the client can influence.
 *
 * The `require*` helpers throw rather than returning null. A handler that
 * forgets to check a null is a handler that runs unauthenticated; a handler
 * that forgets to catch an exception returns a 500, which is wrong but not
 * dangerous.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  resolveStaffSession,
  type RequestContext,
  type ResolvedStaffUser,
} from './staff-auth';
import { sessionForStaffUser } from './scope';
import type { CompanySession, FirmSession, PlatformSession, Session } from './session';

/**
 * Client address and user agent, for the audit trail.
 *
 * `x-forwarded-for` is only meaningful behind a proxy that sets it, and is
 * attacker-controlled without one. Railway terminates TLS and sets it, so the
 * leftmost entry is the real client; behind anything else this needs revisiting
 * rather than trusting.
 */
export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || h.get('x-real-ip') || undefined;
  return { ip, userAgent: h.get('user-agent') ?? undefined };
}

export async function getSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

export interface CurrentStaff {
  user: ResolvedStaffUser;
  session: Session;
}

/** Null when there is no live, TOTP-verified session. */
export async function getCurrentStaff(): Promise<CurrentStaff | null> {
  const token = await getSessionToken();
  if (!token) return null;

  const context = await requestContext();
  const user = await resolveStaffSession(token, context);
  if (!user) return null;

  const session = await sessionForStaffUser(user, context);
  return { user, session };
}

export class UnauthorizedError extends Error {
  constructor(message = 'Not authenticated.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Not permitted for this role.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export async function requireStaff(): Promise<CurrentStaff> {
  const current = await getCurrentStaff();
  if (!current) redirect('/login');
  return current;
}

export async function requireFirm(): Promise<CurrentStaff & { session: FirmSession }> {
  const current = await requireStaff();
  if (current.session.kind !== 'firm') redirect('/');
  return { ...current, session: current.session };
}

/**
 * Export is FIRM_ADMIN only (spec section 7.7), and so is firm staff
 * management. Enforced here as well as in the RLS policy on `exports`.
 */
export async function requireFirmAdmin(): Promise<CurrentStaff & { session: FirmSession }> {
  const current = await requireFirm();
  if (current.session.role !== 'FIRM_ADMIN') throw new ForbiddenError();
  return current;
}

export async function requireCompany(): Promise<CurrentStaff & { session: CompanySession }> {
  const current = await requireStaff();
  if (current.session.kind !== 'company') redirect('/');
  return { ...current, session: current.session };
}

export async function requireCompanyAdmin(): Promise<
  CurrentStaff & { session: CompanySession }
> {
  const current = await requireCompany();
  if (current.session.role !== 'COMPANY_ADMIN') throw new ForbiddenError();
  return current;
}

export async function requirePlatform(): Promise<CurrentStaff & { session: PlatformSession }> {
  const current = await requireStaff();
  if (current.session.kind !== 'platform') redirect('/');
  return { ...current, session: current.session };
}

/** Where a staff member lands after login, by role. */
export function homePathFor(session: Session): string {
  switch (session.kind) {
    case 'firm':
      return '/firm';
    case 'company':
      return '/company';
    case 'platform':
      return '/platform';
    default:
      return '/';
  }
}
