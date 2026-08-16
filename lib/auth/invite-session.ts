/**
 * The invite session, as a request sees it.
 *
 * A worker never logs in — before submission or after (spec section 15). What
 * they have instead is a cookie holding the raw invite token, which is resolved
 * against the database on every request. There is no session state in the
 * cookie beyond the token, so a stale cookie cannot outlive the invite it names.
 *
 * The token is in a cookie rather than in the URL after the first hop, so that
 * every subsequent navigation, refresh, and back-button press stops carrying it
 * in a Referer header or a browser history entry someone else may read.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { INVITE_COOKIE, openInvite, subjectSessionFor, type InviteSummary } from '../invites';
import { requestContext } from './current';
import type { SubjectSession } from './session';

export interface CurrentSubject {
  session: SubjectSession;
  invite: InviteSummary;
}

export async function getInviteToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(INVITE_COOKIE)?.value;
}

/**
 * The cookie is SET in app/i/[token]/route.ts, not here.
 *
 * A server component may not write cookies, and the only place that needs to
 * write this one is the route handler that consumes the link — which is also
 * the only place that has the raw token. Everything downstream reads it.
 */
export async function clearInviteCookie(): Promise<void> {
  const store = await cookies();
  store.delete(INVITE_COOKIE);
}

/**
 * The current subject, if the cookie names a live, verified invite.
 *
 * Returns null for anything else — unknown, expired, consumed, locked, or not
 * past the date-of-birth gate. The caller decides whether that means "go to the
 * gate" or "this link is finished", because those are different screens.
 */
export async function getCurrentSubject(): Promise<CurrentSubject | null> {
  const token = await getInviteToken();
  if (!token) return null;

  const context = await requestContext();
  const state = await openInvite(token, context);
  if (state.status !== 'verified') return null;

  return {
    session: subjectSessionFor(state.invite, context),
    invite: state.invite,
  };
}

/** For pages that only make sense past the gate. */
export async function requireSubject(): Promise<CurrentSubject> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');
  return current;
}
