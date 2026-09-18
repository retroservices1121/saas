/**
 * Zod schemas for every form the platform accepts, shared client and server
 * (spec section 3).
 *
 * The schemas delegate to lib/validation/identity.ts rather than restating its
 * rules as regexes. A Zod `.regex()` for an SSN would be a second, subtly
 * different copy of the rule, and the copy that drifts is always the one the
 * server uses.
 *
 * Error messages are i18n keys. Zod's default messages are English strings
 * baked into the library, so every `message` here is a key that
 * messages/{en,es}.json resolves — otherwise a Spanish-speaking worker gets
 * "String must contain at least 1 character(s)".
 */
import { z } from 'zod';
import {
  US_STATES,
  digitsOnly,
  validateBankAccount,
  validateDob,
  validateEin,
  validateEmail,
  validatePhone,
  validatePostalCode,
  validateRouting,
  validateTin,
  type FieldResult,
} from './identity';

/** Bridges a FieldResult into Zod, preserving the i18n key. */
function refineWith(
  fn: (value: string) => FieldResult,
): (value: string, ctx: z.RefinementCtx) => void {
  return (value, ctx) => {
    const result = fn(value);
    for (const issue of result.errors) {
      // The validators return bare keys ('routing.checksum'); the forms look
      // them up under `validation.`, as the schemas below do for their own.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `validation.${issue.key}`,
        params: issue.values,
      });
    }
  };
}

const required = (key: string) => z.string().trim().min(1, { message: key });

export const phoneSchema = required('validation.phone.required')
  .superRefine(refineWith(validatePhone))
  .transform((v) => validatePhone(v).normalized ?? v);

export const emailSchema = required('validation.email.required')
  .superRefine(refineWith(validateEmail))
  .transform((v) => validateEmail(v).normalized ?? v);

export const optionalEmailSchema = z
  .union([z.literal(''), emailSchema])
  .transform((v) => (v === '' ? null : v));

export const stateSchema = z.enum(US_STATES, {
  errorMap: () => ({ message: 'validation.state.unknown' }),
});

export const postalCodeSchema = required('validation.postalCode.required')
  .superRefine(refineWith(validatePostalCode))
  .transform((v) => validatePostalCode(v).normalized ?? v);

export const dobSchema = required('validation.dob.required')
  .superRefine(refineWith((v) => validateDob(v)))
  .transform((v) => validateDob(v).normalized ?? v);

export const einSchema = required('validation.ein.required')
  .superRefine(refineWith(validateEin))
  .transform((v) => validateEin(v).normalized ?? v);

export const localeSchema = z.enum(['en', 'es']);

// ---------------------------------------------------------------------------
// Company-side forms
// ---------------------------------------------------------------------------

export const createCompanySchema = z.object({
  legalName: required('validation.legalName.required').max(200),
  dbaName: z.string().trim().max(200).optional().nullable(),
  ein: einSchema.optional().nullable(),
  addressLine1: z.string().trim().max(200).optional().nullable(),
  addressLine2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: stateSchema.optional().nullable(),
  postalCode: postalCodeSchema.optional().nullable(),
  contactEmail: emailSchema,
  contactPhone: phoneSchema.optional().nullable(),
  // The pending COMPANY_ADMIN created alongside the company (spec section 7.1).
  adminName: required('validation.adminName.required').max(200),
  adminEmail: emailSchema,
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const companyProfileSchema = z
  .object({
    legalName: required('validation.legalName.required').max(200),
    dbaName: z.string().trim().max(200).optional().nullable(),
    ein: einSchema.optional().nullable(),
    addressLine1: required('validation.address.required').max(200),
    addressLine2: z.string().trim().max(200).optional().nullable(),
    city: required('validation.city.required').max(120),
    state: stateSchema,
    postalCode: postalCodeSchema,
    contactEmail: emailSchema,
    contactPhone: phoneSchema,
    operatingStates: z.array(stateSchema).min(1, { message: 'validation.operatingStates.required' }),

    wcStatus: z.enum(['POLICY', 'EXEMPT', 'PENDING']),
    wcPolicyNumber: z.string().trim().max(120).optional().nullable(),
    wcCarrier: z.string().trim().max(200).optional().nullable(),
    wcExpiresOn: z.string().trim().optional().nullable(),

    disabilityPolicyNumber: z.string().trim().max(120).optional().nullable(),
    disabilityCarrier: z.string().trim().max(200).optional().nullable(),
    disabilityExpiresOn: z.string().trim().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    // A workers' comp policy without a number and an expiry is not a policy,
    // it is an intention. The COI expiry drives nothing else in this system
    // (spec section 15 puts alerting out of scope), but a firm reviewing an
    // onboarding needs to see it.
    if (value.wcStatus === 'POLICY') {
      if (!value.wcPolicyNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['wcPolicyNumber'],
          message: 'validation.wc.policyNumberRequired',
        });
      }
      if (!value.wcExpiresOn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['wcExpiresOn'],
          message: 'validation.wc.expiryRequired',
        });
      }
    }
  });
export type CompanyProfileInput = z.infer<typeof companyProfileSchema>;

/**
 * The company's own bank account. Not covered by the employer-cannot-see rule —
 * the company owns this account — but validated identically and stored
 * encrypted all the same.
 */
export const companyBankingSchema = z
  .object({
    bankName: required('validation.bankName.required').max(200),
    routingNumber: required('validation.routing.required').superRefine(
      refineWith(validateRouting),
    ),
    accountNumber: required('validation.account.required'),
    accountNumberConfirm: required('validation.account.confirmRequired'),
  })
  .superRefine((value, ctx) => {
    const result = validateBankAccount(value.accountNumber, value.accountNumberConfirm);
    for (const issue of result.errors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: `validation.${issue.key}`,
      });
    }
  });
export type CompanyBankingInput = z.infer<typeof companyBankingSchema>;

export const inviteOwnerSchema = z.object({
  displayName: required('validation.displayName.required').max(200),
  // Warned on, not blocked, when the total across owners is not 100.
  ownershipPercent: z.coerce
    .number()
    .min(0, { message: 'validation.ownership.range' })
    .max(100, { message: 'validation.ownership.range' })
    .optional()
    .nullable(),
  /**
   * Where the link goes. The check that it is not on the company's own domain
   * needs the company row, so it lives in the query layer rather than here —
   * see `assertInvitableEmail`.
   */
  inviteEmail: emailSchema,
  phoneE164: z
    .union([z.literal(''), phoneSchema])
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable(),
  preferredLocale: localeSchema,
});
export type InviteOwnerInput = z.infer<typeof inviteOwnerSchema>;

export const inviteWorkerSchema = z.object({
  displayName: required('validation.displayName.required').max(200),
  workerType: z.enum(['EMPLOYEE', 'SUBCONTRACTOR']),
  inviteEmail: emailSchema,
  // Optional since invites moved to email. A firm chasing an unresponsive
  // worker has nothing else to call, so it is still worth collecting.
  phoneE164: z
    .union([z.literal(''), phoneSchema])
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable(),
  preferredLocale: localeSchema,

  // Payroll fields, entered by the company. Pay rate is deliberately absent —
  // see spec section 15.
  jobTitle: z.string().trim().max(200).optional().nullable(),
  startDate: z.string().trim().optional().nullable(),
  payType: z.enum(['HOURLY', 'SALARY']).optional().nullable(),
  payFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']).optional().nullable(),
  workState: stateSchema.optional().nullable(),
});
export type InviteWorkerInput = z.infer<typeof inviteWorkerSchema>;

// ---------------------------------------------------------------------------
// Subject forms — one schema per screen (spec section 8)
//
// Each screen validates and saves on its own, so a worker who loses signal at
// screen 9 resumes at screen 9 rather than at screen 0. That means every screen
// needs a schema that stands alone.
// ---------------------------------------------------------------------------

export const verifyDobSchema = z.object({
  dateOfBirth: dobSchema,
});

export const legalNameSchema = z.object({
  legalFirstName: required('validation.firstName.required').max(100),
  legalMiddleName: z.string().trim().max(100).optional().nullable(),
  legalLastName: required('validation.lastName.required').max(100),
});

export const addressSchema = z.object({
  addressLine1: required('validation.address.required').max(200),
  addressLine2: z.string().trim().max(200).optional().nullable(),
  city: required('validation.city.required').max(120),
  state: stateSchema,
  postalCode: postalCodeSchema,
});

export const contactSchema = z.object({
  email: optionalEmailSchema.optional().nullable(),
  phoneE164: phoneSchema,
});

export const emergencyContactSchema = z.object({
  emergencyContactName: z.string().trim().max(200).optional().nullable(),
  emergencyContactPhone: z
    .union([z.literal(''), phoneSchema])
    .transform((v) => (v === '' ? null : v))
    .optional()
    .nullable(),
  emergencyContactRelationship: z.string().trim().max(100).optional().nullable(),
});

export const tinTypeSchema = z.object({
  tinType: z.enum(['SSN', 'ITIN']),
});

/**
 * The tax ID itself. Validated against the type chosen on the previous screen,
 * so the schema is a factory rather than a constant.
 *
 * The soft warning is returned separately by `tinWarnings` below rather than
 * raised here: Zod has no concept of a non-blocking issue, and modelling one as
 * an error that the caller remembers to ignore is how a warning becomes a
 * block.
 */
export function tinValueSchema(type: 'SSN' | 'ITIN') {
  return z.object({
    tin: required('validation.tin.required')
      .superRefine(refineWith((v) => validateTin(type, v)))
      .transform((v) => digitsOnly(v)),
  });
}

export function tinWarnings(type: 'SSN' | 'ITIN', value: string): string[] {
  return validateTin(type, value).warnings.map((w) => `validation.${w.key}`);
}

export const bankIdentitySchema = z.object({
  bankName: required('validation.bankName.required').max(200),
  bankAccountType: z.enum(['CHECKING', 'SAVINGS']),
});

export const routingSchema = z.object({
  routingNumber: required('validation.routing.required')
    .superRefine(refineWith(validateRouting))
    .transform((v) => digitsOnly(v)),
});

export const accountSchema = z
  .object({
    accountNumber: required('validation.account.required'),
    accountNumberConfirm: required('validation.account.confirmRequired'),
  })
  .superRefine((value, ctx) => {
    const result = validateBankAccount(value.accountNumber, value.accountNumberConfirm);
    for (const issue of result.errors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: `validation.${issue.key}`,
      });
    }
  })
  .transform((value) => ({ accountNumber: digitsOnly(value.accountNumber) }));

export const noteSchema = z.object({
  body: z.string().trim().max(4000),
});

/**
 * ESIGN capture (spec section 9). Consent must be affirmative — an unchecked
 * box is not consent, and a default-checked box is not affirmative — so the
 * schema accepts only `true`, never a coerced truthy value.
 */
export const signatureSchema = z.object({
  typedName: required('validation.signature.nameRequired').max(200),
  consentToElectronic: z.literal(true, {
    errorMap: () => ({ message: 'validation.signature.consentRequired' }),
  }),
  documentType: z.enum(['DATA_ACCURACY', 'DIRECT_DEPOSIT_AUTH', 'COMPANY_CERTIFICATION']),
  documentVersion: z.string().trim().min(1),
  documentLocale: localeSchema,
});
export type SignatureInput = z.infer<typeof signatureSchema>;

// ---------------------------------------------------------------------------
// Firm-side forms
// ---------------------------------------------------------------------------

/**
 * A reveal (spec section 7.6). One field, one record, one reason of at least
 * ten characters.
 *
 * Ten characters is not a strong constraint on its own — "asdfghjkl;" clears
 * it. It is not meant to be: the reason exists so that the person revealing has
 * to articulate one, and so that a pattern of empty reasons is visible in the
 * audit log later. A minimum length is what makes an empty reason impossible
 * without making a bad one someone else's problem to detect in the moment.
 */
export const revealSchema = z.object({
  field: z.enum(['tin', 'routing', 'account']),
  recordType: z.enum(['WORKER_RECORD', 'OWNER', 'COMPANY']),
  recordId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(10, { message: 'validation.reveal.reasonTooShort' })
    .max(500),
  totpCode: z.string().trim().regex(/^\d{6}$/, { message: 'validation.totp.format' }),
});
export type RevealInput = z.infer<typeof revealSchema>;

export const exportSchema = z.object({
  companyIds: z.array(z.string().uuid()).min(1, { message: 'validation.export.companyRequired' }),
  from: z.string().trim().optional().nullable(),
  to: z.string().trim().optional().nullable(),
  includeSensitive: z.boolean(),
  reason: z
    .string()
    .trim()
    .min(10, { message: 'validation.export.reasonTooShort' })
    .max(500),
});
export type ExportInput = z.infer<typeof exportSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { message: 'validation.password.required' }),
});

export const totpSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, { message: 'validation.totp.format' }),
});

/**
 * Password rules follow NIST SP 800-63B: length is the requirement, composition
 * rules are not. Mandated symbol classes reliably produce `Password1!` and
 * nothing more; length plus a breach-corpus check is what actually helps, and
 * TOTP is mandatory for every firm role regardless.
 */
export const passwordSchema = z
  .string()
  .min(12, { message: 'validation.password.tooShort' })
  .max(256, { message: 'validation.password.tooLong' });

export const setupPasswordSchema = z
  .object({
    password: passwordSchema,
    passwordConfirm: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.passwordConfirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwordConfirm'],
        message: 'validation.password.mismatch',
      });
    }
  });
