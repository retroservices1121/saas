import {
  pgTable,
  text,
  uuid,
  date,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  inet,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidV7Pk, timestamps, bytea } from './_shared';
import {
  bankAccountType,
  localeEnum,
  payFrequency,
  payType,
  submittedVia,
  tinType,
  workerStatus,
  workerType,
} from './enums';
import { companies } from './companies';

/**
 * Company-entered worker data. Freely readable and editable by the company.
 * Contains no personal identifiers beyond a display name and a mobile number
 * the company already had in order to send the invite.
 *
 * Splitting this table from worker_records is what makes the access rule
 * enforceable rather than aspirational (spec section 4).
 */
export const workers = pgTable(
  'workers',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    workerType: workerType('worker_type').notNull(),
    displayName: text('display_name').notNull(),

    /**
     * Where the invite link is sent. Supplied by the company, which is the
     * whole point and also the risk: an address on the company's own domain is
     * a mailbox the company controls, so the link would arrive in the hands of
     * the party this system exists to exclude. `assertInvitableEmail` refuses
     * that case.
     *
     * Nullable at the database level only because this column was added to a
     * table that already had rows. Every path that creates a worker requires
     * it, and `deliverInvite` fails loudly rather than silently skipping a send.
     */
    inviteEmail: text('invite_email'),

    /**
     * Optional since invites moved to email. Retained because a firm chasing an
     * unresponsive worker has nothing else to call, and because the worker's own
     * number on `worker_records` is not visible to the company.
     */
    phoneE164: text('phone_e164'),
    preferredLocale: localeEnum('preferred_locale').notNull().default('en'),
    status: workerStatus('status').notNull().default('INVITED'),

    // --- payroll fields, entered by the COMPANY, not the worker ---
    jobTitle: text('job_title'),
    startDate: date('start_date'),
    payType: payType('pay_type'),
    payFrequency: payFrequency('pay_frequency'),
    workState: text('work_state'),
    // Pay rate is deliberately absent. See spec section 15 — adding it converts
    // this into a compensation system with a different disclosure profile.

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    legalHold: boolean('legal_hold').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    index('workers_company_idx').on(t.companyId),
    index('workers_status_idx').on(t.companyId, t.status),
  ],
);

/**
 * Worker-supplied personal and banking data. Append-only: corrections write a
 * new version and preserve the old one (spec section 7.8), because a worker
 * cannot log back in to fix anything themselves.
 *
 * The app_company role has NO privileges on this table whatsoever — not
 * column-limited SELECT, none. A company session that reaches it gets a
 * Postgres permission error, which the DAL converts into a not-found plus a
 * SECURITY_VIOLATION audit row.
 */
export const workerRecords = pgTable(
  'worker_records',
  {
    id: uuidV7Pk(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'restrict' }),
    // Denormalized so the RLS policy can filter without a join.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    version: integer('version').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),

    legalFirstName: text('legal_first_name').notNull(),
    legalMiddleName: text('legal_middle_name'),
    legalLastName: text('legal_last_name').notNull(),
    dateOfBirth: date('date_of_birth').notNull(),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    email: text('email'),
    phoneE164: text('phone_e164'),

    tinType: tinType('tin_type').notNull(),
    // Nullable ONLY because of the retention purge (spec section 13), which
    // nulls every `_enc` and `_last4` column while keeping the row skeleton and
    // the audit trail that points at it. A live record must still carry a tax
    // ID, and `worker_records_purge_ck` in migration 905 enforces exactly that:
    // tin_enc may be null if and only if purged_at is set.
    tinEnc: bytea('tin_enc'),
    tinLast4: text('tin_last4'),

    bankName: text('bank_name'),
    bankAccountType: bankAccountType('bank_account_type'),
    routingEnc: bytea('routing_enc'),
    routingLast4: text('routing_last4'),
    accountEnc: bytea('account_enc'),
    accountLast4: text('account_last4'),

    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    emergencyContactRelationship: text('emergency_contact_relationship'),

    submittedVia: submittedVia('submitted_via').notNull(),
    submittedIp: inet('submitted_ip'),
    submittedUserAgent: text('submitted_user_agent'),

    /** Set by the retention job. The row stays; its sensitive columns do not. */
    purgedAt: timestamp('purged_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    index('worker_records_worker_idx').on(t.workerId),
    index('worker_records_company_idx').on(t.companyId),
    uniqueIndex('worker_records_current_uq').on(t.workerId).where(sql`is_current`),
    uniqueIndex('worker_records_version_uq').on(t.workerId, t.version),
  ],
);
