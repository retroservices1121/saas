import { pgTable, text, uuid, date, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { uuidV7Pk, timestamps, bytea } from './_shared';
import { localeEnum, ownerStatus, tinType } from './enums';
import { companies } from './companies';

/**
 * Owner tax IDs are needed for K-1 issuance, and rule 5 of the security
 * properties applies to owners exactly as it applies to workers: every person
 * who supplies a tax ID supplies it themselves, through their own single-use
 * link. A company admin can create the row and nothing more.
 *
 * The columns split cleanly in two:
 *   - company-entered: display_name, ownership_percent, phone_e164, locale
 *   - self-supplied:   everything from legal_first_name down
 *
 * Column-level GRANTs in migration 0001 make that split real. The app_company
 * role has SELECT on the first group only, so a company session cannot read the
 * second group even with a hand-written query — not even tin_last4.
 */
export const companyOwners = pgTable(
  'company_owners',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // --- entered by the company admin ---
    displayName: text('display_name').notNull(),
    ownershipPercent: numeric('ownership_percent', { precision: 5, scale: 2 }),
    phoneE164: text('phone_e164').notNull(),
    preferredLocale: localeEnum('preferred_locale').notNull().default('en'),
    status: ownerStatus('status').notNull().default('INVITED'),

    // --- supplied by the owner, through their own link ---
    legalFirstName: text('legal_first_name'),
    legalMiddleName: text('legal_middle_name'),
    legalLastName: text('legal_last_name'),
    dateOfBirth: date('date_of_birth'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    email: text('email'),
    tinType: tinType('tin_type'),
    tinEnc: bytea('tin_enc'),
    tinLast4: text('tin_last4'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    /** Set by the retention job, as on worker_records. */
    purgedAt: timestamp('purged_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [index('owners_company_idx').on(t.companyId)],
);
