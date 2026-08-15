import {
  pgTable,
  text,
  uuid,
  jsonb,
  timestamp,
  inet,
  index,
  boolean,
  integer,
} from 'drizzle-orm/pg-core';
import { uuidV7Pk, createdAt } from './_shared';
import { auditAction, subjectType } from './enums';

/**
 * Append-only. UPDATE and DELETE are revoked from every application role in
 * migration 0001 — including the firm roles and app_user itself — so a
 * compromised application credential cannot rewrite history. Only the owning
 * migration role can touch it, and it never does outside of DDL.
 *
 * Note there is no updated_at: a row that can never change does not have one.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuidV7Pk(),
    firmId: uuid('firm_id'),
    companyId: uuid('company_id'),

    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role').notNull(),

    action: auditAction('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),

    // Required on every reveal and every export (spec sections 7.6, 7.7).
    reason: text('reason'),

    ip: inet('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata'),

    createdAt: createdAt(),
  },
  (t) => [
    index('audit_company_idx').on(t.companyId, t.createdAt),
    index('audit_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_action_idx').on(t.action, t.createdAt),
  ],
);

// Named `dataExports` rather than `exports`: a module-scope binding called
// `exports` collides with the CommonJS object of the same name whenever this
// file is transpiled to CJS, which drizzle-kit does. The table is still
// `exports` in the database.
export const dataExports = pgTable(
  'exports',
  {
    id: uuidV7Pk(),
    firmId: uuid('firm_id').notNull(),
    companyId: uuid('company_id'),
    requestedBy: uuid('requested_by').notNull(),
    reason: text('reason').notNull(),

    scope: jsonb('scope'),
    includeSensitive: boolean('include_sensitive').notNull().default(false),

    s3Key: text('s3_key'),
    // Hard-deletes at 24 hours regardless of legal hold (spec section 13).
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [index('exports_firm_idx').on(t.firmId), index('exports_expiry_idx').on(t.expiresAt)],
);

/**
 * Invite engine (spec section 7). The raw token never touches the database —
 * only a sha256 of it, so a database dump does not yield working invite links.
 *
 * Single-use: `consumed_at` is set on submission. Time-limited: `expires_at`.
 * Second factor: the DOB gate, with five failures locking for 60 minutes and
 * alerting the firm, not the company.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id').notNull(),
    subjectType: subjectType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    tokenHash: text('token_hash').notNull().unique(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    /**
     * The date-of-birth gate, stored as an argon2id hash rather than as a date.
     *
     * The gate exists to keep the company admin out of a link they may have
     * intercepted, so the expected value is the last thing that may be readable
     * by a company session. Two mechanisms keep it from them: this column is
     * not in the column-level SELECT grant app_company holds on this table
     * (migration 902), and even given the value it is a slow hash rather than a
     * date — a date of birth has only around thirty thousand plausible values,
     * so a fast hash would be a lookup table, not a secret.
     */
    expectedDobHash: text('expected_dob_hash'),

    // Second-factor gate state.
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),

    // Resumable draft state for the one-question-per-screen flow. Sensitive
    // answers are encrypted before they land here, exactly as they would be in
    // their final column — a partially completed form is no less sensitive.
    draft: jsonb('draft'),
    draftStep: text('draft_step'),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invites_subject_idx').on(t.subjectType, t.subjectId),
    index('invites_company_idx').on(t.companyId),
  ],
);
