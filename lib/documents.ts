/**
 * Document upload and retrieval (spec section 4).
 *
 * The `sensitivity` column is the load-bearing part, and it is decided here and
 * again by a database trigger. Anything a worker or an owner uploads is
 * FIRM_ONLY with no override, and so is a voided check, an ID document, a W-4,
 * a W-9, or an I-9 regardless of who uploaded it.
 *
 * Deciding it twice is deliberate. The function below is the readable rule; the
 * trigger in 900_rls.sql is the one that holds when a future handler forgets to
 * call this function at all.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, withScope } from './db/scoped';
import type { Session } from './auth/session';
import { audit } from './audit';
import { uuidv7 } from './uuid';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  extensionForContentType,
  getStorage,
  newObjectKey,
} from './services/storage';

export type DocType = (typeof schema.docType.enumValues)[number];
export type SubjectType = (typeof schema.subjectType.enumValues)[number];

/**
 * Document types that are firm-only whatever their origin. A voided check
 * carries a full account number in an image, and an ID document carries
 * everything on a driver's licence — neither becomes safe because a company
 * admin was the one who uploaded it.
 */
const ALWAYS_FIRM_ONLY: ReadonlySet<DocType> = new Set<DocType>([
  'VOIDED_CHECK',
  'ID_DOCUMENT',
  'W4',
  'W9',
  'I9',
  // A signed authorization reproduces the text someone agreed to along with
  // their name, IP, and timestamp. Spec section 9 step 5 requires it stored
  // FIRM_ONLY, and it is generated under whichever session captured the
  // signature — including a firm session, which would otherwise have made it
  // company-visible.
  'SIGNED_AUTHORIZATION',
]);

/** Uploader roles whose files are firm-only whatever the type. */
const SUBJECT_ROLES = new Set(['WORKER', 'OWNER']);

export function sensitivityFor(docType: DocType, uploadedByRole: string): 'COMPANY_VISIBLE' | 'FIRM_ONLY' {
  if (SUBJECT_ROLES.has(uploadedByRole)) return 'FIRM_ONLY';
  if (ALWAYS_FIRM_ONLY.has(docType)) return 'FIRM_ONLY';
  return 'COMPANY_VISIBLE';
}

export class UploadRejectedError extends Error {
  constructor(readonly key: string) {
    super(`Upload rejected: ${key}`);
    this.name = 'UploadRejectedError';
  }
}

export interface UploadInput {
  companyId: string;
  subjectType: SubjectType;
  subjectId: string;
  docType: DocType;
  label?: string | null;
  contentType: string;
  bytes: Buffer;
}

/**
 * Stores the object, then records it.
 *
 * That order leaves an orphaned object behind if the insert fails, which is the
 * right failure: an object nobody can reach costs storage, whereas a row
 * pointing at an object that was never written is a document the firm believes
 * it has.
 */
export async function uploadDocument(
  session: Session,
  input: UploadInput,
): Promise<{ id: string; s3Key: string }> {
  if (!ALLOWED_UPLOAD_TYPES.has(input.contentType)) {
    throw new UploadRejectedError('documents.errors.type');
  }
  if (input.bytes.byteLength === 0) {
    throw new UploadRejectedError('documents.errors.empty');
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadRejectedError('documents.errors.tooLarge');
  }

  const key = newObjectKey(
    input.companyId,
    input.docType,
    extensionForContentType(input.contentType),
  );

  await getStorage().put(key, input.bytes, { contentType: input.contentType });

  const id = uuidv7();

  await withScope(session, async (db) => {
    await db.insert(schema.documents).values({
      id,
      companyId: input.companyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      docType: input.docType,
      label: input.label ?? null,
      s3Key: key,
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      uploadedByRole: session.role,
      uploadedByUserId: session.kind === 'subject' || session.kind === 'anonymous' ? null : session.userId,
      sensitivity: sensitivityFor(input.docType, session.role),
    });

    await audit(db, session, {
      action: 'DOCUMENT_UPLOADED',
      companyId: input.companyId,
      targetType: 'documents',
      targetId: id,
      metadata: {
        docType: input.docType,
        sensitivity: sensitivityFor(input.docType, session.role),
        sizeBytes: input.bytes.byteLength,
      },
    });
  });

  return { id, s3Key: key };
}

/**
 * A short-lived URL for one document, issued only after the row has been read
 * back under the caller's own scope.
 *
 * The read is the authorization check: RLS hides a FIRM_ONLY row from a company
 * session entirely, so a company admin who guesses a document id gets a null
 * here and no URL. Checking `sensitivity` in TypeScript afterwards would be
 * checking a value we could only have obtained by being allowed to see it.
 */
export async function getDocumentUrl(
  session: Session,
  documentId: string,
  ttlSeconds = 120,
): Promise<{ url: string; contentType: string; label: string | null } | null> {
  const row = await withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.documents.id,
        companyId: schema.documents.companyId,
        s3Key: schema.documents.s3Key,
        contentType: schema.documents.contentType,
        label: schema.documents.label,
        docType: schema.documents.docType,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
      .limit(1);

    const found = rows[0];
    if (!found) return null;

    // DOCUMENT_VIEWED is written when the URL is issued, not when the object is
    // fetched: the URL is the disclosure, and whether the browser follows it is
    // not something the server observes.
    await audit(db, session, {
      action: 'DOCUMENT_VIEWED',
      companyId: found.companyId,
      targetType: 'documents',
      targetId: found.id,
      metadata: { docType: found.docType },
    });

    return found;
  });

  if (!row) return null;

  return {
    url: await getStorage().signedGetUrl(row.s3Key, ttlSeconds),
    contentType: row.contentType,
    label: row.label,
  };
}

export async function listDocuments(
  session: Session,
  companyId: string,
  subject?: { subjectType: SubjectType; subjectId: string },
) {
  return withScope(session, async (db) =>
    db
      .select({
        id: schema.documents.id,
        docType: schema.documents.docType,
        label: schema.documents.label,
        contentType: schema.documents.contentType,
        sizeBytes: schema.documents.sizeBytes,
        sensitivity: schema.documents.sensitivity,
        subjectType: schema.documents.subjectType,
        subjectId: schema.documents.subjectId,
        uploadedByRole: schema.documents.uploadedByRole,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.companyId, companyId),
          isNull(schema.documents.deletedAt),
          subject ? eq(schema.documents.subjectType, subject.subjectType) : undefined,
          subject ? eq(schema.documents.subjectId, subject.subjectId) : undefined,
        ),
      )
      .orderBy(desc(schema.documents.createdAt)),
  );
}

/**
 * Soft delete. The object stays until the retention job removes it, because a
 * document deleted by mistake during an onboarding is recoverable for as long
 * as anyone is likely to notice, and because the row is what the audit trail
 * points at.
 */
export async function deleteDocument(session: Session, documentId: string): Promise<boolean> {
  return withScope(session, async (db) => {
    const deleted = await db
      .update(schema.documents)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
      .returning({ id: schema.documents.id, companyId: schema.documents.companyId });

    const row = deleted[0];
    if (!row) return false;

    await audit(db, session, {
      action: 'DOCUMENT_DELETED',
      companyId: row.companyId,
      targetType: 'documents',
      targetId: row.id,
    });
    return true;
  });
}
