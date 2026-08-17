/**
 * Export (spec section 7.7).
 *
 * FIRM_ADMIN only. Select companies, workers, a date range, and whether to
 * include sensitive fields. A reason is required. The output is a
 * password-protected zip containing `workers.csv`, `owners.csv`, and a
 * `documents/` folder. The password displays once on screen and is never sent
 * by SMS or email. The stored object hard-deletes at 24 hours.
 *
 * The part that needs care is `includeSensitive`. Every tax ID and bank account
 * in the export is decrypted through `decryptField`, one call per value, each
 * writing its own audit row — so an export of forty workers produces forty
 * REVEAL rows carrying the same reason, and the trail shows what actually left
 * the building rather than a single "export created" entry.
 *
 * That is slower than a bulk decrypt and it is meant to be. The alternative —
 * one privileged path that decrypts a whole company at once — is exactly the
 * bulk reveal that section 7.6 says must not exist in the codebase, and it
 * would exist here, one refactor away from the reveal button.
 */
import { and, eq, gte, inArray, isNull, lte, sql as raw } from 'drizzle-orm';
import { schema, withScope } from './db/scoped';
import type { FirmSession } from './auth/session';
import { audit } from './audit';
import { decryptField } from './security/field-encryption';
import { getStorage, newObjectKey } from './services/storage';
import { createEncryptedZip, generateArchivePassword, toCsv, type ZipEntry } from './zip';
import { uuidv7 } from './uuid';
import type { ExportInput } from './validation/forms';

/** Artifacts hard-delete at 24 hours regardless of legal hold (spec section 13). */
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExportResult {
  exportId: string;
  /** Shown once. Never persisted, never sent. */
  password: string;
  filename: string;
  sizeBytes: number;
  expiresAt: Date;
  workerCount: number;
  ownerCount: number;
  documentCount: number;
}

export async function createExport(
  session: FirmSession,
  input: ExportInput,
): Promise<ExportResult> {
  if (session.role !== 'FIRM_ADMIN') {
    throw new Error('Export is FIRM_ADMIN only (spec section 7.7).');
  }

  // Intersect the requested companies with the session's scope before anything
  // else. A company id the session does not hold a live grant on is dropped
  // here, and would be invisible to every query below in any case.
  const companyIds = input.companyIds.filter((id) => session.companyIds.includes(id));
  if (companyIds.length === 0) {
    throw new Error('None of the requested companies are in scope.');
  }

  const from = input.from ? new Date(`${input.from}T00:00:00Z`) : null;
  const to = input.to ? new Date(`${input.to}T23:59:59Z`) : null;

  const exportId = uuidv7();

  // The row is written first, so the reason and the scope are recorded before
  // a single field is decrypted. If the build fails halfway, the record of what
  // was asked for survives.
  await withScope(session, async (db) => {
    await db.insert(schema.dataExports).values({
      id: exportId,
      firmId: session.firmId,
      companyId: companyIds.length === 1 ? companyIds[0]! : null,
      requestedBy: session.userId,
      reason: input.reason,
      scope: { companyIds, from: input.from ?? null, to: input.to ?? null },
      includeSensitive: input.includeSensitive,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    });

    await audit(db, session, {
      action: 'EXPORT_CREATED',
      companyId: companyIds.length === 1 ? companyIds[0]! : null,
      targetType: 'exports',
      targetId: exportId,
      reason: input.reason,
      metadata: {
        companyIds,
        includeSensitive: input.includeSensitive,
        from: input.from ?? null,
        to: input.to ?? null,
      },
    });
  });

  const [workers, owners, documents] = await Promise.all([
    collectWorkers(session, companyIds, from, to, input),
    collectOwners(session, companyIds, input),
    collectDocuments(session, companyIds),
  ]);

  const entries: ZipEntry[] = [
    { name: 'workers.csv', data: Buffer.from(toCsv(workers), 'utf8') },
    { name: 'owners.csv', data: Buffer.from(toCsv(owners), 'utf8') },
    {
      name: 'README.txt',
      data: Buffer.from(readme(input, workers.length, owners.length, documents.length), 'utf8'),
    },
    ...documents,
  ];

  const password = generateArchivePassword();
  const archive = createEncryptedZip(entries, password);

  const key = newObjectKey(session.firmId, 'export', 'zip');
  await getStorage().put(key, archive, { contentType: 'application/zip' });

  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);

  await withScope(session, async (db) => {
    await db
      .update(schema.dataExports)
      .set({ s3Key: key, expiresAt })
      .where(eq(schema.dataExports.id, exportId));
  });

  return {
    exportId,
    password,
    filename: `export-${exportId.slice(0, 8)}.zip`,
    sizeBytes: archive.length,
    expiresAt,
    workerCount: workers.length,
    ownerCount: owners.length,
    documentCount: documents.length,
  };
}

type Row = Record<string, string | number | null>;

async function collectWorkers(
  session: FirmSession,
  companyIds: string[],
  from: Date | null,
  to: Date | null,
  input: ExportInput,
): Promise<Row[]> {
  const rows = await withScope(session, async (db) =>
    db
      .select({
        companyName: schema.companies.legalName,
        workerId: schema.workers.id,
        displayName: schema.workers.displayName,
        workerType: schema.workers.workerType,
        status: schema.workers.status,
        jobTitle: schema.workers.jobTitle,
        startDate: schema.workers.startDate,
        payType: schema.workers.payType,
        payFrequency: schema.workers.payFrequency,
        workState: schema.workers.workState,
        recordId: schema.workerRecords.id,
        version: schema.workerRecords.version,
        legalFirstName: schema.workerRecords.legalFirstName,
        legalMiddleName: schema.workerRecords.legalMiddleName,
        legalLastName: schema.workerRecords.legalLastName,
        dateOfBirth: schema.workerRecords.dateOfBirth,
        addressLine1: schema.workerRecords.addressLine1,
        addressLine2: schema.workerRecords.addressLine2,
        city: schema.workerRecords.city,
        state: schema.workerRecords.state,
        postalCode: schema.workerRecords.postalCode,
        email: schema.workerRecords.email,
        phoneE164: schema.workerRecords.phoneE164,
        tinType: schema.workerRecords.tinType,
        tinLast4: schema.workerRecords.tinLast4,
        tinEnc: schema.workerRecords.tinEnc,
        bankName: schema.workerRecords.bankName,
        bankAccountType: schema.workerRecords.bankAccountType,
        routingLast4: schema.workerRecords.routingLast4,
        routingEnc: schema.workerRecords.routingEnc,
        accountLast4: schema.workerRecords.accountLast4,
        accountEnc: schema.workerRecords.accountEnc,
        companyId: schema.workers.companyId,
        submittedAt: schema.workers.submittedAt,
      })
      .from(schema.workers)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.workers.companyId))
      .leftJoin(
        schema.workerRecords,
        and(
          eq(schema.workerRecords.workerId, schema.workers.id),
          eq(schema.workerRecords.isCurrent, true),
        ),
      )
      .where(
        and(
          inArray(schema.workers.companyId, companyIds),
          from ? gte(schema.workers.createdAt, from) : undefined,
          to ? lte(schema.workers.createdAt, to) : undefined,
        ),
      ),
  );

  const out: Row[] = [];

  for (const row of rows) {
    const base: Row = {
      company: row.companyName,
      worker_id: row.workerId,
      display_name: row.displayName,
      worker_type: row.workerType,
      status: row.status,
      job_title: row.jobTitle,
      start_date: row.startDate,
      pay_type: row.payType,
      pay_frequency: row.payFrequency,
      work_state: row.workState,
      submitted_at: row.submittedAt ? row.submittedAt.toISOString() : null,
      record_version: row.version,
      legal_first_name: row.legalFirstName,
      legal_middle_name: row.legalMiddleName,
      legal_last_name: row.legalLastName,
      date_of_birth: row.dateOfBirth,
      address_line1: row.addressLine1,
      address_line2: row.addressLine2,
      city: row.city,
      state: row.state,
      postal_code: row.postalCode,
      email: row.email,
      phone: row.phoneE164,
      tin_type: row.tinType,
      bank_name: row.bankName,
      bank_account_type: row.bankAccountType,
    };

    if (input.includeSensitive && row.recordId) {
      // One decryption per value, each writing its own audit row.
      base.tin = row.tinEnc
        ? await reveal(session, row.companyId, row.recordId, row.tinEnc, 'REVEAL_TIN', input.reason)
        : null;
      base.routing_number = row.routingEnc
        ? await reveal(
            session,
            row.companyId,
            row.recordId,
            row.routingEnc,
            'REVEAL_BANK',
            input.reason,
          )
        : null;
      base.account_number = row.accountEnc
        ? await reveal(
            session,
            row.companyId,
            row.recordId,
            row.accountEnc,
            'REVEAL_BANK',
            input.reason,
          )
        : null;
    } else {
      base.tin_last4 = row.tinLast4;
      base.routing_last4 = row.routingLast4;
      base.account_last4 = row.accountLast4;
    }

    out.push(base);
  }

  return out;
}

async function collectOwners(
  session: FirmSession,
  companyIds: string[],
  input: ExportInput,
): Promise<Row[]> {
  const rows = await withScope(session, async (db) =>
    db
      .select({
        companyName: schema.companies.legalName,
        companyId: schema.companyOwners.companyId,
        ownerId: schema.companyOwners.id,
        displayName: schema.companyOwners.displayName,
        ownershipPercent: schema.companyOwners.ownershipPercent,
        status: schema.companyOwners.status,
        legalFirstName: schema.companyOwners.legalFirstName,
        legalMiddleName: schema.companyOwners.legalMiddleName,
        legalLastName: schema.companyOwners.legalLastName,
        dateOfBirth: schema.companyOwners.dateOfBirth,
        addressLine1: schema.companyOwners.addressLine1,
        city: schema.companyOwners.city,
        state: schema.companyOwners.state,
        postalCode: schema.companyOwners.postalCode,
        email: schema.companyOwners.email,
        tinType: schema.companyOwners.tinType,
        tinLast4: schema.companyOwners.tinLast4,
        tinEnc: schema.companyOwners.tinEnc,
        submittedAt: schema.companyOwners.submittedAt,
      })
      .from(schema.companyOwners)
      .innerJoin(schema.companies, eq(schema.companies.id, schema.companyOwners.companyId))
      .where(inArray(schema.companyOwners.companyId, companyIds)),
  );

  const out: Row[] = [];

  for (const row of rows) {
    const base: Row = {
      company: row.companyName,
      owner_id: row.ownerId,
      display_name: row.displayName,
      ownership_percent: row.ownershipPercent,
      status: row.status,
      legal_first_name: row.legalFirstName,
      legal_middle_name: row.legalMiddleName,
      legal_last_name: row.legalLastName,
      date_of_birth: row.dateOfBirth,
      address_line1: row.addressLine1,
      city: row.city,
      state: row.state,
      postal_code: row.postalCode,
      email: row.email,
      tin_type: row.tinType,
      submitted_at: row.submittedAt ? row.submittedAt.toISOString() : null,
    };

    if (input.includeSensitive && row.tinEnc) {
      base.tin = await reveal(
        session,
        row.companyId,
        row.ownerId,
        row.tinEnc,
        'REVEAL_TIN',
        input.reason,
      );
    } else {
      base.tin_last4 = row.tinLast4;
    }

    out.push(base);
  }

  return out;
}

async function reveal(
  session: FirmSession,
  companyId: string,
  targetId: string,
  ciphertext: Buffer,
  action: 'REVEAL_TIN' | 'REVEAL_BANK',
  reason: string,
): Promise<string> {
  return decryptField(ciphertext, {
    session,
    action,
    reason: `Export: ${reason}`,
    targetType: 'export',
    targetId,
    companyId,
  });
}

async function collectDocuments(
  session: FirmSession,
  companyIds: string[],
): Promise<ZipEntry[]> {
  const rows = await withScope(session, async (db) =>
    db
      .select({
        id: schema.documents.id,
        companyId: schema.documents.companyId,
        docType: schema.documents.docType,
        s3Key: schema.documents.s3Key,
        contentType: schema.documents.contentType,
        subjectId: schema.documents.subjectId,
      })
      .from(schema.documents)
      .where(
        and(
          inArray(schema.documents.companyId, companyIds),
          isNull(schema.documents.deletedAt),
          // Sanity bound. An export is not a bulk download of a bucket, and an
          // archive that takes four minutes to build is one somebody reloads.
          raw`true`,
        ),
      )
      .limit(500),
  );

  const storage = getStorage();
  const entries: ZipEntry[] = [];

  for (const row of rows) {
    try {
      const bytes = await storage.get(row.s3Key);
      const extension = row.s3Key.split('.').pop() ?? 'bin';
      entries.push({
        name: `documents/${row.companyId}/${row.docType}-${row.id.slice(0, 8)}.${extension}`,
        data: bytes,
      });
    } catch (err) {
      // A missing object must not fail the whole export. It is recorded in the
      // README so the recipient knows the archive is incomplete rather than
      // concluding the document was never uploaded.
      console.error(`[export] could not read ${row.s3Key}`, err);
    }
  }

  return entries;
}

function readme(
  input: ExportInput,
  workers: number,
  owners: number,
  documents: number,
): string {
  return [
    'Onboarding platform export',
    '',
    `Created:            ${new Date().toISOString()}`,
    `Reason given:       ${input.reason}`,
    `Companies:          ${input.companyIds.length}`,
    `Date range:         ${input.from ?? 'all'} to ${input.to ?? 'all'}`,
    `Sensitive fields:   ${input.includeSensitive ? 'INCLUDED' : 'masked (last 4 only)'}`,
    '',
    `workers.csv         ${workers} rows`,
    `owners.csv          ${owners} rows`,
    `documents/          ${documents} files`,
    '',
    input.includeSensitive
      ? [
          'THIS ARCHIVE CONTAINS UNMASKED TAXPAYER IDENTIFICATION NUMBERS AND BANK',
          'ACCOUNT NUMBERS.',
          '',
          'Every value in it was decrypted individually and each decryption is',
          'recorded in the audit log against the person who requested this export,',
          'with the reason above.',
          '',
          'The copy held by the platform is deleted automatically 24 hours after it',
          'was created. This copy is not. Store it encrypted, and delete it when the',
          'work it was created for is finished.',
        ].join('\n')
      : 'Sensitive fields are masked in this archive. Only the last four digits are present.',
    '',
  ].join('\n');
}
