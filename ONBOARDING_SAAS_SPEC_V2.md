# Onboarding Platform: Technical Build Spec

**Version 2.0** | Supersedes v1.0 | Client: Kijoenna Services Inc.

Changes from v1: the employer no longer has access to sensitive worker data. An accounting firm role is introduced as the sole consumer of that data. Company registration, company owners, payroll fields, e-signature, and the documents/notes tab are added from the client field specification.

---

## 1. What this system is

A three-party intake platform.

- The **accounting firm** onboards its client companies and is the only party that ever reads sensitive data.
- A **company** registers itself, and its owners individually supply their own tax IDs. The company invites its workers.
- A **worker** completes a short bilingual mobile form containing their own personal and banking data. Nobody at the company sees it.

The governing rule, taken directly from the client specification: *el empleador no debe ver ni recolectar estos datos directamente.* The employer must not see or collect the worker's data directly. Every design decision below follows from that sentence.

**This system is not payroll.** It collects, validates, stores, and hands off. It does not calculate, withhold, file, or move money.

### Non-negotiable security properties

1. Sensitive fields (SSN/ITIN, bank account, routing) are encrypted at rest with per-company data keys, never logged, never in a list response, never in a client bundle.
2. A company user can never decrypt a worker's sensitive field. This is enforced in the data access layer, not the UI.
3. Every decryption writes an audit row before the value is returned.
4. Firm access to a company is an explicit, per-company, revocable grant. There is no implicit cross-tenant read.
5. Every person who supplies a tax ID or bank account supplies it themselves, through their own single-use link. This includes company owners.
6. Invite links are single-use, time-limited, and require a second factor.

---

## 2. Roles

| Role | Scope | Sensitive data access |
|---|---|---|
| `PLATFORM_ADMIN` | Global | **None.** Can create firms, suspend accounts, read audit metadata. Cannot decrypt anything |
| `FIRM_ADMIN` | One firm, granted companies | **Full, with reason + re-auth + audit.** Can export. Can manage firm staff |
| `FIRM_STAFF` | One firm, granted companies | Read masked, reveal single fields with reason + re-auth. **Cannot export** |
| `COMPANY_ADMIN` | One company | Manage company profile, invite owners, invite workers, upload company documents, see completion status. **Never sees worker or owner sensitive fields, not even last-4** |
| `COMPANY_STAFF` | One company | Invite workers, see status. No document access |
| `OWNER` | Self, one session | Supplies own name, address, SSN/ITIN via link. No login |
| `WORKER` | Self, one session | Supplies own data via link. No login |

**On last-4 for company users:** do not show it. Last-4 of a bank account plus a name is enough for several social-engineering paths, and the company has no stated need for it. Company list views show a status chip only: `Invited`, `In progress`, `Submitted`, `Needs attention`.

---

## 3. Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15, App Router, TypeScript strict |
| DB | PostgreSQL 16, Row Level Security enabled |
| ORM | Drizzle |
| Staff auth | Auth.js v5, argon2id, TOTP mandatory for all firm roles |
| Field encryption | AWS KMS envelope encryption, AES-256-GCM |
| Files | S3, private, SSE-KMS, presigned URLs only |
| SMS | Twilio |
| Email | Resend or SES |
| i18n | `next-intl`, `en` and `es` |
| Validation | Zod, shared client/server |
| E-signature | Custom ESIGN-compliant capture (see section 9) |
| Styling | Tailwind, mobile-first |

---

## 4. Data model

All tables: `id` uuid v7, `created_at`, `updated_at`.

### `firms`
```
id, name, contact_email, contact_phone, status enum('active','suspended')
```

### `companies`
```
id                    uuid pk
firm_id               uuid -> firms.id not null
legal_name            text not null
dba_name              text
ein                   text                  -- format 00-0000000, not treated as sensitive
address_line1, address_line2, city, state, postal_code
contact_email         text
contact_phone         text
operating_states      text[]                -- WC and state tax rules vary
bank_name             text
bank_routing_enc      bytea
bank_routing_last4    text
bank_account_enc      bytea
bank_account_last4    text
wc_status             enum('POLICY','EXEMPT','PENDING')
wc_policy_number      text
wc_carrier            text
wc_expires_on         date
disability_policy_number  text
disability_carrier    text
disability_expires_on date
dek_ciphertext        bytea not null
dek_key_id            text not null
onboarding_status     enum('PENDING','IN_REVIEW','COMPLETE')
status                enum('active','suspended')
```

Company banking is entered by the company itself and is not subject to the employer-cannot-see rule, since the company owns that account. Store it encrypted anyway, and mask it in the company's own UI with a reveal available to `COMPANY_ADMIN` only.

### `firm_company_grants`
The explicit access grant. Without a live row here, a firm user cannot read a company at all.
```
id, firm_id, company_id
granted_by        uuid -> users.id
granted_at        timestamptz
revoked_at        timestamptz
revoked_by        uuid
```

### `company_owners`
Owner tax IDs are needed for K-1 issuance. Each owner supplies their own.
```
id                uuid pk
company_id        uuid not null
display_name      text not null      -- what the company admin typed
ownership_percent numeric(5,2)
phone_e164        text not null
preferred_locale  enum('en','es')
status            enum('INVITED','IN_PROGRESS','SUBMITTED')
-- self-supplied, on submission:
legal_first_name, legal_middle_name, legal_last_name
date_of_birth     date
address_line1, address_line2, city, state, postal_code
email             text
tin_type          enum('SSN','ITIN')
tin_enc           bytea
tin_last4         text
submitted_at      timestamptz
```

### `workers`
```
id, company_id, worker_type enum('EMPLOYEE','SUBCONTRACTOR')
display_name      text not null
phone_e164        text not null
preferred_locale  enum('en','es')
status            enum('INVITED','IN_PROGRESS','SUBMITTED','NEEDS_ATTENTION','ARCHIVED')

-- payroll fields, entered by the COMPANY, not the worker
job_title         text
start_date        date
pay_type          enum('HOURLY','SALARY')
pay_frequency     enum('WEEKLY','BIWEEKLY','SEMIMONTHLY','MONTHLY')
work_state        text
-- deliberately excluded: pay rate. See section 14.

submitted_at, archived_at, legal_hold boolean default false
```

Splitting payroll fields onto `workers` (company-entered) and personal data onto `worker_records` (worker-entered) is what makes the access rule enforceable. The company can freely read and edit `workers`. The company can never read `worker_records`.

### `worker_records` (versioned, append-only, INSERT only)
```
id, worker_id, company_id, version int, effective_from, superseded_at, is_current bool

legal_first_name, legal_middle_name, legal_last_name
date_of_birth     date
address_line1, address_line2, city, state, postal_code
email, phone_e164
tin_type          enum('SSN','ITIN')
tin_enc           bytea not null
tin_last4         text not null
bank_name         text
bank_account_type enum('CHECKING','SAVINGS')
routing_enc, routing_last4
account_enc, account_last4
emergency_contact_name, emergency_contact_phone, emergency_contact_relationship

submitted_via     enum('WORKER_FORM','FIRM_ENTRY')
submitted_ip      inet
submitted_user_agent text
```

Unique partial index on `(worker_id) WHERE is_current`.

### `signatures`
ESIGN-compliant capture. One row per signed authorization.
```
id, subject_type enum('WORKER','OWNER','COMPANY'), subject_id
document_type   enum('DATA_ACCURACY','DIRECT_DEPOSIT_AUTH','COMPANY_CERTIFICATION')
document_version text not null
document_locale enum('en','es') not null
document_hash   text not null       -- sha256 of the exact text shown
typed_name      text not null
consent_to_electronic boolean not null
signed_at       timestamptz not null
ip              inet not null
user_agent      text not null
```

Hashing the exact rendered text is what makes the signature defensible. If the consent copy changes later, the old signature still points at what was actually agreed to.

### `documents`
```
id, company_id, subject_type enum('COMPANY','OWNER','WORKER'), subject_id
doc_type    enum('ARTICLES_OF_INCORPORATION','WC_POLICY','WC_EXEMPTION','DISABILITY_POLICY',
                 'VOIDED_CHECK','ID_DOCUMENT','W9','W4','I9','OTHER')
label       text                    -- free text, "what is this file"
s3_key, content_type, size_bytes
uploaded_by_role  text
sensitivity enum('COMPANY_VISIBLE','FIRM_ONLY') not null
```

**The `sensitivity` flag is load-bearing.** A voided check, a W-4, an ID document, or anything uploaded by a worker is `FIRM_ONLY` and is invisible to company users, including in the file list. Articles of incorporation and the WC policy are `COMPANY_VISIBLE`. Default to `FIRM_ONLY` for anything a worker or owner uploads, with no override.

### `notes`
The observations tab.
```
id, company_id, subject_type, subject_id
body        text not null
author_role text
visibility  enum('COMPANY_AND_FIRM','FIRM_ONLY') not null
```

Worker-authored notes are `FIRM_ONLY`. A worker typing "my ITIN application is still pending" should not surface to their employer. That is exactly the case the client document names, and it is exactly the case where the disclosure matters.

### `reminders`
```
id, subject_type, subject_id, reason text
scheduled_for timestamptz, sent_at timestamptz, channel enum('SMS','EMAIL'), attempt int
```

### `audit_log` (append-only, DELETE and UPDATE revoked at the DB role level)
```
id, firm_id, company_id, actor_user_id, actor_role, action, target_type, target_id,
reason text, ip, user_agent, metadata jsonb, created_at
```

Actions: `LOGIN_SUCCESS`, `LOGIN_FAILURE`, `GRANT_CREATED`, `GRANT_REVOKED`, `COMPANY_CREATED`, `OWNER_INVITED`, `WORKER_CREATED`, `INVITE_SENT`, `INVITE_OPENED`, `INVITE_VERIFY_FAILED`, `FORM_SUBMITTED`, `SIGNATURE_CAPTURED`, `RECORD_CORRECTED`, `REVEAL_TIN`, `REVEAL_BANK`, `DOCUMENT_VIEWED`, `EXPORT_CREATED`, `EXPORT_DOWNLOADED`, `REMINDER_SENT`, `RECORD_PURGED`.

### `exports`
```
id, firm_id, company_id, requested_by, reason text not null,
scope jsonb, include_sensitive bool, s3_key, expires_at, downloaded_at
```

---

## 5. Access enforcement

Three layers. All three required.

**Layer 1, Postgres RLS.** Every table with `company_id` has a policy. The app sets `SET LOCAL app.actor_scope` inside each transaction. For company sessions the scope is a single company id. For firm sessions it is the set of company ids with a live grant, derived at session start, not trusted from the client.

**Layer 2, the data access layer.** All queries go through `lib/db/scoped.ts`. It takes a session and returns a builder bound to that session's scope. No route handler imports the raw Drizzle client. Enforce with an ESLint `no-restricted-imports` rule.

**Layer 3, the decrypt guard.** `decryptField()` refuses to run unless the caller's session role is in `('FIRM_ADMIN','FIRM_STAFF')`, or the caller is the data subject inside a live invite session. A `COMPANY_ADMIN` session reaching this function is a bug, and it should throw and log a `SECURITY_VIOLATION` audit row rather than returning empty.

**Required integration tests, all must pass before any feature work continues:**
- Company A authenticated, requests every entity type of Company B by direct id. All return not-found.
- `COMPANY_ADMIN` requests `worker_records` for their own company. Returns not-found, and writes a `SECURITY_VIOLATION` row.
- `COMPANY_ADMIN` requests a `FIRM_ONLY` document in their own company. Not-found.
- `FIRM_STAFF` requests a company with a revoked grant. Not-found.
- Every JSON response from every company-scoped endpoint is scanned for the substrings `_enc`, `tin`, `routing`, `account`. None present.

---

## 6. Field encryption

Per-company DEK, wrapped by a single KMS CMK.

On company creation, `GenerateDataKey`, store the ciphertext DEK, discard the plaintext. On write, decrypt the DEK (cached in memory 5 minutes max, keyed by company), encrypt the field with AES-256-GCM, store `nonce || ciphertext || tag`, store last-4 separately.

All of it lives in `lib/security/field-encryption.ts`, exposing `encryptField(companyId, plaintext)` and `decryptField(companyId, ciphertext, auditContext)`. Nothing else imports the AES primitives. This module is written behind a stable interface so a hosted PII vault can replace it later without touching call sites.

Add a global log redaction filter: scrub any 9-digit sequence, any field named `tin`, `ssn`, `account`, `routing`, and any `*_enc` value, before the line leaves the process.

On company deletion, destroy the DEK. That cryptographically shreds every sensitive field for that company in a single operation.

---

## 7. Flows

### 7.1 Firm onboards a company
1. `FIRM_ADMIN` enters company legal name, EIN, address, contact email and phone, and the company admin's name and email.
2. System creates the company, generates and wraps the DEK, creates the `firm_company_grants` row, creates the `COMPANY_ADMIN` user in pending state.
3. Emails a setup link, 24h TTL, password creation plus mandatory TOTP.

### 7.2 Company completes its own profile
Company admin fills: operating states, WC status with policy number and expiry or an exemption document, disability policy if applicable, company bank details, and uploads Articles of Incorporation. Then signs the company certification.

### 7.3 Company invites its owners
For each owner, the company admin enters only a display name, ownership percentage, mobile number, and language. Each owner receives their own SMS link and supplies their own name, DOB, address, and SSN/ITIN. The company admin sees only `Submitted` or `Pending`.

If the company is a single-member entity, the admin is the owner and still goes through the owner link. The flow does not branch.

### 7.4 Company invites a worker
Company enters display name, worker type, mobile, language, and the payroll fields (job title, start date, pay type, pay frequency, work state). Then sends the invite.

### 7.5 Worker completes the form
1. Opens the link.
2. **Second factor gate:** date of birth. The company user does not know it, so a forwarded or intercepted link is inert. Five failures locks the invite for 60 minutes and alerts the firm, not the company.
3. One question per screen. Server-side save after each step, resumable by reopening the same link inside its TTL.
4. Consent and signature screens in the worker's language.
5. On submit: write `worker_records` v1, set status `SUBMITTED`, consume the invite, log.

### 7.6 Firm reads a worker
Detail view shows non-sensitive fields plaintext, sensitive fields as `•••-••-1234`. `FIRM_STAFF` or `FIRM_ADMIN` clicks reveal on one field of one record, re-enters TOTP, and types a reason of at least ten characters. The audit row is written before decryption. The value renders for 30 seconds then auto-masks. Single field, single record. No bulk reveal exists in the codebase.

### 7.7 Export
`FIRM_ADMIN` only. Select companies, workers, date range, and whether to include sensitive fields. Reason required. Output is a password-protected zip containing `workers.csv`, `owners.csv`, and a `documents/` folder. The password displays once on screen and is never sent by SMS or email. S3 object hard-deletes at 24 hours.

### 7.8 Corrections
A worker cannot log back in. If a value is wrong, the firm creates a correction, which writes a new `worker_records` version and preserves the old one. Alternatively the firm re-issues an invite link, which the worker uses to submit a fresh version.

---

## 8. Worker form screens

Mobile-first, one question per screen, persistent language switcher in the header including on the verify gate, back button everywhere.

| # | Screen | Notes |
|---|---|---|
| 0 | Verify: date of birth | Three numeric selects, more reliable than a native date picker on old Android |
| 1 | Welcome | Names the inviting company, explains what is collected and that the employer will not see it |
| 2 | Legal name | first, middle, last |
| 3 | DOB confirm | prefilled, read-only |
| 4 | Address | state is a select, zip `inputMode="numeric"` |
| 5 | Contact | email optional, phone prefilled |
| 6 | Emergency contact | name, phone, relationship |
| 7 | Tax ID type | two large buttons, SSN or ITIN, plain-language explanation |
| 8 | Tax ID | `inputMode="numeric"`, masked as typed, live format validation |
| 9 | Bank name and account type | |
| 10 | Routing number | `inputMode="numeric"`, live ABA checksum, inline error |
| 11 | Account number | plus a confirmation field that must match |
| 12 | Voided check photo | optional, `capture="environment"`, client-side downscale to 2000px, direct presigned PUT to S3 |
| 13 | Notes | free text, marked firm-only on screen |
| 14 | Review | all fields, sensitive ones masked |
| 15 | Direct deposit authorization | full text, typed name, ESIGN consent checkbox |
| 16 | Data accuracy certification | full text, typed name |
| 17 | Done | no sensitive values shown |

Owner form is screens 0 through 8, then 13, 14, and 16.

---

## 9. E-signature

Not DocuSign. A compliant typed-name signature under the federal ESIGN Act requires: disclosure that the party consents to conducting the transaction electronically, affirmative consent to that, an intent-to-sign act, association of the signature with the record, and retention of a reproducible record.

Implementation:
1. Render the full authorization text on screen, in the signer's chosen language. No scrolling past it, no collapsed accordion.
2. Checkbox: consent to sign electronically. Unchecked by default.
3. Text input: type your full legal name. Compare case-insensitively to the legal name already supplied and warn on mismatch without blocking.
4. On submit, hash the exact rendered text and store the hash, the version string, the locale, the typed name, timestamp, IP, and user agent.
5. Generate a PDF of the signed document at submission time and store it as a `FIRM_ONLY` document.

The direct deposit authorization text and the data accuracy certification must be supplied or approved by the client's counsel in English, then human-translated to Spanish. Machine translation is not acceptable for these two documents.

---

## 10. Validation

**SSN:** 9 digits. Reject area `000`, `666`, `900-999`. Reject group `00`. Reject serial `0000`. Reject `078-05-1120` and `219-09-9999`.

**ITIN:** 9 digits, must start with `9`, group digits in `50-65`, `70-88`, `90-92`, `94-99`.

**Type mismatch:** if SSN is selected but the number matches ITIN ranges, soft warning asking them to confirm. Do not hard block.

**ABA routing:** 9 digits and `(3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)) mod 10 == 0`. Hard block on failure. This catches most typos before a deposit ever bounces.

**Bank account:** 4 to 17 digits, must match confirmation field.

**EIN:** 9 digits, format `00-0000000`.

**DOB:** resulting age between 14 and 100.

**Ownership percentages:** warn if the sum across owners is not 100.

---

## 11. Status tracking and reminders

Company-level `onboarding_status` derives from: profile complete, all owners submitted, articles uploaded, WC resolved, company certification signed.

Worker-level status derives from: invite sent, form submitted, both signatures captured.

Reminder job runs daily. If a subject has been `INVITED` or `IN_PROGRESS` for 3 days, send a reminder in their language. Repeat at 7 and 14 days. After 14, mark `NEEDS_ATTENTION` and notify the company admin (for workers) or the firm (for companies).

Reminder content never includes what data is missing beyond a generic prompt, since SMS is not a secure channel.

---

## 12. Internationalization

- `next-intl`, `en` and `es`, zero hardcoded strings.
- Default from `Accept-Language`, then overridden by the subject's stored `preferred_locale`.
- Persistent header switcher on every screen including the verify gate.
- SMS and email in `preferred_locale`.
- Human translation required for: consent text, both signature documents, the privacy notice, and every tax ID validation error. Machine translation acceptable elsewhere.
- Design at Spanish string lengths. Spanish runs 20 to 30 percent longer than English. Test every screen in `es` at 360px width.

---

## 13. Retention

- `worker_records` and `company_owners` retained 4 years after supersession or archival, then purge-eligible. Per-company override setting.
- `legal_hold` blocks all purge jobs.
- Nightly purge job nulls `_enc` and `_last4` columns, keeps the row skeleton and the full audit trail, logs `RECORD_PURGED`.
- Export artifacts hard-delete at 24 hours regardless of hold.
- Signature PDFs retained for the life of the record plus 4 years.

---

## 14. Build order

1. Schema, RLS, grants, and all five isolation tests. Nothing else starts until they pass.
2. `field-encryption.ts`, KMS wiring, ESLint import restriction, log redaction.
3. Audit log.
4. Staff auth with mandatory TOTP for firm roles.
5. Firm creates company, grant, company admin setup.
6. Company profile, documents, company banking.
7. Invite engine: token hashing, TTL, DOB gate, Twilio, resumable sessions.
8. Owner form.
9. Worker form.
10. E-signature.
11. i18n applied across everything built so far.
12. Firm dashboard, masked views, reveal.
13. Company dashboard, status-only views.
14. Notes and documents tabs with the visibility split.
15. Reminders.
16. Export.
17. Retention jobs.

---

## 15. Out of scope

- **W-4 and I-9 form logic.** Stored as uploaded documents only. I-9 Section 2 legally requires physical examination of original documents, or the DHS remote alternative available only to employers enrolled and in good standing with E-Verify. Software cannot complete it.
- **Pay rate.** Deliberately excluded from the schema. It is not needed for identity or tax intake, it is the most contentious field to expose, and adding it converts this into a compensation system with a different disclosure profile. Add it only if the firm insists, and if so, mark it `FIRM_ONLY`.
- Payroll calculation, tax filing, ACH generation, 1099 or W-2 output
- Plaid or any bank-login flow
- E-Verify integration
- Worker self-service login after submission
- COI expiration alerting beyond the WC and disability date fields already present
- Languages beyond English and Spanish
- Native mobile apps
- Billing and subscriptions

---

## 16. Decisions still needed from the client

1. **Owner invite links.** Confirm the firm accepts that a company admin cannot type in a co-owner's SSN. This adds friction and it is the same rule they wrote for employees.
2. **Consent, direct deposit authorization, and data accuracy text.** Must come from counsel in English, then a human Spanish translation. This is the item most likely to delay launch, so request it on day one.
3. **Data processing agreement.** The platform is a processor. The firm and the companies are controllers. This should exist before the first real SSN enters the system.
4. **Reveal reason field.** Confirm firm staff accept typing a reason on every reveal. If they refuse, the fallback is reason-free reveal with mandatory re-auth and a weekly reveal digest emailed to the firm admin. Do not remove the audit row.
5. **WC exemption.** Confirm which states, since exemption rules and the acceptable proof document vary.
