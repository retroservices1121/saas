'use server';

/**
 * Company-side actions.
 *
 * Everything here is scoped to the caller's own company, which is not a
 * parameter — it comes from the session. There is no company id in any of these
 * signatures, so there is nothing for a tampered form to change.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCompany, requireCompanyAdmin } from '../../lib/auth/current';
import {
  recomputeOnboardingStatus,
  revealCompanyBankField,
  updateCompanyBanking,
  updateCompanyProfile,
} from '../../lib/db/queries/company-profile';
import { inviteOwner, inviteWorker } from '../../lib/db/queries/subjects';
import { uploadDocument, UploadRejectedError, type DocType } from '../../lib/documents';
import { captureSignature } from '../../lib/esign/sign';
import { EmployerControlledMailboxError } from '../../lib/notifications';
import {
  companyBankingSchema,
  companyProfileSchema,
  inviteOwnerSchema,
  inviteWorkerSchema,
} from '../../lib/validation/forms';
import { withScope, schema } from '../../lib/db/scoped';
import { eq } from 'drizzle-orm';
import type { Locale } from '../../i18n/request';

export interface ActionResult {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
}

function fieldErrors(error: {
  issues: { path: (string | number)[]; message: string }[];
}): ActionResult {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_');
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { fieldErrors: errors, error: 'company.errors.check' };
}

// ---------------------------------------------------------------------------
// 7.2 Company profile
// ---------------------------------------------------------------------------

export async function saveProfileAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireCompanyAdmin();

  const parsed = companyProfileSchema.safeParse({
    legalName: formData.get('legalName'),
    dbaName: formData.get('dbaName') || null,
    ein: formData.get('ein') || null,
    addressLine1: formData.get('addressLine1'),
    addressLine2: formData.get('addressLine2') || null,
    city: formData.get('city'),
    state: formData.get('state'),
    postalCode: formData.get('postalCode'),
    contactEmail: formData.get('contactEmail'),
    contactPhone: formData.get('contactPhone'),
    operatingStates: formData.getAll('operatingStates').map(String),
    wcStatus: formData.get('wcStatus'),
    wcPolicyNumber: formData.get('wcPolicyNumber') || null,
    wcCarrier: formData.get('wcCarrier') || null,
    wcExpiresOn: formData.get('wcExpiresOn') || null,
    disabilityPolicyNumber: formData.get('disabilityPolicyNumber') || null,
    disabilityCarrier: formData.get('disabilityCarrier') || null,
    disabilityExpiresOn: formData.get('disabilityExpiresOn') || null,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  await updateCompanyProfile(session, parsed.data);
  revalidatePath('/company');
  return { ok: true };
}

export async function saveBankingAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireCompanyAdmin();

  const parsed = companyBankingSchema.safeParse({
    bankName: formData.get('bankName'),
    routingNumber: formData.get('routingNumber'),
    accountNumber: formData.get('accountNumber'),
    accountNumberConfirm: formData.get('accountNumberConfirm'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  await updateCompanyBanking(session, parsed.data);
  await recomputeOnboardingStatus(session);
  revalidatePath('/company');
  redirect('/company/banking?saved=1');
}

export interface CompanyRevealResult {
  error?: string;
  value?: string;
}

/**
 * The company's own bank details.
 *
 * The single case where a company session decrypts anything, and the guard in
 * lib/security/field-encryption.ts matches on the exact target type and on both
 * ids agreeing with the session — so this cannot be pointed at a worker record
 * by changing an argument. COMPANY_STAFF is excluded; a reason is still
 * required and still audited.
 */
export async function revealCompanyBankAction(
  _previous: CompanyRevealResult,
  formData: FormData,
): Promise<CompanyRevealResult> {
  const { session } = await requireCompanyAdmin();

  const field = formData.get('field') === 'routing' ? 'routing' : 'account';
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 10) return { error: 'validation.reveal.reasonTooShort' };

  try {
    const value = await revealCompanyBankField(session, field, reason);
    if (!value) return { error: 'company.errors.noValue' };
    return { value };
  } catch {
    return { error: 'company.errors.revealFailed' };
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export async function companyInviteWorkerAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireCompany();

  const parsed = inviteWorkerSchema.safeParse({
    displayName: formData.get('displayName'),
    workerType: formData.get('workerType'),
    inviteEmail: formData.get('inviteEmail'),
    phoneE164: formData.get('phoneE164') || '',
    preferredLocale: formData.get('preferredLocale'),
    jobTitle: formData.get('jobTitle') || null,
    startDate: formData.get('startDate') || null,
    payType: formData.get('payType') || null,
    payFrequency: formData.get('payFrequency') || null,
    workState: formData.get('workState') || null,
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  try {
    await inviteWorker(session, session.companyId, parsed.data);
  } catch (err) {
    if (err instanceof EmployerControlledMailboxError) {
      return { fieldErrors: { inviteEmail: 'company.errors.employerMailbox' } };
    }
    throw err;
  }

  revalidatePath('/company/workers');
  redirect('/company/workers');
}

export async function companyInviteOwnerAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireCompanyAdmin();

  const parsed = inviteOwnerSchema.safeParse({
    displayName: formData.get('displayName'),
    ownershipPercent: formData.get('ownershipPercent') || null,
    inviteEmail: formData.get('inviteEmail'),
    phoneE164: formData.get('phoneE164') || '',
    preferredLocale: formData.get('preferredLocale'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  try {
    await inviteOwner(session, session.companyId, parsed.data);
  } catch (err) {
    if (err instanceof EmployerControlledMailboxError) {
      return { fieldErrors: { inviteEmail: 'company.errors.employerMailbox' } };
    }
    throw err;
  }

  revalidatePath('/company/owners');
  redirect('/company/owners');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Company document upload.
 *
 * The file arrives through the server action rather than by presigned PUT.
 * These are articles of incorporation and insurance certificates uploaded from
 * a desktop, not phone photos on a cellular connection, and routing them
 * through the server means the size and content-type checks happen somewhere a
 * client cannot skip.
 */
export async function uploadCompanyDocumentAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session } = await requireCompanyAdmin();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'documents.errors.empty' };
  }

  const docType = String(formData.get('docType') ?? 'OTHER') as DocType;
  const label = String(formData.get('label') ?? '').trim() || null;

  try {
    await uploadDocument(session, {
      companyId: session.companyId,
      subjectType: 'COMPANY',
      subjectId: session.companyId,
      docType,
      label,
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  } catch (err) {
    if (err instanceof UploadRejectedError) return { error: err.key };
    throw err;
  }

  await recomputeOnboardingStatus(session);
  revalidatePath('/company/documents');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 7.2 Company certification
// ---------------------------------------------------------------------------

export async function signCompanyCertificationAction(
  locale: Locale,
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { session, user } = await requireCompanyAdmin();

  const typedName = String(formData.get('typedName') ?? '').trim();
  const consent = formData.get('consentToElectronic') === 'on';
  if (!typedName) return { fieldErrors: { typedName: 'validation.signature.nameRequired' } };
  if (!consent) {
    return { fieldErrors: { consentToElectronic: 'validation.signature.consentRequired' } };
  }

  const companyName = await withScope(session, async (db) => {
    const rows = await db
      .select({ legalName: schema.companies.legalName })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);
    return rows[0]?.legalName ?? '';
  });

  await captureSignature(session, {
    subjectType: 'COMPANY',
    subjectId: session.companyId,
    companyId: session.companyId,
    companyName,
    documentType: 'COMPANY_CERTIFICATION',
    locale,
    typedName,
    consentToElectronic: true,
    expectedName: user.name,
  });

  await recomputeOnboardingStatus(session);
  revalidatePath('/company');
  redirect('/company');
}
