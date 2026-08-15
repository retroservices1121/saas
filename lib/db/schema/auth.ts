import {
  pgTable,
  text,
  uuid,
  timestamp,
  inet,
  index,
  boolean,
} from 'drizzle-orm/pg-core';
import { uuidV7Pk, createdAt, bytea } from './_shared';

/**
 * Staff sessions.
 *
 * Server-side rather than a self-contained signed token, because the two things
 * this system most needs to be able to do are revoke a session immediately and
 * know which sessions exist. A stateless JWT can do neither: a firm admin
 * dismissed at 09:00 keeps a working token until it expires, and the audit
 * question "who had access on the day of the incident" has no answer.
 *
 * The cookie carries a random 32-byte token. Only its sha256 lands here, so a
 * database dump does not yield working sessions — the same reasoning as the
 * invite tokens.
 */
export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: uuidV7Pk(),
    userId: uuid('user_id').notNull(),

    tokenHash: text('token_hash').notNull().unique(),

    /**
     * Null until the second factor is satisfied. A row in this state can do
     * exactly one thing: accept a TOTP code. It is not a session yet, and
     * lib/auth/current.ts refuses to build an application Session from it.
     */
    totpVerifiedAt: timestamp('totp_verified_at', { withTimezone: true }),

    /** Slides forward on activity, up to absoluteExpiresAt. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Hard ceiling. Never extended, so no session outlives one working day. */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Most recent successful step-up. Recorded for the audit trail. */
    lastReauthAt: timestamp('last_reauth_at', { withTimezone: true }),

    ip: inet('ip'),
    userAgent: text('user_agent'),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('staff_sessions_user_idx').on(t.userId),
    index('staff_sessions_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Single-use links for password creation and TOTP enrollment (spec section
 * 7.1: "Emails a setup link, 24h TTL, password creation plus mandatory TOTP").
 *
 * Same token discipline as invites: the raw value is emailed and never stored.
 */
export const userSetupTokens = pgTable(
  'user_setup_tokens',
  {
    id: uuidV7Pk(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [index('user_setup_tokens_user_idx').on(t.userId)],
);

/**
 * Envelope keys for data that is not company-scoped.
 *
 * A TOTP secret belongs to a user, not to a company, so it cannot be wrapped
 * with a company DEK — a firm admin has no company, and destroying a company's
 * DEK on deletion would lock its own staff out of their authenticator.
 *
 * One row per purpose, wrapped by the same KMS master key as every company DEK,
 * so key management stays in one place rather than sprouting a second scheme
 * rooted in AUTH_SECRET.
 */
export const platformKeys = pgTable('platform_keys', {
  purpose: text('purpose').primaryKey(),
  dekCiphertext: bytea('dek_ciphertext').notNull(),
  dekKeyId: text('dek_key_id').notNull(),
  createdAt: createdAt(),
});

/**
 * Login throttling that survives a process restart and is shared across
 * instances. Counting failures in memory means a second container resets the
 * count to zero, which is not throttling.
 *
 * Keyed on the identifier attempted rather than on a user id, so failures
 * against an address that does not exist are counted too — otherwise the
 * throttle itself tells an attacker which addresses are real.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuidV7Pk(),
    identifier: text('identifier').notNull(),
    ip: inet('ip'),
    succeeded: boolean('succeeded').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('login_attempts_identifier_idx').on(t.identifier, t.createdAt)],
);
