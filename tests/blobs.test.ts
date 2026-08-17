/**
 * Client-side blob encryption, against the real database.
 *
 * This replaces the SSE-KMS the spec asked for, and the properties worth
 * asserting are the ones that make it a replacement rather than a substitute:
 * the storage provider holds ciphertext, the ciphertext is bound to its object
 * key, and destroying the company's data key destroys the documents too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdmin, destroyFirm, readRow, seedFirm, type FirmFixture } from './fixtures';
import { createCompany } from '../lib/db/queries/firm';
import { readDocument, uploadDocument } from '../lib/documents';
import { evictDek } from '../lib/security/field-encryption';
import { destroyCompanyDek, DekDestroyedError } from '../lib/security/field-encryption';
import { resolveFirmScope } from '../lib/auth/scope';
import { __setStorageProvider } from '../lib/services/storage';
import type { CompanySession, FirmSession } from '../lib/auth/session';

const PLAINTEXT = Buffer.from(
  '%PDF-1.4\nACCOUNT 000123456789 ROUTING 021000021\n%%EOF\n',
  'utf8',
);

let firm: FirmFixture;
let firmSession: FirmSession;
let companySession: CompanySession;
let companyId: string;
let documentId: string;
let objectKey: string;

/** Stands in for the bucket, so the test can look at what actually landed. */
const objects = new Map<string, Buffer>();

beforeAll(async () => {
  __setStorageProvider({
    name: 'test',
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) throw new Error('missing');
      return found;
    },
    async delete(key) {
      objects.delete(key);
    },
  });

  firm = await seedFirm();
  firmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
  };

  const created = await createCompany(firmSession, {
    legalName: 'Blob Test Co',
    dbaName: null,
    ein: '12-3456789',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    contactEmail: 'office@blobtest.test',
    contactPhone: null,
    adminName: 'Admin',
    adminEmail: `blob-admin-${Date.now()}@blobtest.test`,
  });
  companyId = created.companyId;
  firmSession = {
    ...firmSession,
    companyIds: await resolveFirmScope(firm.firmId, firm.firmAdminUserId),
  };
  companySession = {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: created.adminUserId,
    firmId: firm.firmId,
    companyId,
  };

  const uploaded = await uploadDocument(companySession, {
    companyId,
    subjectType: 'COMPANY',
    subjectId: companyId,
    docType: 'ARTICLES_OF_INCORPORATION',
    label: 'Articles',
    contentType: 'application/pdf',
    bytes: PLAINTEXT,
  });
  documentId = uploaded.id;
  objectKey = uploaded.s3Key;
});

afterAll(async () => {
  evictDek();
  __setStorageProvider(undefined);
  if (firm) await destroyFirm(firm.firmId);
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('a document in storage', () => {
  it('is ciphertext — the provider holds nothing readable', () => {
    const stored = objects.get(objectKey)!;
    const raw = stored.toString('latin1');

    expect(raw).not.toContain('%PDF');
    expect(raw).not.toContain('000123456789');
    expect(raw).not.toContain('021000021');
    // Nonce + tag overhead on top of the base64 of the original.
    expect(stored.length).toBeGreaterThan(PLAINTEXT.length);
  });

  it('records the plaintext size, not the ciphertext size', async () => {
    // What a firm user is being told is how big the document is.
    const row = await readRow<{ size_bytes: string; content_encryption: string }>(
      'select size_bytes::text, content_encryption from documents where id = $1',
      documentId,
    );
    expect(Number(row?.size_bytes)).toBe(PLAINTEXT.length);
    expect(row?.content_encryption).toBe('DEK_AES_256_GCM');
  });

  it('round-trips exactly', async () => {
    const document = await readDocument(firmSession, documentId);
    expect(document?.bytes.equals(PLAINTEXT)).toBe(true);
    expect(document?.contentType).toBe('application/pdf');
  });

  it('is readable by the company too, for a COMPANY_VISIBLE document', async () => {
    const document = await readDocument(companySession, documentId);
    expect(document?.bytes.equals(PLAINTEXT)).toBe(true);
  });

  it('writes a DOCUMENT_VIEWED row on every read', async () => {
    const before = await countViews();
    await readDocument(firmSession, documentId);
    expect(await countViews()).toBe(before + 1);
  });

  it('is bound to its object key', async () => {
    // The key is the AAD, so a ciphertext moved to a different key fails to
    // open even under the correct data key — an attacker who can write to the
    // bucket cannot swap one company's document for another's.
    const stored = objects.get(objectKey)!;
    objects.set('tampered/key.pdf', stored);

    await readRow(
      'update documents set s3_key = $1 where id = $2',
      'tampered/key.pdf',
      documentId,
    );

    await expect(readDocument(firmSession, documentId)).rejects.toThrow();

    await readRow('update documents set s3_key = $1 where id = $2', objectKey, documentId);
  });
});

describe('a firm-only document', () => {
  let voidedCheckId: string;

  beforeAll(async () => {
    const uploaded = await uploadDocument(firmSession, {
      companyId,
      subjectType: 'COMPANY',
      subjectId: companyId,
      docType: 'VOIDED_CHECK',
      label: 'Voided check',
      contentType: 'image/jpeg',
      bytes: Buffer.from('fake jpeg bytes with 000123456789 in them'),
    });
    voidedCheckId = uploaded.id;
  });

  it('does not exist for a company session, so there is nothing to decrypt', async () => {
    // RLS removes the row before any crypto is reached. That ordering is the
    // point: the authorization is the row read, not a check on a value we
    // could only have obtained by being allowed to see it.
    expect(await readDocument(companySession, voidedCheckId)).toBeNull();
    expect(await readDocument(firmSession, voidedCheckId)).not.toBeNull();
  });
});

describe('cryptographic shred', () => {
  it('destroying the company data key makes its documents unreadable', async () => {
    // The property SSE under a provider-held key could never give: the bytes in
    // the bucket, and in every backup of it taken before today, become
    // undecryptable in one operation.
    await destroyCompanyDek(firmSession, companyId);
    evictDek(companyId);

    await expect(readDocument(firmSession, documentId)).rejects.toBeInstanceOf(
      DekDestroyedError,
    );

    // And the object is still sitting there, which is what makes the point.
    expect(objects.get(objectKey)).toBeDefined();
  });
});

async function countViews(): Promise<number> {
  const row = await readRow<{ n: string }>(
    `select count(*)::text as n from audit_log
      where company_id = $1 and action = 'DOCUMENT_VIEWED'`,
    companyId,
  );
  return Number(row?.n ?? 0);
}
