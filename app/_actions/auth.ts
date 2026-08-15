'use server';

/**
 * Server actions for the staff login and setup flows.
 *
 * Actions return i18n keys, never sentences. The component translates. That is
 * not a style preference: an action runs on the server where the request locale
 * has been negotiated but the message catalogue for the rendering tree has not,
 * and a sentence chosen here is a sentence that ignores the language switcher
 * the user just used.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  completeTotp,
  completeSetup,
  login,
  revokeStaffSession,
} from '../../lib/auth/staff-auth';
import { getSessionToken, homePathFor, requestContext } from '../../lib/auth/current';
import { sessionForStaffUser } from '../../lib/auth/scope';
import { resolveStaffSession } from '../../lib/auth/staff-auth';
import { loginSchema, setupPasswordSchema, totpSchema } from '../../lib/validation/forms';

export interface ActionState {
  /** i18n key under `auth.errors.`, or undefined on success. */
  error?: string;
  /** Interpolation values for the message. */
  values?: Record<string, string>;
}

const IDLE: ActionState = {};

/**
 * Cookie attributes.
 *
 * `sameSite: 'lax'` rather than 'strict': strict drops the cookie on a
 * cross-site navigation, so a firm admin following a link from their email
 * client lands logged out and reads it as a broken product. Lax still blocks
 * the cross-site POST that CSRF needs.
 *
 * `__Host-` in production pins the cookie to the exact origin with no Domain
 * attribute, so a subdomain cannot set or read it. It requires Secure, which
 * rules it out over plain http in development.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function loginAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  // A malformed address is reported as a failed login rather than as a
  // validation error, so the form does not distinguish "not an address" from
  // "no such account".
  if (!parsed.success) return { error: 'auth.errors.invalid' };

  const context = await requestContext();
  const outcome = await login(parsed.data.email, parsed.data.password, context);

  switch (outcome.status) {
    case 'invalid':
      return { error: 'auth.errors.invalid' };
    case 'throttled':
      return { error: 'auth.errors.throttled' };
    case 'suspended':
      return { error: 'auth.errors.suspended' };
    case 'locked':
      return {
        error: 'auth.errors.locked',
        values: { minutes: String(Math.ceil((outcome.until.getTime() - Date.now()) / 60000)) },
      };
    case 'setup_required':
      // Deliberately the same message as an unknown account. Confirming that an
      // address exists but has not finished setup is an invitation to phish it.
      return { error: 'auth.errors.invalid' };
    case 'totp_required': {
      const store = await cookies();
      store.set(SESSION_COOKIE, outcome.token, cookieOptions(5 * 60));
      redirect('/login/verify');
    }
  }
}

export async function verifyTotpAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = totpSchema.safeParse({ code: formData.get('code') });
  if (!parsed.success) return { error: 'auth.errors.totpFormat' };

  const token = await getSessionToken();
  if (!token) redirect('/login');

  const context = await requestContext();
  const outcome = await completeTotp(token, parsed.data.code, context);

  if (outcome.status === 'expired') {
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return { error: 'auth.errors.sessionExpired' };
  }
  if (outcome.status === 'invalid') return { error: 'auth.errors.totpInvalid' };

  // Re-issue the cookie with the full session lifetime now that the second
  // factor is satisfied. The token itself does not change — the session row it
  // points at was promoted in place — so there is nothing to rotate.
  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(12 * 60 * 60));

  const user = await resolveStaffSession(token, context);
  if (!user) redirect('/login');
  redirect(homePathFor(await sessionForStaffUser(user, context)));
}

export async function logoutAction(): Promise<void> {
  const token = await getSessionToken();
  await revokeStaffSession(token);
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/login');
}

export async function completeSetupAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get('token') ?? '');
  const secret = String(formData.get('secret') ?? '');
  const code = String(formData.get('code') ?? '');

  const parsed = setupPasswordSchema.safeParse({
    password: formData.get('password'),
    passwordConfirm: formData.get('passwordConfirm'),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: first?.message ?? 'auth.errors.invalid' };
  }
  if (!token || !secret) return { error: 'auth.errors.setupInvalid' };

  const context = await requestContext();
  const outcome = await completeSetup(token, parsed.data.password, secret, code, context);

  if (outcome.status === 'invalid_token') return { error: 'auth.errors.setupInvalid' };
  if (outcome.status === 'bad_code') return { error: 'auth.errors.totpInvalid' };

  // Setup does not log the user in. They enrolled an authenticator seconds ago
  // and immediately using it proves the enrollment took, which is worth
  // discovering now rather than at 8am on their first real login.
  redirect('/login?setup=complete');
}

export const initialActionState = IDLE;
