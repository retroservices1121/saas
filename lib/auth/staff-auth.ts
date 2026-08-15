/**
 * Staff authentication (spec build order step 4).
 *
 * Password, then TOTP, then a server-side session. Every step runs through
 * `withScope` under the ANONYMOUS scope, which is the app_auth Postgres role:
 * it can see users, sessions, setup tokens and the platform key, and cannot
 * name a company, a worker, an owner, a document, or a note. Even if every line
 * below were wrong, this file could not read a tax ID.
 *
 * Two properties are worth stating outright because they are easy to lose in a
 * refactor:
 *
 *   A password check never tells the caller whether the address exists. Every
 *   failure path burns an argon2id derivation and returns the same shape.
 *
 *   TOTP is not optional and the check is not in the UI. The `users_totp_ck`
 *   constraint refuses to let a firm user reach `active` without an enrolled
 *   authenticator, and `resolveStaffSession` refuses to return a user for any
 *   session row whose `totp_verified_at` is null — so a password alone resolves
 *   to nothing at all, whatever the calling page believes.
 */
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { schema, withScope, type ScopedDb } from '../db/scoped';
import { anonymousSession, type AnonymousSession, type StaffRole } from './session';
import { audit } from '../audit';
import { hashPassword, verifyPassword } from '../security/password';
import { decryptPlatformField, encryptPlatformField } from '../security/platform-encryption';
import { generateTotpSecret, verifyTotp } from './totp';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Idle timeout. The session slides forward on each request up to the ceiling. */
const IDLE_MS = 30 * 60 * 1000;

/**
 * Absolute ceiling, never extended. Twelve hours covers a working day without
 * covering the night, so a session left open on an unlocked laptop expires
 * before the building does.
 */
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/** A password-verified session awaiting its second factor. */
const TOTP_PENDING_MS = 5 * 60 * 1000;

/** Setup links: 24h TTL (spec section 7.1). */
const SETUP_TOKEN_MS = 24 * 60 * 60 * 1000;

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX = 20;

const TOKEN_BYTES = 32;

export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-onb_session' : 'onb_session';

export interface RequestContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** Tokens are compared by hash; the raw value exists only in the cookie or the email. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type LoginOutcome =
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  | { status: 'throttled' }
  /** Password is correct but the account has never been set up. */
  | { status: 'setup_required' }
  | { status: 'suspended' }
  /** Password accepted. The returned token identifies a session that can do nothing but accept a code. */
  | { status: 'totp_required'; token: string };

export async function login(
  email: string,
  password: string,
  request: RequestContext = {},
): Promise<LoginOutcome> {
  const session = anonymousSession(request);
  const identifier = email.trim().toLowerCase();

  return withScope(session, async (db) => {
    // --- throttle, before touching the user row ---------------------------
    const since = new Date(Date.now() - THROTTLE_WINDOW_MS);
    const [{ failures = 0 } = { failures: 0 }] = await db
      .select({ failures: sql<number>`count(*)::int` })
      .from(schema.loginAttempts)
      .where(
        and(
          eq(schema.loginAttempts.identifier, identifier),
          eq(schema.loginAttempts.succeeded, false),
          gt(schema.loginAttempts.createdAt, since),
        ),
      );

    if (failures >= THROTTLE_MAX) {
      await audit(db, session, {
        action: 'LOGIN_FAILURE',
        metadata: { reason: 'throttled', identifier },
      });
      return { status: 'throttled' } as const;
    }

    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        role: schema.users.role,
        firmId: schema.users.firmId,
        companyId: schema.users.companyId,
        passwordHash: schema.users.passwordHash,
        status: schema.users.status,
        lockedUntil: schema.users.lockedUntil,
        failedLoginCount: schema.users.failedLoginCount,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.users)
      .where(eq(schema.users.email, identifier))
      .limit(1);

    const user = rows[0];

    // The verification runs whether or not the user exists, against a hash that
    // cannot match. Returning early here is what turns a login form into an
    // address-enumeration oracle measurable over the network.
    const check = verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !check.valid) {
      await db.insert(schema.loginAttempts).values({
        identifier,
        ip: request.ip ?? null,
        succeeded: false,
      });
      await audit(db, session, {
        action: 'LOGIN_FAILURE',
        actorUserId: user?.id ?? null,
        targetType: 'users',
        targetId: user?.id ?? null,
        metadata: { identifier, reason: user ? 'bad_password' : 'unknown_identifier' },
      });

      if (user) {
        const failed = user.failedLoginCount + 1;
        await db
          .update(schema.users)
          .set({
            failedLoginCount: failed,
            lockedUntil: failed >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MS) : null,
          })
          .where(eq(schema.users.id, user.id));
      }

      return { status: 'invalid' } as const;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await audit(db, session, {
        action: 'LOGIN_FAILURE',
        actorUserId: user.id,
        metadata: { identifier, reason: 'locked' },
      });
      return { status: 'locked', until: user.lockedUntil } as const;
    }

    if (user.status === 'suspended') {
      await audit(db, session, {
        action: 'LOGIN_FAILURE',
        actorUserId: user.id,
        metadata: { identifier, reason: 'suspended' },
      });
      return { status: 'suspended' } as const;
    }

    if (user.status === 'pending' || !user.totpEnabledAt) {
      // Correct password, incomplete account. The setup link is not re-sent
      // from here: an unauthenticated request must not be able to cause mail to
      // be sent to an address it has guessed.
      return { status: 'setup_required' } as const;
    }

    // --- password accepted ------------------------------------------------
    if (check.needsRehash) {
      await db
        .update(schema.users)
        .set({ passwordHash: hashPassword(password) })
        .where(eq(schema.users.id, user.id));
    }

    await db.insert(schema.loginAttempts).values({
      identifier,
      ip: request.ip ?? null,
      succeeded: true,
    });
    await db
      .update(schema.users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(schema.users.id, user.id));

    const token = newToken();
    const now = Date.now();
    await db.insert(schema.staffSessions).values({
      userId: user.id,
      tokenHash: hashToken(token),
      // Not a session yet. totpVerifiedAt stays null and both expiries are
      // short, so an abandoned half-login is not a five-minute foothold.
      expiresAt: new Date(now + TOTP_PENDING_MS),
      absoluteExpiresAt: new Date(now + TOTP_PENDING_MS),
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
    });

    return { status: 'totp_required', token } as const;
  });
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

export type TotpOutcome =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' }
  | { status: 'expired' };

/**
 * Consumes the pending session and promotes it to a real one.
 *
 * The accepted time step is written back to `users.totp_last_counter` in the
 * same transaction, so the code cannot be spent twice — including by a request
 * racing this one, because the update is inside the transaction that promotes
 * the session.
 */
export async function completeTotp(
  token: string,
  code: string,
  request: RequestContext = {},
): Promise<TotpOutcome> {
  const session = anonymousSession(request);

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        sessionId: schema.staffSessions.id,
        userId: schema.staffSessions.userId,
        expiresAt: schema.staffSessions.expiresAt,
        totpVerifiedAt: schema.staffSessions.totpVerifiedAt,
        revokedAt: schema.staffSessions.revokedAt,
        secretEnc: schema.users.totpSecretEnc,
        lastCounter: schema.users.totpLastCounter,
        role: schema.users.role,
        firmId: schema.users.firmId,
      })
      .from(schema.staffSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.staffSessions.userId))
      .where(eq(schema.staffSessions.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    if (!row || row.revokedAt || row.totpVerifiedAt || row.expiresAt <= new Date()) {
      return { status: 'expired' } as const;
    }
    if (!row.secretEnc) return { status: 'invalid' } as const;

    const secret = await decryptPlatformField('totp', row.secretEnc);
    const result = verifyTotp(secret, code, row.lastCounter);

    if (!result.valid) {
      await audit(db, session, {
        action: 'LOGIN_FAILURE',
        actorUserId: row.userId,
        actorRole: row.role,
        firmId: row.firmId,
        metadata: { reason: 'bad_totp' },
      });
      return { status: 'invalid' } as const;
    }

    await db
      .update(schema.users)
      .set({ totpLastCounter: result.counter!, lastLoginAt: new Date() })
      .where(eq(schema.users.id, row.userId));

    const now = Date.now();
    await db
      .update(schema.staffSessions)
      .set({
        totpVerifiedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(now + IDLE_MS),
        absoluteExpiresAt: new Date(now + ABSOLUTE_MS),
      })
      .where(eq(schema.staffSessions.id, row.sessionId));

    await audit(db, session, {
      action: 'LOGIN_SUCCESS',
      actorUserId: row.userId,
      actorRole: row.role,
      firmId: row.firmId,
      targetType: 'users',
      targetId: row.userId,
    });

    return { status: 'ok', userId: row.userId } as const;
  });
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

export interface ResolvedStaffUser {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  role: StaffRole;
  firmId: string | null;
  companyId: string | null;
}

/**
 * Resolves a cookie token to a fully authenticated user, sliding the idle
 * window forward. Returns null for anything that is not a live, TOTP-verified
 * session — expired, revoked, half-completed, or unknown all look the same to
 * the caller, because to the caller they are the same.
 */
export async function resolveStaffSession(
  token: string | undefined,
  request: RequestContext = {},
): Promise<ResolvedStaffUser | null> {
  if (!token) return null;
  const session = anonymousSession(request);

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        sessionId: schema.staffSessions.id,
        userId: schema.staffSessions.userId,
        totpVerifiedAt: schema.staffSessions.totpVerifiedAt,
        expiresAt: schema.staffSessions.expiresAt,
        absoluteExpiresAt: schema.staffSessions.absoluteExpiresAt,
        revokedAt: schema.staffSessions.revokedAt,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        firmId: schema.users.firmId,
        companyId: schema.users.companyId,
        status: schema.users.status,
      })
      .from(schema.staffSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.staffSessions.userId))
      .where(eq(schema.staffSessions.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    const now = new Date();

    if (
      !row ||
      row.revokedAt ||
      !row.totpVerifiedAt ||
      row.expiresAt <= now ||
      row.absoluteExpiresAt <= now ||
      row.status !== 'active'
    ) {
      return null;
    }

    // Slide the idle window, never past the ceiling.
    const slid = new Date(Math.min(now.getTime() + IDLE_MS, row.absoluteExpiresAt.getTime()));
    await db
      .update(schema.staffSessions)
      .set({ lastSeenAt: now, expiresAt: slid })
      .where(eq(schema.staffSessions.id, row.sessionId));

    return {
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
      firmId: row.firmId,
      companyId: row.companyId,
    };
  });
}

export async function revokeStaffSession(token: string | undefined): Promise<void> {
  if (!token) return;
  const session = anonymousSession();
  await withScope(session, async (db) => {
    await db
      .update(schema.staffSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.staffSessions.tokenHash, hashToken(token)),
          isNull(schema.staffSessions.revokedAt),
        ),
      );
  });
}

/** Every other session for this user. Used after a password change. */
export async function revokeOtherSessions(userId: string, keepSessionId?: string): Promise<void> {
  const session = anonymousSession();
  await withScope(session, async (db) => {
    await db
      .update(schema.staffSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.staffSessions.userId, userId),
          isNull(schema.staffSessions.revokedAt),
          keepSessionId ? sql`id <> ${keepSessionId}` : sql`true`,
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Step-up re-authentication (spec section 7.6)
// ---------------------------------------------------------------------------

/**
 * Verifies a fresh TOTP code for an already-authenticated user, and spends it.
 *
 * Runs under the ANONYMOUS scope even though the caller holds a firm session,
 * so that `platform_keys` — which holds the wrapper for every TOTP secret in
 * the system — remains reachable by exactly one Postgres role. A firm session
 * that could read that table would be one bug away from being able to mint
 * codes for every other user.
 *
 * Because the accepted counter is spent, two reveals inside the same 30-second
 * window need two different codes. That is the intended behaviour of a one-time
 * password and the cost is bounded by the 30-second step, but it is real
 * friction and it belongs in the conversation the spec opens in section 16,
 * item 4.
 */
export async function verifyStepUp(
  userId: string,
  code: string,
  sessionId?: string,
): Promise<boolean> {
  const session = anonymousSession();

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        secretEnc: schema.users.totpSecretEnc,
        lastCounter: schema.users.totpLastCounter,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const row = rows[0];
    if (!row?.secretEnc) return false;

    const secret = await decryptPlatformField('totp', row.secretEnc);
    const result = verifyTotp(secret, code, row.lastCounter);
    if (!result.valid) return false;

    await db
      .update(schema.users)
      .set({ totpLastCounter: result.counter! })
      .where(eq(schema.users.id, userId));

    if (sessionId) {
      await db
        .update(schema.staffSessions)
        .set({ lastReauthAt: new Date() })
        .where(eq(schema.staffSessions.id, sessionId));
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Account setup
// ---------------------------------------------------------------------------

/**
 * Issues a setup link. Called inside the transaction that creates the user, so
 * a user can never exist without one — or with one that outlived a rolled-back
 * creation.
 */
export async function issueSetupToken(db: ScopedDb, userId: string): Promise<string> {
  const token = newToken();
  await db.insert(schema.userSetupTokens).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SETUP_TOKEN_MS),
  });
  return token;
}

export interface SetupTarget {
  userId: string;
  email: string;
  name: string;
  role: StaffRole;
  /** Already enrolled: the link is being reused after completion. */
  alreadyComplete: boolean;
}

export async function inspectSetupToken(token: string): Promise<SetupTarget | null> {
  const session = anonymousSession();

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        userId: schema.userSetupTokens.userId,
        expiresAt: schema.userSetupTokens.expiresAt,
        consumedAt: schema.userSetupTokens.consumedAt,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        status: schema.users.status,
        totpEnabledAt: schema.users.totpEnabledAt,
      })
      .from(schema.userSetupTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSetupTokens.userId))
      .where(eq(schema.userSetupTokens.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    if (!row || row.consumedAt || row.expiresAt <= new Date()) return null;

    return {
      userId: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
      alreadyComplete: row.status === 'active' && row.totpEnabledAt !== null,
    };
  });
}

export interface EnrollmentDraft {
  secret: string;
}

/**
 * Generates the authenticator secret for an enrollment in progress.
 *
 * Deliberately not persisted yet: a secret written before the user proves they
 * can produce a code from it leaves accounts holding an authenticator nobody
 * scanned. It is held in the setup form and committed by `completeSetup`, which
 * only accepts it alongside a working code.
 */
export function beginEnrollment(): EnrollmentDraft {
  return { secret: generateTotpSecret() };
}

export type SetupOutcome =
  | { status: 'ok'; userId: string }
  | { status: 'invalid_token' }
  | { status: 'bad_code' };

/**
 * Sets the password, stores the encrypted TOTP secret, activates the user, and
 * consumes the token — all in one transaction. A half-applied setup is an
 * account that cannot log in and cannot be set up again.
 */
export async function completeSetup(
  token: string,
  password: string,
  secretBase32: string,
  code: string,
  request: RequestContext = {},
): Promise<SetupOutcome> {
  const session = anonymousSession(request);

  // Verified before opening the transaction: the check is pure, and a wrong
  // code is the common case.
  const verification = verifyTotp(secretBase32, code, null);
  if (!verification.valid) return { status: 'bad_code' };

  const secretEnc = await encryptPlatformField('totp', secretBase32);

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.userSetupTokens.id,
        userId: schema.userSetupTokens.userId,
        expiresAt: schema.userSetupTokens.expiresAt,
        consumedAt: schema.userSetupTokens.consumedAt,
        role: schema.users.role,
        firmId: schema.users.firmId,
      })
      .from(schema.userSetupTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSetupTokens.userId))
      .where(eq(schema.userSetupTokens.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    if (!row || row.consumedAt || row.expiresAt <= new Date()) {
      return { status: 'invalid_token' } as const;
    }

    await db
      .update(schema.users)
      .set({
        passwordHash: hashPassword(password),
        totpSecretEnc: secretEnc,
        totpEnabledAt: new Date(),
        totpLastCounter: verification.counter!,
        status: 'active',
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(schema.users.id, row.userId));

    await db
      .update(schema.userSetupTokens)
      .set({ consumedAt: new Date() })
      .where(eq(schema.userSetupTokens.id, row.id));

    await audit(db, session, {
      action: 'LOGIN_SUCCESS',
      actorUserId: row.userId,
      actorRole: row.role,
      firmId: row.firmId,
      targetType: 'users',
      targetId: row.userId,
      metadata: { via: 'setup_link', totpEnrolled: true },
    });

    return { status: 'ok', userId: row.userId } as const;
  });
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Sweeps throttle rows that have aged out of the counting window.
 *
 * `staff_sessions` is deliberately not swept here. Expired and revoked rows are
 * retained, because "who held a session on the day of the incident" is a
 * question the audit log alone cannot answer — an expiry is not an event, so
 * nothing is written when one happens. Their eventual deletion is a retention
 * decision and lives with the other retention jobs.
 */
export async function pruneLoginAttempts(): Promise<number> {
  const session: AnonymousSession = anonymousSession();

  return withScope(session, async (db) => {
    const removed = await db
      .delete(schema.loginAttempts)
      .where(lt(schema.loginAttempts.createdAt, new Date(Date.now() - THROTTLE_WINDOW_MS)))
      .returning({ id: schema.loginAttempts.id });
    return removed.length;
  });
}
