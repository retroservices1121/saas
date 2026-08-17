'use server';

/**
 * Firm-side actions: onboarding a company, inviting subjects, revealing a
 * single field, and correcting a record.
 *
 * Every one of them re-derives the session from the cookie rather than trusting
 * anything in the form. A company id in a hidden input is a company id an
 * attacker can change; the scope it is checked against comes from
 * firm_company_grants, resolved server-side on this request.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireFirm, requireFirmAdmin } from '../../lib/auth/current';
import {
  createCompany,
  inviteFirmStaff,
  revokeGrant,
  setStaffStatus,
} from '../../lib/db/queries/firm';
import { inviteOwner, inviteWorker, resendInvite } from '../../lib/db/queries/subjects';
import { verifyStepUp } from '../../lib/auth/staff-auth';
import { decryptField } from '../../lib/security/field-encryption';
import { sendStaffSetupEmail } from '../../lib/notifications';
import {
  createCompanySchema,
  emailSchema,
  inviteOwnerSchema,
  inviteWorkerSchema,
  revealSchema,
} from '../../lib/validation/forms';
import { withScope, schema } from '../../lib/db/scoped';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export interface ActionResult {
  error?: string;
  fieldErrors?: Record<string, string>;
}

function fieldErrors(error: {
  issues: { path: (string | number)[]; message: string }[];
}): ActionResult {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_');
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { fieldErrors: errors, error: 'firm.errors.check' };
}

// ---------------------------------------------------------------------------
// 7.1 Onboard a company
// ---------------------------------------------------------------------------

export async function createCompanyAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireFirmAdmin();

  const parsed = createCompanySchema.safeParse({
    legalName: formData.get('legalName'),
    dbaName: formData.get('dbaName') || null,
    ein: formData.get('ein') || null,
    addressLine1: formData.get('addressLine1') || null,
    addressLine2: formData.get('addressLine2') || null,
    city: formData.get('city') || null,
    state: formData.get('state') || null,
    postalCode: formData.get('postalCode') || null,
    contactEmail: formData.get('contactEmail'),
    contactPhone: formData.get('contactPhone') || null,
    adminName: formData.get('adminName'),
    adminEmail: formData.get('adminEmail'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const created = await createCompany(session, parsed.data);

  // Sent after the transaction commits. An email carrying a live setup link for
  // a company that failed to create is worse than a company with no email sent,
  // which is recoverable by re-sending.
  await sendStaffSetupEmail({
    to: parsed.data.adminEmail,
    locale: 'en',
    name: parsed.data.adminName,
    companyName: parsed.data.legalName,
    url: `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/setup/${created.setupToken}`,
  });

  revalidatePath('/firm');
  redirect(`/firm/companies/${created.companyId}`);
}

export async function revokeGrantAction(companyId: string): Promise<void> {
  const { session } = await requireFirmAdmin();
  await revokeGrant(session, companyId);
  revalidatePath('/firm');
  redirect('/firm');
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export async function firmInviteWorkerAction(
  companyId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireFirm();

  const parsed = inviteWorkerSchema.safeParse({
    displayName: formData.get('displayName'),
    workerType: formData.get('workerType'),
    phoneE164: formData.get('phoneE164'),
    preferredLocale: formData.get('preferredLocale'),
    jobTitle: formData.get('jobTitle') || null,
    startDate: formData.get('startDate') || null,
    payType: formData.get('payType') || null,
    payFrequency: formData.get('payFrequency') || null,
    workState: formData.get('workState') || null,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  await inviteWorker(session, companyId, parsed.data);
  revalidatePath(`/firm/companies/${companyId}/workers`);
  redirect(`/firm/companies/${companyId}/workers`);
}

export async function firmInviteOwnerAction(
  companyId: string,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireFirm();

  const parsed = inviteOwnerSchema.safeParse({
    displayName: formData.get('displayName'),
    ownershipPercent: formData.get('ownershipPercent') || null,
    phoneE164: formData.get('phoneE164'),
    preferredLocale: formData.get('preferredLocale'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  await inviteOwner(session, companyId, parsed.data);
  revalidatePath(`/firm/companies/${companyId}/owners`);
  redirect(`/firm/companies/${companyId}/owners`);
}

/** A lost text message, an expired link, or a correction the worker makes themselves. */
export async function resendInviteAction(params: {
  companyId: string;
  subjectType: 'WORKER' | 'OWNER';
  subjectId: string;
}): Promise<void> {
  const { session } = await requireFirm();
  await resendInvite(session, params);
  revalidatePath(`/firm/companies/${params.companyId}`);
}

// ---------------------------------------------------------------------------
// 7.6 Reveal
// ---------------------------------------------------------------------------

export interface RevealResult {
  error?: string;
  /** Present only on success, and only for the 30 seconds the client shows it. */
  value?: string;
  field?: string;
}

/**
 * Reveals one field of one record.
 *
 * Single field, single record. There is no bulk variant in this codebase and
 * adding one would defeat the reveal-with-reason model entirely — a firm user
 * who can export forty tax IDs with one reason has not explained anything.
 *
 * Order: re-authenticate, then decrypt. `decryptField` writes the audit row
 * before it produces plaintext, so a crash mid-reveal leaves the record of the
 * attempt behind. The reverse order would let a deliberately induced crash
 * yield plaintext with no trace.
 */
export async function revealAction(
  _previous: RevealResult,
  formData: FormData,
): Promise<RevealResult> {
  const { session, user } = await requireFirm();

  const parsed = revealSchema.safeParse({
    field: formData.get('field'),
    recordType: formData.get('recordType'),
    recordId: formData.get('recordId'),
    reason: formData.get('reason'),
    totpCode: formData.get('totpCode'),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: first?.message ?? 'firm.errors.check' };
  }

  const stepUp = await verifyStepUp(user.userId, parsed.data.totpCode, user.sessionId);
  if (!stepUp) return { error: 'auth.errors.totpInvalid' };

  const { field, recordType, recordId, reason } = parsed.data;

  // The ciphertext is fetched under the caller's own scope, so a record id from
  // another firm's company resolves to nothing here — before any decryption is
  // attempted, and without confirming that the id exists.
  const found = await withScope(session, async (db) => {
    if (recordType === 'WORKER_RECORD') {
      const rows = await db
        .select({
          companyId: schema.workerRecords.companyId,
          tin: schema.workerRecords.tinEnc,
          routing: schema.workerRecords.routingEnc,
          account: schema.workerRecords.accountEnc,
        })
        .from(schema.workerRecords)
        .where(eq(schema.workerRecords.id, recordId))
        .limit(1);
      return rows[0] ?? null;
    }
    if (recordType === 'OWNER') {
      const rows = await db
        .select({
          companyId: schema.companyOwners.companyId,
          tin: schema.companyOwners.tinEnc,
        })
        .from(schema.companyOwners)
        .where(eq(schema.companyOwners.id, recordId))
        .limit(1);
      const row = rows[0];
      return row ? { ...row, routing: null, account: null } : null;
    }
    const rows = await db
      .select({
        companyId: schema.companies.id,
        routing: schema.companies.bankRoutingEnc,
        account: schema.companies.bankAccountEnc,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, recordId))
      .limit(1);
    const row = rows[0];
    return row ? { ...row, tin: null } : null;
  });

  if (!found) return { error: 'firm.errors.notFound' };

  const ciphertext =
    field === 'tin' ? found.tin : field === 'routing' ? found.routing : found.account;
  if (!ciphertext) return { error: 'firm.errors.noValue' };

  const value = await decryptField(ciphertext, {
    session,
    action: field === 'tin' ? 'REVEAL_TIN' : 'REVEAL_BANK',
    reason,
    targetType: recordType === 'WORKER_RECORD' ? 'worker_records' : 'company_owners',
    targetId: recordId,
    companyId: found.companyId,
  });

  // Formatted here so the client receives exactly the string it will display
  // for thirty seconds and nothing more.
  const display =
    field === 'tin' && value.length === 9
      ? `${value.slice(0, 3)}-${value.slice(3, 5)}-${value.slice(5)}`
      : value;

  return { value: display, field };
}

// ---------------------------------------------------------------------------
// Firm staff (spec section 2)
// ---------------------------------------------------------------------------

const inviteStaffSchema = z.object({
  name: z.string().trim().min(1, { message: 'validation.adminName.required' }).max(200),
  email: emailSchema,
  role: z.enum(['FIRM_ADMIN', 'FIRM_STAFF']),
});

export async function inviteStaffAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireFirmAdmin();

  const parsed = inviteStaffSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    role: formData.get('role'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const invited = await inviteFirmStaff(session, parsed.data);

  await sendStaffSetupEmail({
    to: parsed.data.email,
    locale: 'en',
    name: parsed.data.name,
    url: `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/setup/${invited.setupToken}`,
  });

  revalidatePath('/firm/staff');
  redirect('/firm/staff?invited=1');
}

export async function setStaffStatusAction(
  userId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  const { session } = await requireFirmAdmin();
  await setStaffStatus(session, userId, status);
  revalidatePath('/firm/staff');
}
