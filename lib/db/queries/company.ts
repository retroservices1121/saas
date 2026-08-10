/**
 * Company-facing reads. Every column list here is explicit — there is no
 * `select *` anywhere in this file, and there never should be.
 *
 * A wildcard select against company_owners would name tin_last4, which
 * app_company has no privilege on, and the query would fail. That failure is
 * the safety net. The explicit projections are the actual design: a company
 * user's view of a worker or an owner is a status chip and nothing more
 * (spec section 2).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, withScope, withScopeOrNull } from '../scoped';
import type { CompanySession, Session } from '../../auth/session';

export interface WorkerStatusRow {
  id: string;
  displayName: string;
  workerType: 'EMPLOYEE' | 'SUBCONTRACTOR';
  status: string;
  jobTitle: string | null;
  startDate: string | null;
  payType: string | null;
  payFrequency: string | null;
  workState: string | null;
}

/**
 * The company's worker list. Payroll fields the company itself entered, plus a
 * status chip. No last-4 of anything, by design: last-4 of a bank account plus
 * a name is enough for several social-engineering paths, and the company has no
 * stated need for it.
 */
export async function listWorkersForCompany(
  session: CompanySession,
): Promise<WorkerStatusRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.workers.id,
        displayName: schema.workers.displayName,
        workerType: schema.workers.workerType,
        status: schema.workers.status,
        jobTitle: schema.workers.jobTitle,
        startDate: schema.workers.startDate,
        payType: schema.workers.payType,
        payFrequency: schema.workers.payFrequency,
        workState: schema.workers.workState,
      })
      .from(schema.workers)
      .where(eq(schema.workers.companyId, session.companyId))
      .orderBy(desc(schema.workers.createdAt)),
  );
}

export interface OwnerStatusRow {
  id: string;
  displayName: string;
  ownershipPercent: string | null;
  status: string;
  submittedAt: Date | null;
}

/**
 * Owners as the company sees them: the name they typed, the percentage they
 * entered, and whether the owner has submitted. Not the legal name, not the
 * DOB, not tin_last4 — the column grant makes those unnameable by this role.
 */
export async function listOwnersForCompany(session: CompanySession): Promise<OwnerStatusRow[]> {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.companyOwners.id,
        displayName: schema.companyOwners.displayName,
        ownershipPercent: schema.companyOwners.ownershipPercent,
        status: schema.companyOwners.status,
        submittedAt: schema.companyOwners.submittedAt,
      })
      .from(schema.companyOwners)
      .where(eq(schema.companyOwners.companyId, session.companyId))
      .orderBy(desc(schema.companyOwners.createdAt)),
  );
}

/**
 * The company's own profile. Its bank details are masked here even though the
 * company owns that account — the reveal is a separate, COMPANY_ADMIN-only
 * action, so the list view never carries the value.
 */
export async function getCompanyProfile(session: CompanySession) {
  return withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.companies.id,
        legalName: schema.companies.legalName,
        dbaName: schema.companies.dbaName,
        ein: schema.companies.ein,
        addressLine1: schema.companies.addressLine1,
        addressLine2: schema.companies.addressLine2,
        city: schema.companies.city,
        state: schema.companies.state,
        postalCode: schema.companies.postalCode,
        contactEmail: schema.companies.contactEmail,
        contactPhone: schema.companies.contactPhone,
        operatingStates: schema.companies.operatingStates,
        bankName: schema.companies.bankName,
        wcStatus: schema.companies.wcStatus,
        wcPolicyNumber: schema.companies.wcPolicyNumber,
        wcCarrier: schema.companies.wcCarrier,
        wcExpiresOn: schema.companies.wcExpiresOn,
        onboardingStatus: schema.companies.onboardingStatus,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Documents the company may see. The RLS policy already excludes FIRM_ONLY
 * rows, so this predicate is redundant — and it stays, because a redundant
 * filter costs nothing and a missing one costs a W-4.
 */
export async function listDocumentsForCompany(session: CompanySession) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.documents.id,
        docType: schema.documents.docType,
        label: schema.documents.label,
        contentType: schema.documents.contentType,
        sizeBytes: schema.documents.sizeBytes,
        uploadedByRole: schema.documents.uploadedByRole,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.companyId, session.companyId),
          eq(schema.documents.sensitivity, 'COMPANY_VISIBLE'),
          isNull(schema.documents.deletedAt),
        ),
      )
      .orderBy(desc(schema.documents.createdAt)),
  );
}

export async function listNotesForCompany(session: CompanySession) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.notes.id,
        body: schema.notes.body,
        authorRole: schema.notes.authorRole,
        subjectType: schema.notes.subjectType,
        subjectId: schema.notes.subjectId,
        createdAt: schema.notes.createdAt,
      })
      .from(schema.notes)
      .where(
        and(
          eq(schema.notes.companyId, session.companyId),
          eq(schema.notes.visibility, 'COMPANY_AND_FIRM'),
        ),
      )
      .orderBy(desc(schema.notes.createdAt)),
  );
}

/**
 * Fetch a single entity by id, for any session. Returns null when the row is
 * out of scope — which is the same answer as "does not exist", deliberately.
 * Distinguishing the two confirms the row exists to an attacker enumerating
 * ids.
 */
export async function findByIdInScope(
  session: Session,
  table: 'companies' | 'workers' | 'company_owners' | 'documents' | 'notes' | 'worker_records',
  id: string,
): Promise<unknown | null> {
  return withScopeOrNull(session, async (db) => {
    switch (table) {
      case 'companies': {
        const r = await db
          .select({ id: schema.companies.id, legalName: schema.companies.legalName })
          .from(schema.companies)
          .where(eq(schema.companies.id, id))
          .limit(1);
        return r[0] ?? null;
      }
      case 'workers': {
        const r = await db
          .select({ id: schema.workers.id, displayName: schema.workers.displayName })
          .from(schema.workers)
          .where(eq(schema.workers.id, id))
          .limit(1);
        return r[0] ?? null;
      }
      case 'company_owners': {
        const r = await db
          .select({ id: schema.companyOwners.id, displayName: schema.companyOwners.displayName })
          .from(schema.companyOwners)
          .where(eq(schema.companyOwners.id, id))
          .limit(1);
        return r[0] ?? null;
      }
      case 'documents': {
        const r = await db
          .select({ id: schema.documents.id, docType: schema.documents.docType })
          .from(schema.documents)
          .where(eq(schema.documents.id, id))
          .limit(1);
        return r[0] ?? null;
      }
      case 'notes': {
        const r = await db
          .select({ id: schema.notes.id, body: schema.notes.body })
          .from(schema.notes)
          .where(eq(schema.notes.id, id))
          .limit(1);
        return r[0] ?? null;
      }
      case 'worker_records': {
        const r = await db
          .select({ id: schema.workerRecords.id, tinLast4: schema.workerRecords.tinLast4 })
          .from(schema.workerRecords)
          .where(eq(schema.workerRecords.id, id))
          .limit(1);
        return r[0] ?? null;
      }
    }
  }).then((v) => v ?? null);
}
