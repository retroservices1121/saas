'use server';

/**
 * The worker and owner form, screen by screen.
 *
 * Every action validates with the shared Zod schema, seals anything sensitive
 * before it touches storage, saves the draft, and advances. Nothing is held in
 * the client between screens — a phone that loses signal mid-form has already
 * persisted everything up to the last completed screen.
 */
import { redirect } from 'next/navigation';
import { requestContext } from '../../lib/auth/current';
import {
  clearInviteCookie,
  getCurrentSubject,
  getInviteToken,
} from '../../lib/auth/invite-session';
import { consumeInvite, loadDraft, saveDraft, verifyInviteDob } from '../../lib/invites';
import { sealValue, sealedFromJson, sealedToJson } from '../../lib/security/field-encryption';
import { submitOwnerForm, submitWorkerForm } from '../../lib/db/queries/subjects';
import { captureSignature } from '../../lib/esign/sign';
import { uploadDocument, UploadRejectedError } from '../../lib/documents';
import { withScope, schema } from '../../lib/db/scoped';
import {
  addressSchema,
  bankIdentitySchema,
  accountSchema,
  contactSchema,
  emergencyContactSchema,
  legalNameSchema,
  noteSchema,
  routingSchema,
  signatureSchema,
  tinTypeSchema,
  tinValueSchema,
  tinWarnings,
  verifyDobSchema,
} from '../../lib/validation/forms';
import {
  missingRequired,
  nextStep,
  type FormDraft,
  type StepId,
} from '../../lib/forms/wizard';
import type { Locale } from '../../i18n/request';

export interface FormState {
  /** i18n key. */
  error?: string;
  /** Non-blocking, e.g. the tax-ID type mismatch. */
  warnings?: string[];
  /** Per-field errors, keyed by field name. */
  fieldErrors?: Record<string, string>;
}

export async function verifyDobAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = await getInviteToken();
  if (!token) redirect('/i/expired');

  // Three numeric selects, not a native date picker — more reliable on older
  // Android, where the native picker reliably produces a date nobody intended
  // (spec section 8, screen 0).
  const year = String(formData.get('year') ?? '');
  const month = String(formData.get('month') ?? '').padStart(2, '0');
  const day = String(formData.get('day') ?? '').padStart(2, '0');

  const parsed = verifyDobSchema.safeParse({ dateOfBirth: `${year}-${month}-${day}` });
  if (!parsed.success) return { error: 'form.errors.dobFormat' };

  const context = await requestContext();
  const result = await verifyInviteDob(token, parsed.data.dateOfBirth, context);

  switch (result.status) {
    case 'unusable':
      redirect('/i/expired');
    // eslint-disable-next-line no-fallthrough
    case 'locked':
      redirect('/i/locked');
    // eslint-disable-next-line no-fallthrough
    case 'wrong':
      return {
        error: 'form.errors.dobWrong',
        warnings: [],
        fieldErrors: { remaining: String(result.remaining) },
      };
    case 'ok': {
      // The gate answer is the date of birth, so screen 3 is prefilled from it
      // and read-only. Saving it here is what makes that true.
      const current = await getCurrentSubject();
      if (current) {
        const { draft } = await loadDraft(current.session);
        await saveDraft(current.session, 'welcome', {
          ...draft,
          dateOfBirth: parsed.data.dateOfBirth,
        });
      }
      redirect('/form/welcome');
    }
  }
}

/** Reads the current draft, for a page that needs to prefill. */
export async function readDraft(): Promise<FormDraft> {
  const current = await getCurrentSubject();
  if (!current) return {};
  const { draft } = await loadDraft(current.session);
  return draft as FormDraft;
}

async function advance(step: StepId, patch: Partial<FormDraft>): Promise<never> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const { draft } = await loadDraft(current.session);
  const merged = { ...(draft as FormDraft), ...patch };

  const target = nextStep(current.invite.subjectType, step) ?? 'review';
  await saveDraft(current.session, target, merged);
  redirect(`/form/${target}`);
}

// ---------------------------------------------------------------------------
// One action per screen
// ---------------------------------------------------------------------------

export async function saveNameAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = legalNameSchema.safeParse({
    legalFirstName: formData.get('legalFirstName'),
    legalMiddleName: formData.get('legalMiddleName') || null,
    legalLastName: formData.get('legalLastName'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('name', parsed.data);
}

export async function saveDobAction(): Promise<FormState> {
  // Read-only confirmation of the value from the gate. There is nothing to
  // validate; the screen exists so the person sees what was recorded.
  return advance('dob', {});
}

export async function saveAddressAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = addressSchema.safeParse({
    addressLine1: formData.get('addressLine1'),
    addressLine2: formData.get('addressLine2') || null,
    city: formData.get('city'),
    state: formData.get('state'),
    postalCode: formData.get('postalCode'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('address', parsed.data);
}

export async function saveContactAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = contactSchema.safeParse({
    email: formData.get('email') ?? '',
    phoneE164: formData.get('phoneE164'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('contact', parsed.data);
}

export async function saveEmergencyAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = emergencyContactSchema.safeParse({
    emergencyContactName: formData.get('emergencyContactName') || null,
    emergencyContactPhone: formData.get('emergencyContactPhone') || '',
    emergencyContactRelationship: formData.get('emergencyContactRelationship') || null,
  });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('emergency', parsed.data);
}

export async function saveTinTypeAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = tinTypeSchema.safeParse({ tinType: formData.get('tinType') });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('tin-type', parsed.data);
}

/**
 * The tax ID. Sealed here and never held anywhere else.
 *
 * The type mismatch produces a warning rather than an error (spec section 10),
 * and the warning does not stop the advance — the person filling in the form
 * knows which document they are holding.
 */
export async function saveTinAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const { draft } = await loadDraft(current.session);
  const tinType = (draft as FormDraft).tinType;
  if (!tinType) redirect('/form/tin-type');

  const parsed = tinValueSchema(tinType).safeParse({ tin: formData.get('tin') });
  if (!parsed.success) return fieldErrors(parsed.error);

  const sealed = await sealValue(current.session, current.session.companyId, parsed.data.tin);

  // The type mismatch is a warning, and a warning does not hold anyone on the
  // screen — the person filling in the form knows which document they hold.
  // It is carried forward and shown on the review screen instead.
  const warnings = tinWarnings(tinType, parsed.data.tin);
  return advance('tin', { tin: sealedToJson(sealed), tinWarnings: warnings });
}

export async function saveBankAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = bankIdentitySchema.safeParse({
    bankName: formData.get('bankName'),
    bankAccountType: formData.get('bankAccountType'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);
  return advance('bank', parsed.data);
}

export async function saveRoutingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const parsed = routingSchema.safeParse({ routingNumber: formData.get('routingNumber') });
  if (!parsed.success) return fieldErrors(parsed.error);

  const sealed = await sealValue(
    current.session,
    current.session.companyId,
    parsed.data.routingNumber,
  );
  return advance('routing', { routing: sealedToJson(sealed) });
}

export async function saveAccountAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const parsed = accountSchema.safeParse({
    accountNumber: formData.get('accountNumber'),
    accountNumberConfirm: formData.get('accountNumberConfirm'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const sealed = await sealValue(
    current.session,
    current.session.companyId,
    parsed.data.accountNumber,
  );
  return advance('account', { account: sealedToJson(sealed) });
}

export async function skipCheckAction(): Promise<FormState> {
  return advance('check', {});
}

/**
 * The voided check photo (spec section 8, screen 12).
 *
 * The image is downscaled to 2000px in the browser before it is sent — a modern
 * phone camera produces 4-6 MB, and a worker on a cellular connection in a
 * parking lot is the person least able to afford uploading it. Downscaling also
 * strips EXIF, which on a phone photo includes GPS coordinates: a worker
 * photographing a check at their kitchen table should not be handing over their
 * home address as a side effect.
 *
 * The bytes arrive through this action rather than by a presigned PUT direct to
 * the bucket. A presigned PUT would save one hop, at the cost of a URL that
 * writes to storage without an authenticated request behind it — and this is
 * the one upload path reachable by someone with no account.
 */
export async function uploadVoidedCheckAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'documents.errors.empty' };
  }

  try {
    const uploaded = await uploadDocument(current.session, {
      companyId: current.session.companyId,
      subjectType: current.invite.subjectType,
      subjectId: current.session.subjectId,
      // FIRM_ONLY by the rule, by the doc type, and by the database trigger.
      // Three mechanisms, because a voided check is a full account number in an
      // image and the company must never see it.
      docType: 'VOIDED_CHECK',
      label: 'Voided check',
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });

    return advance('check', { voidedCheckDocumentId: uploaded.id });
  } catch (err) {
    if (err instanceof UploadRejectedError) return { error: err.key };
    throw err;
  }
}

/**
 * The observations screen. Worker-authored notes are FIRM_ONLY, forced by a
 * trigger, and the screen says so — a worker typing "my ITIN application is
 * still pending" must know their employer will not read it.
 */
export async function saveNoteAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const parsed = noteSchema.safeParse({ body: formData.get('body') ?? '' });
  if (!parsed.success) return fieldErrors(parsed.error);

  if (parsed.data.body.trim()) {
    await withScope(current.session, async (db) => {
      await db.insert(schema.notes).values({
        companyId: current.session.companyId,
        subjectType: current.invite.subjectType,
        subjectId: current.session.subjectId,
        body: parsed.data.body.trim(),
        authorRole: current.session.role,
        // The trigger forces FIRM_ONLY for a subject author regardless. Setting
        // it here too means the intent is visible at the call site.
        visibility: 'FIRM_ONLY',
      });
    });
  }

  return advance('notes', { note: parsed.data.body.trim() || undefined });
}

/** The review screen's continue button. Nothing to save; it gates the signatures. */
export async function confirmReviewAction(): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const { draft } = await loadDraft(current.session);
  const missing = missingRequired(current.invite.subjectType, draft as FormDraft);
  if (missing.length > 0) redirect(`/form/${missing[0]}`);

  return advance('review', {});
}

// ---------------------------------------------------------------------------
// Signatures, and the submission they gate
// ---------------------------------------------------------------------------

export async function signAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const parsed = signatureSchema.safeParse({
    typedName: formData.get('typedName'),
    consentToElectronic: formData.get('consentToElectronic') === 'on',
    documentType: formData.get('documentType'),
    documentVersion: formData.get('documentVersion'),
    documentLocale: formData.get('documentLocale'),
  });
  if (!parsed.success) return fieldErrors(parsed.error);

  const { draft } = await loadDraft(current.session);
  const typed = draft as FormDraft;
  const expectedName = [typed.legalFirstName, typed.legalLastName].filter(Boolean).join(' ');

  const step: StepId =
    parsed.data.documentType === 'DIRECT_DEPOSIT_AUTH' ? 'sign-deposit' : 'sign-accuracy';

  await captureSignature(current.session, {
    subjectType: current.invite.subjectType,
    subjectId: current.session.subjectId,
    companyId: current.session.companyId,
    companyName: current.invite.companyName,
    documentType: parsed.data.documentType,
    locale: parsed.data.documentLocale as Locale,
    typedName: parsed.data.typedName,
    consentToElectronic: true,
    expectedName: expectedName || undefined,
  });

  // The data accuracy certification is the last one in both flows, so it is
  // what triggers the write. Submitting before both signatures exist would
  // produce a record nobody has certified.
  if (parsed.data.documentType === 'DATA_ACCURACY') {
    await submitFromDraft();
    return redirect('/form/done');
  }

  return advance(step, {});
}

/**
 * Writes the record from the sealed draft and consumes the invite.
 *
 * The sealed values move across untouched. Nothing here decrypts anything, so
 * the submission produces no REVEAL audit rows — because no reveal happened.
 */
async function submitFromDraft(): Promise<void> {
  const current = await getCurrentSubject();
  if (!current) redirect('/i/expired');

  const { draft } = await loadDraft(current.session);
  const typed = draft as FormDraft;

  if (!typed.tin || !typed.tinType || !typed.legalFirstName || !typed.legalLastName) {
    redirect('/form/review');
  }
  if (!typed.dateOfBirth) redirect('/form/dob');

  const common = {
    legalFirstName: typed.legalFirstName,
    legalMiddleName: typed.legalMiddleName ?? null,
    legalLastName: typed.legalLastName,
    dateOfBirth: typed.dateOfBirth,
    addressLine1: typed.addressLine1 ?? null,
    addressLine2: typed.addressLine2 ?? null,
    city: typed.city ?? null,
    state: typed.state ?? null,
    postalCode: typed.postalCode ?? null,
    email: typed.email ?? null,
    tinType: typed.tinType,
    tin: sealedFromJson(typed.tin),
  };

  if (current.invite.subjectType === 'WORKER') {
    await submitWorkerForm(current.session, {
      ...common,
      phoneE164: typed.phoneE164 ?? null,
      bankName: typed.bankName ?? null,
      bankAccountType: typed.bankAccountType ?? null,
      routing: typed.routing ? sealedFromJson(typed.routing) : null,
      account: typed.account ? sealedFromJson(typed.account) : null,
      emergencyContactName: typed.emergencyContactName ?? null,
      emergencyContactPhone: typed.emergencyContactPhone ?? null,
      emergencyContactRelationship: typed.emergencyContactRelationship ?? null,
    });
  } else {
    await submitOwnerForm(current.session, common);
  }

  // Consuming clears the draft, which is what removes the second copy of every
  // sealed answer once the real columns hold them.
  await consumeInvite(current.session);
}

/** After the done screen. The link is already spent; this drops the cookie. */
export async function finishAction(): Promise<FormState> {
  await clearInviteCookie();
  return redirect('/');
}

// ---------------------------------------------------------------------------

function fieldErrors(error: { issues: { path: (string | number)[]; message: string }[] }): FormState {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_');
    // First error per field wins: a field with three failing rules should say
    // one thing, and the first is the one closest to what was typed.
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { fieldErrors: errors, error: 'form.errors.check' };
}
