import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  bigint,
  timestamp,
  inet,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidV7Pk, timestamps } from './_shared';
import {
  docType,
  localeEnum,
  noteVisibility,
  reminderChannel,
  sensitivity,
  signatureDocumentType,
  subjectType,
} from './enums';
import { companies } from './companies';

/**
 * ESIGN-compliant capture. One row per signed authorization.
 *
 * document_hash is the sha256 of the exact text rendered on screen. That is
 * what makes the signature defensible: if the consent copy is revised later,
 * this row still points at what was actually agreed to, in the language it was
 * actually read in.
 */
export const signatures = pgTable(
  'signatures',
  {
    id: uuidV7Pk(),
    // Nullable only for COMPANY subjects that predate a company_id; in practice
    // always set. RLS depends on it, so it is NOT NULL.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    subjectType: subjectType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    documentType: signatureDocumentType('document_type').notNull(),
    documentVersion: text('document_version').notNull(),
    documentLocale: localeEnum('document_locale').notNull(),
    documentHash: text('document_hash').notNull(),

    typedName: text('typed_name').notNull(),
    consentToElectronic: boolean('consent_to_electronic').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    ip: inet('ip').notNull(),
    userAgent: text('user_agent').notNull(),

    ...timestamps,
  },
  (t) => [
    index('signatures_company_idx').on(t.companyId),
    index('signatures_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

/**
 * The `sensitivity` column is load-bearing (spec section 4). A voided check, a
 * W-4, an ID document, or anything uploaded by a worker or owner is FIRM_ONLY
 * and invisible to company users including in the file list. The default is
 * FIRM_ONLY, and migration 0001 adds a trigger that forces it for any row whose
 * uploader was a subject — there is no override path.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    subjectType: subjectType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    docType: docType('doc_type').notNull(),
    label: text('label'),

    s3Key: text('s3_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),

    uploadedByRole: text('uploaded_by_role').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    sensitivity: sensitivity('sensitivity').notNull().default('FIRM_ONLY'),

    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('documents_company_idx').on(t.companyId),
    index('documents_subject_idx').on(t.subjectType, t.subjectId),
    index('documents_sensitivity_idx').on(t.companyId, t.sensitivity),
  ],
);

/**
 * The observations tab. Worker-authored notes are FIRM_ONLY: a worker typing
 * "my ITIN application is still pending" must not surface to their employer.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    subjectType: subjectType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    body: text('body').notNull(),
    authorRole: text('author_role').notNull(),
    authorUserId: uuid('author_user_id'),
    visibility: noteVisibility('visibility').notNull().default('FIRM_ONLY'),

    ...timestamps,
  },
  (t) => [
    index('notes_company_idx').on(t.companyId),
    index('notes_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: uuidV7Pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    subjectType: subjectType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    reason: text('reason').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    channel: reminderChannel('channel').notNull(),
    attempt: integer('attempt').notNull().default(1),

    ...timestamps,
  },
  (t) => [
    index('reminders_due_idx').on(t.scheduledFor).where(sql`sent_at is null`),
    index('reminders_subject_idx').on(t.subjectType, t.subjectId),
  ],
);
