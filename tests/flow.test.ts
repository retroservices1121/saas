/**
 * The whole path, end to end, against the real database:
 *
 *   firm creates a company
 *     → company invites a worker
 *       → worker opens the link, clears the date-of-birth gate, submits
 *         → worker signs both documents
 *           → firm reveals one field, with a reason
 *
 * Individual pieces are covered elsewhere. What this file tests is that the
 * pieces still hold when they are wired together — in particular that the
 * company, at every point along the way, can see nothing it should not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAdmin,
  destroyFirm,
  readRow,
  seedFirm,
  type FirmFixture,
} from './fixtures';
import { createCompany, getWorkerRecordForFirm, listWorkersForFirm } from '../lib/db/queries/firm';
import { inviteOwner, inviteWorker, submitWorkerForm } from '../lib/db/queries/subjects';
import {
  listWorkersForCompany,
  listDocumentsForCompany,
  findByIdInScope,
} from '../lib/db/queries/company';
import { openInvite, verifyInviteDob, subjectSessionFor, consumeInvite } from '../lib/invites';
import { captureSignature, missingSignatures, REQUIRED_SIGNATURES } from '../lib/esign/sign';
import { renderDocument } from '../lib/esign/documents';
import {
  decryptField,
  evictDek,
  sealValue,
  DecryptForbiddenError,
} from '../lib/security/field-encryption';
import { resolveFirmScope } from '../lib/auth/scope';
import { scanForSensitiveFields } from '../lib/security/response-scan';
import { sql } from 'drizzle-orm';
import { withScope, schema, ScopeViolationError } from '../lib/db/scoped';
import { __setSmsProvider, type SmsMessage } from '../lib/services/messaging';
import { __setStorageProvider } from '../lib/services/storage';
import type { CompanySession, FirmSession } from '../lib/auth/session';

let firm: FirmFixture;
let firmSession: FirmSession;
let companySession: CompanySession;
let companyId: string;

/** Captured outbound SMS, so the test can read the link the worker would tap. */
const sent: SmsMessage[] = [];

/** In-memory object store, so signature PDFs do not litter the working tree. */
const objects = new Map<string, Buffer>();

const TIN = '123456789';
const ROUTING = '021000021';
const ACCOUNT = '000123456789';
const DOB = '1990-04-01';

beforeAll(async () => {
  __setSmsProvider({
    name: 'test',
    async send(message) {
      sent.push(message);
    },
  });

  __setStorageProvider({
    name: 'test',
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) throw new Error(`no object ${key}`);
      return found;
    },
    async delete(key) {
      objects.delete(key);
    },
    async signedGetUrl(key) {
      return `test://${key}`;
    },
    async signedPutUrl(key) {
      return `test://${key}`;
    },
  });

  firm = await seedFirm();
  firmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
    ip: '203.0.113.20',
    userAgent: 'vitest',
  };
});

afterAll(async () => {
  evictDek();
  __setSmsProvider(undefined);
  __setStorageProvider(undefined);
  if (firm) await destroyFirm(firm.firmId);
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('7.1 firm onboards a company', () => {
  it('creates the company, its data key, the grant, and a pending admin', async () => {
    const created = await createCompany(firmSession, {
      legalName: 'Northside Drywall LLC',
      dbaName: null,
      ein: '12-3456789',
      addressLine1: '14 Mill Road',
      addressLine2: null,
      city: 'Yonkers',
      state: 'NY',
      postalCode: '10701',
      contactEmail: 'office@northside.test',
      contactPhone: '+19145550100',
      adminName: 'Dolores Vega',
      adminEmail: `admin-${Date.now()}@northside.test`,
    });

    companyId = created.companyId;
    expect(created.setupToken).toHaveLength(43); // 32 bytes, base64url

    const company = await readRow<{ dek_key_id: string; onboarding_status: string }>(
      'select dek_key_id, onboarding_status from companies where id = $1',
      companyId,
    );
    expect(company?.dek_key_id).toMatch(/^local:/);
    expect(company?.onboarding_status).toBe('PENDING');

    const admin = await readRow<{ status: string; role: string }>(
      'select status, role from users where id = $1',
      created.adminUserId,
    );
    // Pending until they follow the setup link and enrol an authenticator.
    expect(admin).toEqual({ status: 'pending', role: 'COMPANY_ADMIN' });

    companySession = {
      kind: 'company',
      role: 'COMPANY_ADMIN',
      userId: created.adminUserId,
      firmId: firm.firmId,
      companyId,
      ip: '198.51.100.7',
      userAgent: 'vitest',
    };
  });

  it('puts the company in the firm\'s scope on the next session, not before', async () => {
    // The session that created it still has an empty scope — scope is resolved
    // at session start, and this one started before the company existed.
    expect(firmSession.companyIds).toEqual([]);

    const scope = await resolveFirmScope(firm.firmId, firm.firmAdminUserId);
    expect(scope).toContain(companyId);

    firmSession = { ...firmSession, companyIds: scope };
  });
});

// ---------------------------------------------------------------------------

describe('7.4 / 7.5 the worker path', () => {
  let workerId: string;
  let inviteToken: string;

  it('the company invites a worker and an SMS goes out with a link', async () => {
    sent.length = 0;

    const result = await inviteWorker(companySession, companyId, {
      displayName: 'A. Lovelace',
      workerType: 'EMPLOYEE',
      phoneE164: '+15555550100',
      preferredLocale: 'es',
      jobTitle: 'Installer',
      startDate: '2026-09-01',
      payType: 'HOURLY',
      payFrequency: 'WEEKLY',
      workState: 'NY',
    });

    workerId = result.subjectId;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.locale).toBe('es');
    expect(sent[0]?.body).toContain('Northside Drywall LLC');

    const match = /\/i\/([A-Za-z0-9_-]+)/.exec(sent[0]!.body);
    expect(match, 'the SMS carries an invite link').not.toBeNull();
    inviteToken = match![1]!;
  });

  it('the raw token is not in the database', async () => {
    // A dump yields no working links.
    const row = await readRow<{ n: string }>(
      'select count(*)::text as n from invites where token_hash = $1',
      inviteToken,
    );
    expect(row?.n).toBe('0');
  });

  it('the link opens, unverified, and names the inviting company', async () => {
    const state = await openInvite(inviteToken);
    expect(state.status).toBe('unverified');
    if (state.status !== 'unverified') throw new Error('unreachable');

    // Screen 1 names the company: a form asking for an SSN that does not say
    // who is asking is indistinguishable from a phishing page.
    expect(state.invite.companyName).toBe('Northside Drywall LLC');
    expect(state.invite.displayName).toBe('A. Lovelace');
    expect(state.invite.preferredLocale).toBe('es');
  });

  it('the date-of-birth gate pins on first use and then enforces itself', async () => {
    expect((await verifyInviteDob(inviteToken, DOB)).status).toBe('ok');

    // A different date now fails, and counts against the five.
    const wrong = await verifyInviteDob(inviteToken, '1991-04-01');
    expect(wrong.status).toBe('wrong');
    if (wrong.status !== 'wrong') throw new Error('unreachable');
    expect(wrong.remaining).toBe(4);

    // The right one still works.
    expect((await verifyInviteDob(inviteToken, DOB)).status).toBe('ok');
  });

  it('the company cannot read the gate answer, the token, or the draft', async () => {
    // These three columns are not in app_company's column grant on invites.
    for (const column of ['expected_dob_hash', 'token_hash', 'draft']) {
      await expect(
        withScope(companySession, async (db) =>
          db.execute(sql`select ${sql.raw(column)} from invites limit 1`),
        ),
        `company could name invites.${column}`,
      ).rejects.toBeInstanceOf(ScopeViolationError);
    }
  });

  it('the worker submits, and version 1 is written with everything encrypted', async () => {
    const state = await openInvite(inviteToken);
    if (state.status !== 'verified') throw new Error(`expected verified, got ${state.status}`);

    const subject = subjectSessionFor(state.invite, {
      ip: '198.51.100.42',
      userAgent: 'vitest-mobile',
    });

    const recordId = await submitWorkerForm(subject, {
      legalFirstName: 'Ada',
      legalLastName: 'Lovelace',
      dateOfBirth: DOB,
      addressLine1: '5 Marylebone Road',
      city: 'Yonkers',
      state: 'NY',
      postalCode: '10701',
      email: 'ada@example.test',
      phoneE164: '+15555550100',
      tinType: 'SSN',
      // Sealed at the screen that collects it, exactly as the form does — the
      // plaintext never reaches the draft or the submit call.
      tin: await sealValue(subject, companyId, TIN),
      bankName: 'Test Bank',
      bankAccountType: 'CHECKING',
      routing: await sealValue(subject, companyId, ROUTING),
      account: await sealValue(subject, companyId, ACCOUNT),
      emergencyContactName: 'C. Babbage',
      emergencyContactPhone: '+15555550111',
      emergencyContactRelationship: 'Colleague',
    });

    const record = await readRow<{
      version: number;
      is_current: boolean;
      tin_last4: string;
      tin_enc: Buffer;
      submitted_via: string;
    }>(
      'select version, is_current, tin_last4, tin_enc, submitted_via from worker_records where id = $1',
      recordId,
    );

    // The version comes from the trigger, not from the client.
    expect(record?.version).toBe(1);
    expect(record?.is_current).toBe(true);
    expect(record?.tin_last4).toBe('6789');
    expect(record?.submitted_via).toBe('WORKER_FORM');

    // The tax ID is not recoverable from the stored bytes.
    expect(record?.tin_enc.toString('latin1')).not.toContain(TIN);

    const worker = await readRow<{ status: string }>(
      'select status from workers where id = $1',
      workerId,
    );
    expect(worker?.status).toBe('SUBMITTED');

    await consumeInvite(subject);
  });

  it('the link is dead once used', async () => {
    expect((await openInvite(inviteToken)).status).toBe('unusable');
  });

  it('the company sees a status chip and nothing else', async () => {
    const workers = await listWorkersForCompany(companySession);
    const row = workers.find((w) => w.id === workerId);

    expect(row?.status).toBe('SUBMITTED');
    // The name the company typed, not the legal name the worker supplied.
    expect(row?.displayName).toBe('A. Lovelace');
    expect(JSON.stringify(row)).not.toContain('Ada');
    expect(scanForSensitiveFields(workers, 'workers')).toEqual([]);

    // And the record itself is refused outright.
    expect(await findByIdInScope(companySession, 'worker_records', workerId)).toBeNull();
  });

  it('the firm sees the masked record', async () => {
    const workers = await listWorkersForFirm(firmSession, companyId);
    const row = workers.find((w) => w.id === workerId);

    expect(row?.tinLast4).toBe('6789');
    expect(row?.accountLast4).toBe('6789');
    expect(row?.hasCurrentRecord).toBe(true);
  });

  it('a reveal writes its audit row before it returns plaintext', async () => {
    const record = await getWorkerRecordForFirm(firmSession, workerId);
    expect(record?.tinEnc).not.toBeNull();

    const before = await readRow<{ n: string }>(
      "select count(*)::text as n from audit_log where company_id = $1 and action = 'REVEAL_TIN'",
      companyId,
    );

    const plaintext = await decryptField(record!.tinEnc!, {
      session: firmSession,
      action: 'REVEAL_TIN',
      reason: 'Preparing the year-end 1099 filing for this worker.',
      targetType: 'worker_records',
      targetId: record!.id,
      companyId,
    });

    expect(plaintext).toBe(TIN);

    const after = await readRow<{ n: string; reason: string }>(
      `select count(*)::text as n, max(reason) as reason from audit_log
        where company_id = $1 and action = 'REVEAL_TIN'`,
      companyId,
    );
    expect(Number(after?.n)).toBe(Number(before?.n) + 1);
    expect(after?.reason).toContain('1099');
  });

  it('refuses a reveal with a reason shorter than ten characters', async () => {
    const record = await getWorkerRecordForFirm(firmSession, workerId);
    await expect(
      decryptField(record!.tinEnc!, {
        session: firmSession,
        action: 'REVEAL_TIN',
        reason: 'because',
        targetType: 'worker_records',
        targetId: record!.id,
        companyId,
      }),
    ).rejects.toThrow(/ten characters/);
  });

  it('refuses a company session outright, and records the attempt', async () => {
    const record = await getWorkerRecordForFirm(firmSession, workerId);

    const before = await readRow<{ n: string }>(
      "select count(*)::text as n from audit_log where company_id = $1 and action = 'SECURITY_VIOLATION'",
      companyId,
    );

    await expect(
      decryptField(record!.tinEnc!, {
        session: companySession,
        action: 'REVEAL_TIN',
        reason: 'I would like to see this tax ID please.',
        targetType: 'worker_records',
        targetId: record!.id,
        companyId,
      }),
    ).rejects.toBeInstanceOf(DecryptForbiddenError);

    const after = await readRow<{ n: string }>(
      "select count(*)::text as n from audit_log where company_id = $1 and action = 'SECURITY_VIOLATION'",
      companyId,
    );
    expect(Number(after?.n)).toBe(Number(before?.n) + 1);
  });
});

// ---------------------------------------------------------------------------

describe('9. e-signature', () => {
  let workerId: string;

  beforeAll(async () => {
    const result = await inviteWorker(companySession, companyId, {
      displayName: 'G. Hopper',
      workerType: 'SUBCONTRACTOR',
      phoneE164: '+15555550200',
      preferredLocale: 'en',
      jobTitle: null,
      startDate: null,
      payType: null,
      payFrequency: null,
      workState: null,
    });
    workerId = result.subjectId;
  });

  it('hashes the exact text shown, and the hash changes with the language', () => {
    const en = renderDocument('DIRECT_DEPOSIT_AUTH', 'en', { companyName: 'X' });
    const es = renderDocument('DIRECT_DEPOSIT_AUTH', 'es', { companyName: 'X' });

    expect(en.hash).toHaveLength(64);
    expect(en.hash).not.toBe(es.hash);

    // The company name varies per signature and is stored in its own column, so
    // it must not move the hash — otherwise "which text did they agree to"
    // becomes unanswerable across two companies signing the same document.
    const other = renderDocument('DIRECT_DEPOSIT_AUTH', 'en', { companyName: 'Y' });
    expect(other.hash).toBe(en.hash);
  });

  it('records a signature with a reproducible PDF, stored firm-only', async () => {
    const result = await captureSignature(firmSession, {
      subjectType: 'WORKER',
      subjectId: workerId,
      companyId,
      companyName: 'Northside Drywall LLC',
      documentType: 'DATA_ACCURACY',
      locale: 'es',
      typedName: 'Grace Hopper',
      consentToElectronic: true,
      expectedName: 'Grace Hopper',
    });

    expect(result.nameMismatch).toBe(false);

    const signature = await readRow<{
      document_hash: string;
      document_locale: string;
      consent_to_electronic: boolean;
    }>(
      'select document_hash, document_locale, consent_to_electronic from signatures where id = $1',
      result.signatureId,
    );
    expect(signature?.document_locale).toBe('es');
    expect(signature?.consent_to_electronic).toBe(true);
    expect(signature?.document_hash).toBe(
      renderDocument('DATA_ACCURACY', 'es', { companyName: '' }).hash,
    );

    // The retained record is a real PDF and is firm-only.
    const document = await readRow<{ sensitivity: string; s3_key: string; content_type: string }>(
      'select sensitivity, s3_key, content_type from documents where id = $1',
      result.documentId,
    );
    expect(document?.sensitivity).toBe('FIRM_ONLY');
    expect(document?.content_type).toBe('application/pdf');

    const bytes = objects.get(document!.s3_key)!;
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(bytes.subarray(-6).toString('latin1')).toBe('%%EOF\n');
    // Spanish accents survive the WinAnsi encoding.
    expect(bytes.toString('latin1')).toContain('electr\xF3nicamente');
  });

  it('warns on a name mismatch without refusing the signature', async () => {
    const result = await captureSignature(firmSession, {
      subjectType: 'WORKER',
      subjectId: workerId,
      companyId,
      companyName: 'Northside Drywall LLC',
      documentType: 'DIRECT_DEPOSIT_AUTH',
      locale: 'en',
      typedName: 'grace  hopper',
      consentToElectronic: true,
      expectedName: 'Grace B. Hopper',
    });

    expect(result.nameMismatch).toBe(true);
    expect(result.signatureId).toBeTruthy();
  });

  it('refuses to record one without affirmative consent', async () => {
    await expect(
      captureSignature(firmSession, {
        subjectType: 'WORKER',
        subjectId: workerId,
        companyId,
        companyName: 'Northside Drywall LLC',
        documentType: 'DATA_ACCURACY',
        locale: 'en',
        typedName: 'Grace Hopper',
        consentToElectronic: false,
      }),
    ).rejects.toThrow(/affirmative consent/);
  });

  it('knows when a subject has signed everything they owe', async () => {
    const outstanding = await missingSignatures(
      firmSession,
      { subjectType: 'WORKER', subjectId: workerId },
      REQUIRED_SIGNATURES.WORKER,
    );
    expect(outstanding).toEqual([]);
  });

  it('the signature PDF is invisible to the company', async () => {
    const documents = await listDocumentsForCompany(companySession);
    expect(documents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('7.3 owners supply their own tax IDs', () => {
  it('the company creates an owner it can never complete itself', async () => {
    sent.length = 0;

    const result = await inviteOwner(companySession, companyId, {
      displayName: 'D. Vega',
      ownershipPercent: 100,
      phoneE164: '+15555550300',
      preferredLocale: 'en',
    });

    expect(sent).toHaveLength(1);

    // The company can see that the owner exists and that they have not
    // submitted. It cannot name tin_last4 — the column is not in its grant.
    await expect(
      withScope(companySession, async (db) =>
        db
          .select({ tinLast4: schema.companyOwners.tinLast4 })
          .from(schema.companyOwners)
          .limit(1),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);

    const owner = await readRow<{ status: string; tin_enc: Buffer | null }>(
      'select status, tin_enc from company_owners where id = $1',
      result.subjectId,
    );
    expect(owner?.status).toBe('INVITED');
    expect(owner?.tin_enc).toBeNull();
  });
});
