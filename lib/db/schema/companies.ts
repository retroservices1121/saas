import { pgTable, text, uuid, date, index, uniqueIndex, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidV7Pk, timestamps, bytea } from './_shared';
import { accountStatus, onboardingStatus, wcStatus } from './enums';
import { firms, users } from './firms';

export const companies = pgTable(
  'companies',
  {
    id: uuidV7Pk(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'restrict' }),

    legalName: text('legal_name').notNull(),
    dbaName: text('dba_name'),
    // Format 00-0000000. Not treated as sensitive (spec section 4) — an EIN is
    // a business identifier, published in many public filings, and the company
    // supplies its own. It is stored plaintext deliberately.
    ein: text('ein'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),

    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),

    // WC and state tax rules vary by state, so a company may operate in many.
    operatingStates: text('operating_states').array(),

    // Company's own bank account. Not covered by the employer-cannot-see rule
    // (the company owns this account), but encrypted anyway, and revealable
    // only by COMPANY_ADMIN.
    bankName: text('bank_name'),
    bankRoutingEnc: bytea('bank_routing_enc'),
    bankRoutingLast4: text('bank_routing_last4'),
    bankAccountEnc: bytea('bank_account_enc'),
    bankAccountLast4: text('bank_account_last4'),

    wcStatus: wcStatus('wc_status').notNull().default('PENDING'),
    wcPolicyNumber: text('wc_policy_number'),
    wcCarrier: text('wc_carrier'),
    wcExpiresOn: date('wc_expires_on'),

    disabilityPolicyNumber: text('disability_policy_number'),
    disabilityCarrier: text('disability_carrier'),
    disabilityExpiresOn: date('disability_expires_on'),

    // Envelope encryption. The plaintext DEK is generated once, used, and
    // discarded; only the wrapped form is ever persisted. Destroying this
    // column cryptographically shreds every sensitive field for the company.
    dekCiphertext: bytea('dek_ciphertext').notNull(),
    dekKeyId: text('dek_key_id').notNull(),
    dekDestroyedAt: timestamp('dek_destroyed_at', { withTimezone: true }),

    onboardingStatus: onboardingStatus('onboarding_status').notNull().default('PENDING'),
    status: accountStatus('status').notNull().default('active'),

    // Spec section 13: per-company override of the 4-year retention default.
    retentionYears: text('retention_years'),
    ...timestamps,
  },
  (t) => [index('companies_firm_idx').on(t.firmId)],
);

/**
 * The explicit access grant (spec section 4). Without a live row here — granted
 * and not revoked — a firm user cannot read a company at all. There is no
 * implicit cross-tenant read anywhere in the system; firm scope is derived from
 * this table at session start and never trusted from the client.
 */
export const firmCompanyGrants = pgTable(
  'firm_company_grants',
  {
    id: uuidV7Pk(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('grants_firm_idx').on(t.firmId),
    index('grants_company_idx').on(t.companyId),
    // At most one live grant per (firm, company). Revoked rows are retained for
    // the audit trail, so the uniqueness is partial.
    uniqueIndex('grants_live_uq')
      .on(t.firmId, t.companyId)
      .where(sql`revoked_at is null`),
  ],
);
