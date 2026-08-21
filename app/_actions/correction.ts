'use server';

/**
 * Corrections (spec section 7.8).
 *
 * "If a value is wrong, the firm creates a correction, which writes a new
 * worker_records version and preserves the old one."
 *
 * The design decision worth stating: a sensitive field the firm is not changing
 * is carried forward as ciphertext, byte for byte. Correcting a misspelled
 * street name therefore involves no decryption at all — no plaintext, no
 * REVEAL audit row, nothing on the wire.
 *
 * The obvious alternative is to decrypt the record, render it into the form,
 * and re-encrypt whatever comes back. That would turn every address fix into a
 * full disclosure of a tax ID and a bank account to a browser, and it would
 * bury three REVEAL rows inside an event that is not a reveal. Carrying the
 * ciphertext costs nothing and means the audit trail says what happened.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireFirm } from '../../lib/auth/current';
import { auditNow } from '../../lib/audit';
import { withScope, schema } from '../../lib/db/scoped';
import { correctWorkerRecord } from '../../lib/db/queries/subjects';
import { sealValue, type SealedValue } from '../../lib/security/field-encryption';
import {
  addressSchema,
  contactSchema,
  legalNameSchema,
  dobSchema,
} from '../../lib/validation/forms';
import { validateBankAccount, validateRouting, validateTin } from '../../lib/validation/identity';

export interface CorrectionState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const correctionSchema = legalNameSchema
  .merge(addressSchema)
  .merge(contactSchema)
  .merge(
    z.object({
      dateOfBirth: dobSchema,
      bankName: z.string().trim().max(200).optional().nullable(),
      bankAccountType: z.enum(['CHECKING', 'SAVINGS']).optional().nullable(),
      emergencyContactName: z.string().trim().max(200).optional().nullable(),
      emergencyContactRelationship: z.string().trim().max(100).optional().nullable(),
      reason: z
        .string()
        .trim()
        .min(10, { message: 'validation.reveal.reasonTooShort' })
        .max(500),
    }),
  );

export async function correctWorkerAction(
  companyId: string,
  workerId: string,
  _previous: CorrectionState,
  formData: FormData,
): Promise<CorrectionState> {
  const { session } = await requireFirm();

  const parsed = correctionSchema.safeParse({
    legalFirstName: formData.get('legalFirstName'),
    legalMiddleName: formData.get('legalMiddleName') || null,
    legalLastName: formData.get('legalLastName'),
    dateOfBirth: formData.get('dateOfBirth'),
    addressLine1: formData.get('addressLine1'),
    addressLine2: formData.get('addressLine2') || null,
    city: formData.get('city'),
    state: formData.get('state'),
    postalCode: formData.get('postalCode'),
    email: formData.get('email') ?? '',
    phoneE164: formData.get('phoneE164'),
    bankName: formData.get('bankName') || null,
    bankAccountType: formData.get('bankAccountType') || null,
    emergencyContactName: formData.get('emergencyContactName') || null,
    emergencyContactRelationship: formData.get('emergencyContactRelationship') || null,
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      if (!(key in errors)) errors[key] = issue.message;
    }
    return { fieldErrors: errors, error: 'firm.errors.check' };
  }

  // The current version, ciphertext included. Read under the caller's own
  // scope, so a worker id outside this firm's grants resolves to nothing.
  const current = await withScope(session, async (db) => {
    const rows = await db
      .select()
      .from(schema.workerRecords)
      .where(eq(schema.workerRecords.workerId, workerId))
      .limit(1);
    return rows.find((row) => row.isCurrent) ?? null;
  });

  if (!current?.tinEnc || !current.tinLast4) return { error: 'firm.correct.noRecord' };

  // The bound `companyId` is attacker-controlled — a server action argument is
  // an HTTP parameter however it was bound in the component — and RLS alone
  // does not catch a mismatch here: `worker_records_insert` asks only whether
  // the *stated* company is in scope, which it would be for any company the
  // firm holds a grant on.
  //
  // Left unchecked, a firm user with grants on A and B could file worker A's
  // new current record under company B, sealed with B's data key. That breaks
  // two things quietly: revoking the grant on A no longer removes access to
  // that worker's tax ID, and destroying A's data key no longer shreds it.
  //
  // Everything below therefore uses the company on the record, and a mismatch
  // is refused and recorded rather than silently corrected.
  if (current.companyId !== companyId) {
    await auditNow(session, {
      action: 'SECURITY_VIOLATION',
      companyId: current.companyId,
      targetType: 'worker_records',
      targetId: current.id,
      metadata: {
        guard: 'correctWorkerAction',
        claimedCompanyId: companyId,
        actualCompanyId: current.companyId,
      },
    });
    return { error: 'firm.correct.noRecord' };
  }

  const fieldErrors: Record<string, string> = {};

  /**
   * Either the new value, sealed, or the existing ciphertext untouched.
   *
   * An empty input means "leave it alone", which is why the form shows the
   * masked value as the placeholder rather than pre-filling anything: a
   * pre-filled field invites someone to retype what is already there, and
   * retyping a tax ID from memory is how a correction introduces an error.
   */
  const resolve = async (
    typed: string,
    existingEnc: Buffer | null,
    existingLast4: string | null,
    validate: (value: string) => { ok: boolean; errors: { key: string }[] },
    field: string,
  ): Promise<SealedValue | null> => {
    if (!typed.trim()) {
      return existingEnc && existingLast4
        ? { enc: existingEnc, last4: existingLast4 }
        : null;
    }
    const result = validate(typed);
    if (!result.ok) {
      fieldErrors[field] = `validation.${result.errors[0]!.key}`;
      return null;
    }
    return sealValue(session, companyId, typed.replace(/\D/g, ''));
  };

  const tin = await resolve(
    String(formData.get('tin') ?? ''),
    current.tinEnc,
    current.tinLast4,
    (value) => validateTin(current.tinType, value),
    'tin',
  );
  const routing = await resolve(
    String(formData.get('routingNumber') ?? ''),
    current.routingEnc,
    current.routingLast4,
    validateRouting,
    'routingNumber',
  );
  const account = await resolve(
    String(formData.get('accountNumber') ?? ''),
    current.accountEnc,
    current.accountLast4,
    (value) => validateBankAccount(value),
    'accountNumber',
  );

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, error: 'firm.errors.check' };
  }
  if (!tin) return { error: 'firm.correct.noRecord' };

  await correctWorkerRecord(
    session,
    { workerId, companyId, reason: parsed.data.reason },
    {
      legalFirstName: parsed.data.legalFirstName,
      legalMiddleName: parsed.data.legalMiddleName ?? null,
      legalLastName: parsed.data.legalLastName,
      dateOfBirth: parsed.data.dateOfBirth,
      addressLine1: parsed.data.addressLine1,
      addressLine2: parsed.data.addressLine2 ?? null,
      city: parsed.data.city,
      state: parsed.data.state,
      postalCode: parsed.data.postalCode,
      email: parsed.data.email ?? null,
      phoneE164: parsed.data.phoneE164,
      tinType: current.tinType,
      tin,
      bankName: parsed.data.bankName ?? null,
      bankAccountType: parsed.data.bankAccountType ?? null,
      routing,
      account,
      emergencyContactName: parsed.data.emergencyContactName ?? null,
      // Carried forward: the correction form does not ask for it, and dropping
      // a value because a form omitted the field is data loss disguised as an
      // edit.
      emergencyContactPhone: current.emergencyContactPhone,
      emergencyContactRelationship: parsed.data.emergencyContactRelationship ?? null,
    },
  );

  revalidatePath(`/firm/companies/${companyId}/workers/${workerId}`);
  redirect(`/firm/companies/${companyId}/workers/${workerId}?corrected=1`);
}
