import { pgEnum } from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', ['active', 'suspended']);

export const userStatus = pgEnum('user_status', ['pending', 'active', 'suspended']);

/**
 * Staff roles only. OWNER and WORKER are deliberately absent — they have no
 * user row and no login (spec section 2). A subject exists only as a live
 * invite session, which is a different mechanism entirely.
 */
export const userRole = pgEnum('user_role', [
  'PLATFORM_ADMIN',
  'FIRM_ADMIN',
  'FIRM_STAFF',
  'COMPANY_ADMIN',
  'COMPANY_STAFF',
]);

export const localeEnum = pgEnum('locale', ['en', 'es']);

export const onboardingStatus = pgEnum('onboarding_status', ['PENDING', 'IN_REVIEW', 'COMPLETE']);

export const wcStatus = pgEnum('wc_status', ['POLICY', 'EXEMPT', 'PENDING']);

export const ownerStatus = pgEnum('owner_status', ['INVITED', 'IN_PROGRESS', 'SUBMITTED']);

export const workerType = pgEnum('worker_type', ['EMPLOYEE', 'SUBCONTRACTOR']);

export const workerStatus = pgEnum('worker_status', [
  'INVITED',
  'IN_PROGRESS',
  'SUBMITTED',
  'NEEDS_ATTENTION',
  'ARCHIVED',
]);

export const payType = pgEnum('pay_type', ['HOURLY', 'SALARY']);

export const payFrequency = pgEnum('pay_frequency', [
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
]);

export const tinType = pgEnum('tin_type', ['SSN', 'ITIN']);

export const bankAccountType = pgEnum('bank_account_type', ['CHECKING', 'SAVINGS']);

export const submittedVia = pgEnum('submitted_via', ['WORKER_FORM', 'FIRM_ENTRY']);

export const subjectType = pgEnum('subject_type', ['COMPANY', 'OWNER', 'WORKER']);

export const signatureDocumentType = pgEnum('signature_document_type', [
  'DATA_ACCURACY',
  'DIRECT_DEPOSIT_AUTH',
  'COMPANY_CERTIFICATION',
]);

export const docType = pgEnum('doc_type', [
  'ARTICLES_OF_INCORPORATION',
  'WC_POLICY',
  'WC_EXEMPTION',
  'DISABILITY_POLICY',
  'VOIDED_CHECK',
  'ID_DOCUMENT',
  'W9',
  'W4',
  'I9',
  // The PDF of a signed authorization (spec section 9, step 5). Not in the
  // spec's list, which predates the retained-record requirement having a home:
  // storing these as OTHER made them COMPANY_VISIBLE by default, because OTHER
  // is the type a company admin uses for an ordinary business document.
  'SIGNED_AUTHORIZATION',
  'OTHER',
]);

/**
 * Load-bearing (spec section 4). FIRM_ONLY is invisible to company users
 * including in the file list. Anything a worker or owner uploads is FIRM_ONLY
 * with no override.
 */
export const sensitivity = pgEnum('sensitivity', ['COMPANY_VISIBLE', 'FIRM_ONLY']);

export const noteVisibility = pgEnum('note_visibility', ['COMPANY_AND_FIRM', 'FIRM_ONLY']);

export const reminderChannel = pgEnum('reminder_channel', ['SMS', 'EMAIL']);

export const inviteSubjectType = pgEnum('invite_subject_type', ['OWNER', 'WORKER']);

export const auditAction = pgEnum('audit_action', [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'GRANT_CREATED',
  'GRANT_REVOKED',
  'COMPANY_CREATED',
  'OWNER_INVITED',
  'WORKER_CREATED',
  'INVITE_SENT',
  'INVITE_OPENED',
  'INVITE_VERIFY_FAILED',
  'FORM_SUBMITTED',
  'SIGNATURE_CAPTURED',
  'RECORD_CORRECTED',
  'REVEAL_TIN',
  'REVEAL_BANK',
  'DOCUMENT_VIEWED',
  // Not in the spec's list. A document that appears in a firm's view and a
  // document that disappears from it are both disclosures of a kind, and
  // DOCUMENT_VIEWED cannot carry either meaning without a metadata field that
  // nobody would think to query.
  'DOCUMENT_UPLOADED',
  'DOCUMENT_DELETED',
  'EXPORT_CREATED',
  'EXPORT_DOWNLOADED',
  'REMINDER_SENT',
  'RECORD_PURGED',
  // Not in the spec's list, but section 5 requires writing one when a
  // COMPANY_ADMIN session reaches the decrypt guard or a company-forbidden table.
  'SECURITY_VIOLATION',
]);
