/**
 * The company's own profile, banking, and onboarding status (spec section 7.2).
 *
 * Everything a company user may write about itself lives here. Nothing here can
 * read a worker's or an owner's data — the Postgres role this runs as cannot
 * name those columns, which is what makes that sentence a fact rather than a
 * claim about this file.
 */
import { eq, sql } from 'drizzle-orm';
import { schema, withScope } from '../scoped';
import type { CompanySession, Session } from '../../auth/session';
import { audit } from '../../audit';
import {
  COMPANY_BANK_TARGET,
  decryptField,
  encryptField,
  last4,
} from '../../security/field-encryption';
import type { CompanyBankingInput, CompanyProfileInput } from '../../validation/forms';

export async function updateCompanyProfile(
  session: CompanySession,
  input: CompanyProfileInput,
): Promise<void> {
  await withScope(session, async (db) => {
    await db
      .update(schema.companies)
      .set({
        legalName: input.legalName,
        dbaName: input.dbaName ?? null,
        ein: input.ein ?? null,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        operatingStates: input.operatingStates,
        wcStatus: input.wcStatus,
        wcPolicyNumber: input.wcPolicyNumber ?? null,
        wcCarrier: input.wcCarrier ?? null,
        wcExpiresOn: input.wcExpiresOn || null,
        disabilityPolicyNumber: input.disabilityPolicyNumber ?? null,
        disabilityCarrier: input.disabilityCarrier ?? null,
        disabilityExpiresOn: input.disabilityExpiresOn || null,
      })
      .where(eq(schema.companies.id, session.companyId));
  });

  await recomputeOnboardingStatus(session);
}

/**
 * Stores the company's own bank details, encrypted.
 *
 * Encrypted even though this account is not covered by the employer-cannot-see
 * rule — the company owns it. The reason is that "which of these ciphertext
 * columns is genuinely secret" is not a question anyone should have to answer
 * while reading a database dump, and a uniform rule has no exceptions to
 * forget.
 */
export async function updateCompanyBanking(
  session: CompanySession,
  input: CompanyBankingInput,
): Promise<void> {
  const routingEnc = await encryptField(session, session.companyId, input.routingNumber);
  const accountEnc = await encryptField(session, session.companyId, input.accountNumber);

  await withScope(session, async (db) => {
    await db
      .update(schema.companies)
      .set({
        bankName: input.bankName,
        bankRoutingEnc: routingEnc,
        bankRoutingLast4: last4(input.routingNumber),
        bankAccountEnc: accountEnc,
        bankAccountLast4: last4(input.accountNumber),
      })
      .where(eq(schema.companies.id, session.companyId));

    await audit(db, session, {
      action: 'FORM_SUBMITTED',
      companyId: session.companyId,
      targetType: 'companies',
      targetId: session.companyId,
      metadata: { section: 'banking' },
    });
  });
}

/**
 * Reveals one of the company's own banking fields to its own admin.
 *
 * The only path on which a company session decrypts anything. The guard in
 * lib/security/field-encryption.ts matches on the exact target type below and
 * on both ids agreeing with the session, so this cannot be pointed at a worker
 * record by changing an argument.
 */
export async function revealCompanyBankField(
  session: CompanySession,
  field: 'routing' | 'account',
  reason: string,
): Promise<string | null> {
  const ciphertext = await withScope(session, async (db) => {
    const rows = await db
      .select({
        routing: schema.companies.bankRoutingEnc,
        account: schema.companies.bankAccountEnc,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);

    return field === 'routing' ? rows[0]?.routing : rows[0]?.account;
  });

  if (!ciphertext) return null;

  return decryptField(ciphertext, {
    session,
    action: 'REVEAL_BANK',
    reason,
    targetType: COMPANY_BANK_TARGET,
    targetId: session.companyId,
    companyId: session.companyId,
  });
}

// ---------------------------------------------------------------------------
// Onboarding status (spec section 11)
// ---------------------------------------------------------------------------

export interface OnboardingChecklist {
  profileComplete: boolean;
  bankingComplete: boolean;
  ownersSubmitted: boolean;
  articlesUploaded: boolean;
  wcResolved: boolean;
  certificationSigned: boolean;
}

export function checklistComplete(checklist: OnboardingChecklist): boolean {
  return Object.values(checklist).every(Boolean);
}

/**
 * Derives the company's onboarding checklist from the data, every time it is
 * asked, rather than maintaining a set of boolean columns.
 *
 * A stored flag and the rows it summarizes drift apart the first time anything
 * is changed by a path that forgets to update the flag — and the symptom is a
 * company that is told it is finished when an owner has not submitted.
 */
export async function getOnboardingChecklist(
  session: Session,
  companyId: string,
): Promise<OnboardingChecklist> {
  return withScope(session, async (db) => {
    const [company] = await db
      .select({
        addressLine1: schema.companies.addressLine1,
        city: schema.companies.city,
        state: schema.companies.state,
        postalCode: schema.companies.postalCode,
        contactEmail: schema.companies.contactEmail,
        contactPhone: schema.companies.contactPhone,
        operatingStates: schema.companies.operatingStates,
        bankRoutingLast4: schema.companies.bankRoutingLast4,
        bankAccountLast4: schema.companies.bankAccountLast4,
        wcStatus: schema.companies.wcStatus,
        wcPolicyNumber: schema.companies.wcPolicyNumber,
        wcExpiresOn: schema.companies.wcExpiresOn,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);

    if (!company) {
      return {
        profileComplete: false,
        bankingComplete: false,
        ownersSubmitted: false,
        articlesUploaded: false,
        wcResolved: false,
        certificationSigned: false,
      };
    }

    const [ownerCounts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        submitted: sql<number>`count(*) filter (where status = 'SUBMITTED')::int`,
      })
      .from(schema.companyOwners)
      .where(eq(schema.companyOwners.companyId, companyId));

    const [articles] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.documents)
      .where(
        sql`${schema.documents.companyId} = ${companyId}
            and ${schema.documents.docType} = 'ARTICLES_OF_INCORPORATION'
            and ${schema.documents.deletedAt} is null`,
      );

    const [certification] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.signatures)
      .where(
        sql`${schema.signatures.companyId} = ${companyId}
            and ${schema.signatures.documentType} = 'COMPANY_CERTIFICATION'`,
      );

    // An exemption needs its proof document; a policy needs a number and an
    // expiry. PENDING is not resolved, which is the whole point of the enum
    // having three values rather than a boolean.
    const [exemption] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.documents)
      .where(
        sql`${schema.documents.companyId} = ${companyId}
            and ${schema.documents.docType} = 'WC_EXEMPTION'
            and ${schema.documents.deletedAt} is null`,
      );

    const wcResolved =
      company.wcStatus === 'POLICY'
        ? Boolean(company.wcPolicyNumber && company.wcExpiresOn)
        : company.wcStatus === 'EXEMPT'
          ? (exemption?.n ?? 0) > 0
          : false;

    return {
      profileComplete: Boolean(
        company.addressLine1 &&
          company.city &&
          company.state &&
          company.postalCode &&
          company.contactEmail &&
          company.contactPhone &&
          company.operatingStates &&
          company.operatingStates.length > 0,
      ),
      bankingComplete: Boolean(company.bankRoutingLast4 && company.bankAccountLast4),
      // No owners at all is not "all owners submitted". A company with no owner
      // rows has not started that step, and reporting it complete would let an
      // onboarding finish with no K-1 recipients on file.
      ownersSubmitted: (ownerCounts?.total ?? 0) > 0 && ownerCounts?.total === ownerCounts?.submitted,
      articlesUploaded: (articles?.n ?? 0) > 0,
      wcResolved,
      certificationSigned: (certification?.n ?? 0) > 0,
    };
  });
}

/**
 * Rolls the checklist up into the stored `onboarding_status`, which exists so a
 * firm's company list can be sorted and filtered without running the checklist
 * for every row.
 */
export async function recomputeOnboardingStatus(
  session: Session,
  companyId?: string,
): Promise<'PENDING' | 'IN_REVIEW' | 'COMPLETE'> {
  const target =
    companyId ?? (session.kind === 'company' ? session.companyId : undefined);
  if (!target) throw new Error('recomputeOnboardingStatus needs a company id.');

  const checklist = await getOnboardingChecklist(session, target);
  const done = Object.values(checklist).filter(Boolean).length;

  const status: 'PENDING' | 'IN_REVIEW' | 'COMPLETE' = checklistComplete(checklist)
    ? 'COMPLETE'
    : done === 0
      ? 'PENDING'
      : 'IN_REVIEW';

  await withScope(session, async (db) => {
    await db
      .update(schema.companies)
      .set({ onboardingStatus: status })
      .where(eq(schema.companies.id, target));
  });

  return status;
}
