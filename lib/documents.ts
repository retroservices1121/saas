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
  ObjectNotFoundError,
  extensionForContentType,
  getStorage,
  newObjectKey,
} from './services/storage';
import { BLOB_ENCRYPTION, openBlob, sealBlob } from './security/field-encryption';

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

  // Sealed with the company's data key before it reaches storage. The provider
  // — Railway, R2, S3 — holds ciphertext and no key, which is what replaces the
  // spec's SSE-KMS and improves on it.
  const sealed = await sealBlob(session, input.companyId, key, input.bytes);
  await getStorage().put(key, sealed, {
    contentType: input.contentType,
    // The ciphertext is a little larger than the plaintext, and the limit was
    // already checked against the plaintext above.
    maxBytes: MAX_UPLOAD_BYTES * 2,
  });

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
      // The size of the file the person chose, not of the ciphertext. What a
      // firm user is being told is how big the document is.
      sizeBytes: input.bytes.byteLength,
      uploadedByRole: session.role,
      uploadedByUserId:
        session.kind === 'subject' || session.kind === 'anonymous' ? null : session.userId,
      sensitivity: sensitivityFor(input.docType, session.role),
      contentEncryption: BLOB_ENCRYPTION,
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
 * Reads one document back, decrypted.
 *
 * The row is fetched under the caller's own scope, and that read *is* the
 * authorization: RLS removes a FIRM_ONLY document from a company session
 * entirely, so a company admin who guesses a document id gets null here.
 * Checking a `sensitivity` column afterwards would be checking a value we could
 * only have obtained by being allowed to see it.
 *
 * Bytes come back through the application rather than by presigned URL. They
 * have to — the stored object is ciphertext — and the consequence is worth
 * having anyway: every read is an authenticated request that writes an audit
 * row, and revoking a session revokes the read with it.
 */
export interface DocumentContents {
  id: string;
  bytes: Buffer;
  contentType: string;
  label: string | null;
  docType: DocType;
}

export async function readDocument(
  session: Session,
  documentId: string,
): Promise<DocumentContents | null> {
  const row = await withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.documents.id,
        companyId: schema.documents.companyId,
        s3Key: schema.documents.s3Key,
        contentType: schema.documents.contentType,
        label: schema.documents.label,
        docType: schema.documents.docType,
        contentEncryption: schema.documents.contentEncryption,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.id, documentId), isNull(schema.documents.deletedAt)))
      .limit(1);

    const found = rows[0];
    if (!found) return null;

    // Written when the bytes are handed over, which is the moment of
    // disclosure — not when a URL is minted that may never be followed.
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

  let stored: Buffer;
  try {
    stored = await getStorage().get(row.s3Key);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return null;
    throw err;
  }

  // Null means the object predates client-side blob encryption. Handled rather
  // than assumed away: a running deployment holds objects from both eras.
  const bytes =
    row.contentEncryption === BLOB_ENCRYPTION
      ? await openBlob(session, row.companyId, row.s3Key, stored)
      : stored;

  return {
    id: row.id,
    bytes,
    contentType: row.contentType,
    label: row.label,
    docType: row.docType,
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
