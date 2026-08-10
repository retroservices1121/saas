import { pgTable, text, uuid, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { uuidV7Pk, timestamps, bytea } from './_shared';
import { accountStatus, userRole, userStatus } from './enums';

export const firms = pgTable('firms', {
  id: uuidV7Pk(),
  name: text('name').notNull(),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  status: accountStatus('status').notNull().default('active'),
  ...timestamps,
});

/**
 * Staff logins. A user belongs to exactly one firm (firm roles) or one company
 * (company roles); PLATFORM_ADMIN belongs to neither. The check constraint that
 * enforces that pairing lives in migration 0001 — Drizzle cannot express it.
 */
export const users = pgTable(
  'users',
  {
    id: uuidV7Pk(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),

    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id'),

    passwordHash: text('password_hash'),

    // TOTP is mandatory for every firm role (spec section 3). The shared secret
    // is itself sensitive: it is encrypted with the platform DEK, never the
    // company DEK, because a user is not company-scoped data.
    totpSecretEnc: bytea('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),

    status: userStatus('status').notNull().default('pending'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('users_firm_idx').on(t.firmId), index('users_company_idx').on(t.companyId)],
);
