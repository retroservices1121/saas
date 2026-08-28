/**
 * Corrections (spec section 7.8), against the real database.
 *
 * The property worth pinning down is the one that is easy to lose in a
 * refactor: correcting a non-sensitive field must not decrypt anything. A
 * future change that renders the record into the form and re-encrypts whatever
 * comes back would still pass a naive "the correction saved" test, while
 * quietly turning every address fix into a full disclosure of a tax ID and
 * three REVEAL rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdmin, destroyFirm, readRow, seedFirm, type FirmFixture } from './fixtures';
import { createCompany, getWorkerRecordForFirm, listWorkerRecordVersions } from '../lib/db/queries/firm';
import { correctWorkerRecord, inviteWorker, submitWorkerForm } from '../lib/db/queries/subjects';
import { openInvite, subjectSessionFor, verifyInviteDob } from '../lib/invites';
import { evictDek, sealValue } from '../lib/security/field-encryption';
import { resolveFirmScope } from '../lib/auth/scope';
import { __setEmailProvider, type EmailMessage } from '../lib/services/messaging';
import type { CompanySession, FirmSession } from '../lib/auth/session';

const TIN = '123456789';
const ROUTING = '021000021';
const ACCOUNT = '000123456789';

let firm: FirmFixture;
let firmSession: FirmSession;
let companyId: string;
let workerId: string;

const sent: EmailMessage[] = [];

beforeAll(async () => {
  __setEmailProvider({
    name: 'test',
    async send(message) {
      sent.push(message);
    },
  });

  firm = await seedFirm();
  firmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
    ip: '203.0.113.40',
    userAgent: 'vitest',
  };

  const created = await createCompany(firmSession, {
    legalName: 'Corrections Test Co',
    dbaName: null,
    ein: '12-3456789',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    contactEmail: 'office@corrections.test',
    contactPhone: null,
    adminName: 'Admin',
    adminEmail: `corrections-${Date.now()}@corrections.test`,
  });
  companyId = created.companyId;
  firmSession = {
    ...firmSession,
    companyIds: await resolveFirmScope(firm.firmId, firm.firmAdminUserId),
  };

  const companySession: CompanySession = {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: created.adminUserId,
    firmId: firm.firmId,
    companyId,
  };

  sent.length = 0;
  const invited = await inviteWorker(companySession, companyId, {
    displayName: 'Typo Victim',
    workerType: 'EMPLOYEE',
    inviteEmail: 'typo@personal.test',
    phoneE164: '+15555552000',
    preferredLocale: 'en',
    jobTitle: null,
    startDate: null,
    payType: null,
    payFrequency: null,
    workState: null,
  });
  workerId = invited.subjectId;

  const token = /\/i\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!;
  await verifyInviteDob(token, '1990-04-01');
  const state = await openInvite(token);
  if (state.status !== 'verified') throw new Error('gate did not open');

  const subject = subjectSessionFor(state.invite);
  await submitWorkerForm(subject, {
    legalFirstName: 'Ada',
    legalLastName: 'Lovelace',
    dateOfBirth: '1990-04-01',
    addressLine1: '5 Marylbone Road', // the typo the correction fixes
    city: 'Yonkers',
    state: 'NY',
    postalCode: '10701',
    tinType: 'SSN',
    tin: await sealValue(subject, companyId, TIN),
    bankName: 'Test Bank',
    bankAccountType: 'CHECKING',
    routing: await sealValue(subject, companyId, ROUTING),
    account: await sealValue(subject, companyId, ACCOUNT),
  });
});

afterAll(async () => {
  evictDek();
  __setEmailProvider(undefined);
  if (firm) await destroyFirm(firm.firmId);
  await closeAdmin();
});

async function countReveals(): Promise<number> {
  const row = await readRow<{ n: string }>(
    `select count(*)::text as n from audit_log
      where company_id = $1 and action in ('REVEAL_TIN','REVEAL_BANK')`,
    companyId,
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------

describe('correcting a non-sensitive field', () => {
  it('carries the ciphertext forward byte for byte, and decrypts nothing', async () => {
    const before = await getWorkerRecordForFirm(firmSession, workerId);
    const revealsBefore = await countReveals();

    await correctWorkerRecord(
      firmSession,
      { workerId, companyId, reason: 'Street name was misspelled on submission' },
      {
        legalFirstName: before!.legalFirstName,
        legalLastName: before!.legalLastName,
        dateOfBirth: before!.dateOfBirth,
        addressLine1: '5 Marylebone Road', // fixed
        city: before!.city,
        state: before!.state,
        postalCode: before!.postalCode,
        tinType: before!.tinType,
        // Unchanged: the existing ciphertext, handed straight back.
        tin: { enc: before!.tinEnc!, last4: before!.tinLast4! },
        bankName: before!.bankName,
        bankAccountType: before!.bankAccountType,
        routing: { enc: before!.routingEnc!, last4: before!.routingLast4! },
        account: { enc: before!.accountEnc!, last4: before!.accountLast4! },
      },
    );

    const after = await getWorkerRecordForFirm(firmSession, workerId);

    expect(after!.version).toBe(before!.version + 1);
    expect(after!.addressLine1).toBe('5 Marylebone Road');

    // The whole point: identical bytes, so nothing was ever decrypted.
    expect(after!.tinEnc!.equals(before!.tinEnc!)).toBe(true);
    expect(after!.routingEnc!.equals(before!.routingEnc!)).toBe(true);
    expect(after!.accountEnc!.equals(before!.accountEnc!)).toBe(true);

    expect(await countReveals()).toBe(revealsBefore);
  });

  it('preserves the previous version rather than overwriting it', async () => {
    const versions = await listWorkerRecordVersions(firmSession, workerId);
    expect(versions.length).toBeGreaterThanOrEqual(2);

    const current = versions.filter((version) => version.isCurrent);
    expect(current).toHaveLength(1);

    const old = await readRow<{ address_line1: string; superseded_at: Date | null }>(
      `select address_line1, superseded_at from worker_records
        where worker_id = $1 and version = 1`,
      workerId,
    );
    // The typo is still on file, which is what makes "what did the record say
    // when we filed" answerable a year later.
    expect(old?.address_line1).toBe('5 Marylbone Road');
    expect(old?.superseded_at).not.toBeNull();
  });

  it('writes RECORD_CORRECTED with the reason', async () => {
    const row = await readRow<{ reason: string }>(
      `select reason from audit_log
        where company_id = $1 and action = 'RECORD_CORRECTED'
        order by created_at desc limit 1`,
      companyId,
    );
    expect(row?.reason).toContain('misspelled');
  });

  it('refuses a reason shorter than ten characters', async () => {
    const current = await getWorkerRecordForFirm(firmSession, workerId);
    await expect(
      correctWorkerRecord(
        firmSession,
        { workerId, companyId, reason: 'typo' },
        {
          legalFirstName: current!.legalFirstName,
          legalLastName: current!.legalLastName,
          dateOfBirth: current!.dateOfBirth,
          tinType: current!.tinType,
          tin: { enc: current!.tinEnc!, last4: current!.tinLast4! },
        },
      ),
    ).rejects.toThrow(/ten characters/);
  });
});

describe('correcting a sensitive field', () => {
  it('replaces the ciphertext when a new value is supplied', async () => {
    const before = await getWorkerRecordForFirm(firmSession, workerId);
    const replacement = '987654321';

    await correctWorkerRecord(
      firmSession,
      { workerId, companyId, reason: 'Worker transposed two digits of their SSN' },
      {
        legalFirstName: before!.legalFirstName,
        legalLastName: before!.legalLastName,
        dateOfBirth: before!.dateOfBirth,
        addressLine1: before!.addressLine1,
        city: before!.city,
        state: before!.state,
        postalCode: before!.postalCode,
        tinType: before!.tinType,
        tin: await sealValue(firmSession, companyId, replacement),
        bankName: before!.bankName,
        bankAccountType: before!.bankAccountType,
        routing: { enc: before!.routingEnc!, last4: before!.routingLast4! },
        account: { enc: before!.accountEnc!, last4: before!.accountLast4! },
      },
    );

    const after = await getWorkerRecordForFirm(firmSession, workerId);

    expect(after!.tinLast4).toBe('4321');
    expect(after!.tinEnc!.equals(before!.tinEnc!)).toBe(false);
    // Untouched fields still carry their original bytes.
    expect(after!.routingEnc!.equals(before!.routingEnc!)).toBe(true);
  });

  it('the superseded version still holds the value it was filed with', async () => {
    const old = await readRow<{ tin_last4: string }>(
      `select tin_last4 from worker_records where worker_id = $1 and version = 1`,
      workerId,
    );
    expect(old?.tin_last4).toBe('6789');
  });
});
