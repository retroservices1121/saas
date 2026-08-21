/**
 * Workers and owners: how they are invited, and what happens when they submit.
 *
 * The split the whole design rests on lives here. A company writes `workers` —
 * a display name, a mobile number, and the payroll fields it entered itself. A
 * worker writes `worker_records` — their legal name, their date of birth, their
 * tax ID, their bank account. Nothing in this file lets one write the other's
 * table, and the Postgres grants mean nothing in any other file could either.
 */
import { and, eq, sql } from 'drizzle-orm';
import { insertColumns, schema, withScope, type ScopedDb } from '../scoped';
import type { CompanySession, FirmSession, Session, SubjectSession } from '../../auth/session';
import { audit } from '../../audit';
import { type SealedValue } from '../../security/field-encryption';
import { issueInvite, type IssuedInvite } from '../../invites';
import { sendOwnerInvite, sendWorkerInvite } from '../../notifications';
import { uuidv7 } from '../../uuid';
import type { InviteOwnerInput, InviteWorkerInput } from '../../validation/forms';
import type { Locale } from '../../../i18n/request';

// ---------------------------------------------------------------------------
// 7.3 / 7.4 Invitations
// ---------------------------------------------------------------------------

export interface InviteResult {
  subjectId: string;
  invite: IssuedInvite;
}

/**
 * Creates a worker and its invite in one transaction, then sends the SMS.
 *
 * The send is outside the transaction and after the commit, deliberately. A
 * text message cannot be rolled back: sending inside the transaction and then
 * failing to commit leaves a live link in someone's pocket pointing at a worker
 * row that does not exist. The reverse failure — committed row, SMS not sent —
 * is visible as an `Invited` row with no `sent_at`, and is fixed by resending.
 */
export async function inviteWorker(
  session: CompanySession | FirmSession,
  companyId: string,
  input: InviteWorkerInput,
): Promise<InviteResult> {
  const workerId = uuidv7();

  const { invite, companyName } = await withScope(session, async (db) => {
    await db.insert(schema.workers).values({
      id: workerId,
      companyId,
      workerType: input.workerType,
      displayName: input.displayName,
      phoneE164: input.phoneE164,
      preferredLocale: input.preferredLocale,
      status: 'INVITED',
      jobTitle: input.jobTitle ?? null,
      startDate: input.startDate || null,
      payType: input.payType ?? null,
      payFrequency: input.payFrequency ?? null,
      workState: input.workState ?? null,
    });

    await audit(db, session, {
      action: 'WORKER_CREATED',
      companyId,
      targetType: 'workers',
      targetId: workerId,
    });

    const issued = await issueInvite(db, session, {
      companyId,
      subjectType: 'WORKER',
      subjectId: workerId,
    });

    return { invite: issued, companyName: await readCompanyName(db, companyId) };
  });

  await deliverInvite(session, {
    inviteId: invite.inviteId,
    subjectType: 'WORKER',
    phoneE164: input.phoneE164,
    locale: input.preferredLocale,
    companyName,
    url: invite.url,
  });

  return { subjectId: workerId, invite };
}

/**
 * Creates an owner and its invite. The company supplies a display name, a
 * percentage, a mobile number and a language — and stops there.
 *
 * Rule 5 of the security properties applies to owners exactly as to workers:
 * the tax ID is supplied by its owner through their own link. Spec section 7.3
 * is explicit that a single-member entity does not branch — the admin is the
 * owner and still goes through the owner link.
 */
export async function inviteOwner(
  session: CompanySession | FirmSession,
  companyId: string,
  input: InviteOwnerInput,
): Promise<InviteResult> {
  const ownerId = uuidv7();

  const { invite, companyName } = await withScope(session, async (db) => {
    // The seven columns a company may write on an owner — everything from the
    // legal name down is the owner's to supply, through their own link, and
    // app_company holds no INSERT privilege on any of it. Hand-written because
    // an ORM insert would name all twenty-three columns; see insertColumns.
    await db.execute(
      insertColumns('company_owners', {
        id: ownerId,
        company_id: companyId,
        display_name: input.displayName,
        ownership_percent:
          input.ownershipPercent == null ? null : String(input.ownershipPercent),
        phone_e164: input.phoneE164,
        preferred_locale: input.preferredLocale,
        status: 'INVITED',
      }),
    );

    await audit(db, session, {
      action: 'OWNER_INVITED',
      companyId,
      targetType: 'company_owners',
      targetId: ownerId,
    });

    const issued = await issueInvite(db, session, {
      companyId,
      subjectType: 'OWNER',
      subjectId: ownerId,
    });

    return { invite: issued, companyName: await readCompanyName(db, companyId) };
  });

  await deliverInvite(session, {
    inviteId: invite.inviteId,
    subjectType: 'OWNER',
    phoneE164: input.phoneE164,
    locale: input.preferredLocale,
    companyName,
    url: invite.url,
  });

  return { subjectId: ownerId, invite };
}

/**
 * Issues a fresh link for someone who already exists — a lost text message, an
 * expired link, or a correction the firm wants the worker to make themselves
 * (spec section 7.8).
 *
 * For a worker who has already submitted, the gate is seeded from the date of
 * birth on their current record, so the re-issued link is genuinely gated
 * rather than pinned on first use.
 */
export async function resendInvite(
  session: CompanySession | FirmSession,
  params: {
    companyId: string;
    subjectType: 'WORKER' | 'OWNER';
    subjectId: string;
  },
): Promise<IssuedInvite> {
  const { invite, companyName, phoneE164, locale } = await withScope(session, async (db) => {
    const contact = await readSubjectContact(
      db,
      params.subjectType,
      params.subjectId,
      params.companyId,
    );
    if (!contact) throw new Error('No such subject in this company.');

    const expectedDob = await readKnownDob(db, session, params);

    const issued = await issueInvite(db, session, {
      companyId: params.companyId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      expectedDob,
    });

    return {
      invite: issued,
      companyName: await readCompanyName(db, params.companyId),
      phoneE164: contact.phoneE164,
      locale: contact.preferredLocale,
    };
  });

  await deliverInvite(session, {
    inviteId: invite.inviteId,
    subjectType: params.subjectType,
    phoneE164,
    locale,
    companyName,
    url: invite.url,
  });

  return invite;
}

/**
 * The date of birth to gate a re-issued link on, when the system already holds
 * one. A company session cannot read either source — that is the point — so it
 * gets undefined and the link pins on first use.
 */
async function readKnownDob(
  db: ScopedDb,
  session: Session,
  params: { subjectType: 'WORKER' | 'OWNER'; subjectId: string },
): Promise<string | undefined> {
  // Throws rather than returning undefined. Failing open here would hand a
  // company session a link whose gate pins on first visit — and the company
  // admin is the party the gate exists to exclude, so they would pin a date of
  // their choosing and take over a worker who had already submitted. No caller
  // does this today; the signature allows it, so the function refuses it.
  if (session.kind !== 'firm') {
    throw new Error('Only a firm session may seed the date-of-birth gate.');
  }

  if (params.subjectType === 'WORKER') {
    const rows = await db
      .select({ dateOfBirth: schema.workerRecords.dateOfBirth })
      .from(schema.workerRecords)
      .where(
        and(
          eq(schema.workerRecords.workerId, params.subjectId),
          eq(schema.workerRecords.isCurrent, true),
        ),
      )
      .limit(1);
    return rows[0]?.dateOfBirth ?? undefined;
  }

  const rows = await db
    .select({ dateOfBirth: schema.companyOwners.dateOfBirth })
    .from(schema.companyOwners)
    .where(eq(schema.companyOwners.id, params.subjectId))
    .limit(1);
  return rows[0]?.dateOfBirth ?? undefined;
}

async function readCompanyName(db: ScopedDb, companyId: string): Promise<string> {
  const rows = await db
    .select({ legalName: schema.companies.legalName })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  return rows[0]?.legalName ?? '';
}

/**
 * The subject's contact details — looked up by id AND company.
 *
 * The company predicate is not redundant with RLS. A firm holding grants on two
 * companies passes `can_read_company` for either, so a subject id from company A
 * paired with company B would resolve happily and mint an invite whose
 * `company_id` and `subject_id` disagree. The resulting subject session carries
 * B, and everything the person then submits is written under B and sealed with
 * B's data key — a worker's record filed under a company they do not work for.
 *
 * Both ids arrive from the client, so neither can be trusted to agree with the
 * other.
 */
async function readSubjectContact(
  db: ScopedDb,
  subjectType: 'WORKER' | 'OWNER',
  subjectId: string,
  companyId: string,
): Promise<{ phoneE164: string; preferredLocale: Locale } | null> {
  if (subjectType === 'WORKER') {
    const rows = await db
      .select({
        phoneE164: schema.workers.phoneE164,
        preferredLocale: schema.workers.preferredLocale,
      })
      .from(schema.workers)
      .where(and(eq(schema.workers.id, subjectId), eq(schema.workers.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  const rows = await db
    .select({
      phoneE164: schema.companyOwners.phoneE164,
      preferredLocale: schema.companyOwners.preferredLocale,
    })
    .from(schema.companyOwners)
    .where(
      and(
        eq(schema.companyOwners.id, subjectId),
        eq(schema.companyOwners.companyId, companyId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Sends the message and stamps `sent_at`.
 *
 * A send failure is not allowed to fail the request: the row exists and the
 * link is valid, so the recoverable state is "invited, not yet delivered" and
 * the fix is a resend. Throwing here would roll nothing back — the transaction
 * has already committed — and would only replace a resendable invite with a
 * 500.
 */
async function deliverInvite(
  session: Session,
  params: {
    inviteId: string;
    subjectType: 'WORKER' | 'OWNER';
    phoneE164: string;
    locale: Locale;
    companyName: string;
    url: string;
  },
): Promise<void> {
  try {
    const payload = {
      phoneE164: params.phoneE164,
      locale: params.locale,
      companyName: params.companyName,
      url: params.url,
    };
    if (params.subjectType === 'WORKER') {
      await sendWorkerInvite(payload);
    } else {
      await sendOwnerInvite(payload);
    }

    await withScope(session, async (db) => {
      await db
        .update(schema.invites)
        .set({ sentAt: new Date() })
        .where(eq(schema.invites.id, params.inviteId));
    });
  } catch (err) {
    console.error('[invite] delivery failed; the invite is valid and can be resent', err);
  }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * A submission, with the sensitive fields already sealed.
 *
 * They arrive encrypted rather than as plaintext because the resumable form
 * seals each answer at the screen that collects it — see `sealValue`. Taking
 * plaintext here would mean the wizard had to hold it, or decrypt its own draft
 * to submit, and every decryption in this system writes an audit row for a
 * reason.
 */
export interface WorkerSubmission {
  legalFirstName: string;
  legalMiddleName?: string | null;
  legalLastName: string;
  dateOfBirth: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  tinType: 'SSN' | 'ITIN';
  tin: SealedValue;
  bankName?: string | null;
  bankAccountType?: 'CHECKING' | 'SAVINGS' | null;
  routing?: SealedValue | null;
  account?: SealedValue | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactRelationship?: string | null;
}

/**
 * Writes worker_records v1 and marks the worker submitted (spec section 7.5).
 *
 * The version number and the superseding of any previous current row are done
 * by database triggers, not here. A client that picks its own version can
 * collide with a concurrent correction, and `is_current` is a column no
 * application role holds UPDATE on.
 */
export async function submitWorkerForm(
  session: SubjectSession,
  input: WorkerSubmission,
): Promise<string> {
  if (session.role !== 'WORKER') {
    throw new Error('Only a worker session may submit a worker record.');
  }

  const recordId = uuidv7();

  await withScope(session, async (db) => {
    await db.insert(schema.workerRecords).values({
      id: recordId,
      workerId: session.subjectId,
      companyId: session.companyId,
      // Assigned by the assign_worker_record_version trigger. Zero is the
      // sentinel it looks for.
      version: 0,
      isCurrent: true,

      legalFirstName: input.legalFirstName,
      legalMiddleName: input.legalMiddleName ?? null,
      legalLastName: input.legalLastName,
      dateOfBirth: input.dateOfBirth,

      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      email: input.email ?? null,
      phoneE164: input.phoneE164 ?? null,

      tinType: input.tinType,
      tinEnc: input.tin.enc,
      tinLast4: input.tin.last4,

      bankName: input.bankName ?? null,
      bankAccountType: input.bankAccountType ?? null,
      routingEnc: input.routing?.enc ?? null,
      routingLast4: input.routing?.last4 ?? null,
      accountEnc: input.account?.enc ?? null,
      accountLast4: input.account?.last4 ?? null,

      emergencyContactName: input.emergencyContactName ?? null,
      emergencyContactPhone: input.emergencyContactPhone ?? null,
      emergencyContactRelationship: input.emergencyContactRelationship ?? null,

      submittedVia: 'WORKER_FORM',
      submittedIp: session.ip ?? null,
      submittedUserAgent: session.userAgent ?? null,
    });

    await db
      .update(schema.workers)
      .set({ status: 'SUBMITTED', submittedAt: new Date() })
      .where(eq(schema.workers.id, session.subjectId));

    await audit(db, session, {
      action: 'FORM_SUBMITTED',
      companyId: session.companyId,
      targetType: 'worker_records',
      targetId: recordId,
      metadata: { workerId: session.subjectId },
    });
  });

  return recordId;
}

export interface OwnerSubmission {
  legalFirstName: string;
  legalMiddleName?: string | null;
  legalLastName: string;
  dateOfBirth: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  email?: string | null;
  tinType: 'SSN' | 'ITIN';
  tin: SealedValue;
}

/**
 * Fills in the owner's own half of their row.
 *
 * Unlike a worker there is no second table: an owner has no payroll fields, so
 * the company-entered and self-supplied columns are separated by column-level
 * grants on one table rather than by two tables. app_company can name the first
 * group and not the second, which is what makes `tin_last4` unreadable to them.
 */
export async function submitOwnerForm(
  session: SubjectSession,
  input: OwnerSubmission,
): Promise<void> {
  if (session.role !== 'OWNER') {
    throw new Error('Only an owner session may submit an owner record.');
  }

  await withScope(session, async (db) => {
    await db
      .update(schema.companyOwners)
      .set({
        legalFirstName: input.legalFirstName,
        legalMiddleName: input.legalMiddleName ?? null,
        legalLastName: input.legalLastName,
        dateOfBirth: input.dateOfBirth,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
        email: input.email ?? null,
        tinType: input.tinType,
        tinEnc: input.tin.enc,
        tinLast4: input.tin.last4,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      })
      .where(eq(schema.companyOwners.id, session.subjectId));

    await audit(db, session, {
      action: 'FORM_SUBMITTED',
      companyId: session.companyId,
      targetType: 'company_owners',
      targetId: session.subjectId,
    });
  });
}

/**
 * A firm correcting a worker record (spec section 7.8).
 *
 * Writes a new version; the old one is preserved and superseded by the trigger.
 * There is no UPDATE path on `worker_records` for any role, so this is the only
 * way a value can change, and the previous value remains readable — which is
 * what makes "the record said X when we filed" answerable a year later.
 */
export async function correctWorkerRecord(
  session: FirmSession,
  params: { workerId: string; companyId: string; reason: string },
  input: WorkerSubmission,
): Promise<string> {
  if (params.reason.trim().length < 10) {
    throw new Error('A correction reason of at least ten characters is required.');
  }

  const recordId = uuidv7();

  await withScope(session, async (db) => {
    await db.insert(schema.workerRecords).values({
      id: recordId,
      workerId: params.workerId,
      companyId: params.companyId,
      version: 0,
      isCurrent: true,
      legalFirstName: input.legalFirstName,
      legalMiddleName: input.legalMiddleName ?? null,
      legalLastName: input.legalLastName,
      dateOfBirth: input.dateOfBirth,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      email: input.email ?? null,
      phoneE164: input.phoneE164 ?? null,
      tinType: input.tinType,
      tinEnc: input.tin.enc,
      tinLast4: input.tin.last4,
      bankName: input.bankName ?? null,
      bankAccountType: input.bankAccountType ?? null,
      routingEnc: input.routing?.enc ?? null,
      routingLast4: input.routing?.last4 ?? null,
      accountEnc: input.account?.enc ?? null,
      accountLast4: input.account?.last4 ?? null,
      emergencyContactName: input.emergencyContactName ?? null,
      emergencyContactPhone: input.emergencyContactPhone ?? null,
      emergencyContactRelationship: input.emergencyContactRelationship ?? null,
      submittedVia: 'FIRM_ENTRY',
      submittedIp: session.ip ?? null,
      submittedUserAgent: session.userAgent ?? null,
    });

    await audit(db, session, {
      action: 'RECORD_CORRECTED',
      companyId: params.companyId,
      targetType: 'worker_records',
      targetId: recordId,
      reason: params.reason,
      metadata: { workerId: params.workerId },
    });
  });

  return recordId;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Worker status derives from the invite, the record, and the two signatures
 * (spec section 11). Computed rather than stored, for the same reason as the
 * company checklist: a stored flag and the rows it summarizes drift.
 */
export async function refreshWorkerStatus(
  session: Session,
  workerId: string,
): Promise<void> {
  await withScope(session, async (db) => {
    const [row] = await db
      .select({
        companyId: schema.workers.companyId,
        status: schema.workers.status,
        hasRecord: sql<boolean>`exists (
          select 1 from worker_records r
           where r.worker_id = ${schema.workers.id} and r.is_current
        )`,
        signatureCount: sql<number>`(
          select count(distinct document_type)::int from signatures s
           where s.subject_type = 'WORKER' and s.subject_id = ${schema.workers.id}
        )`,
      })
      .from(schema.workers)
      .where(eq(schema.workers.id, workerId))
      .limit(1);

    if (!row || row.status === 'ARCHIVED') return;

    // Both signatures are required: the direct deposit authorization and the
    // data accuracy certification (spec section 8, screens 15 and 16).
    const complete = row.hasRecord && row.signatureCount >= 2;
    if (!complete) return;

    await db
      .update(schema.workers)
      .set({ status: 'SUBMITTED' })
      .where(eq(schema.workers.id, workerId));
  });
}
