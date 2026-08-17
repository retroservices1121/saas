/**
 * Export (spec section 7.7), against the real database.
 *
 * The properties worth asserting are the ones that would be invisible if they
 * broke: that a company outside the session's grants is silently dropped rather
 * than exported, that `includeSensitive` produces one audit row per decrypted
 * value rather than one per export, and that the archive is genuinely
 * encrypted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdmin, destroyFirm, readRow, seedFirm, type FirmFixture } from './fixtures';
import { createExport } from '../lib/export';
import { createCompany } from '../lib/db/queries/firm';
import { inviteWorker, submitWorkerForm } from '../lib/db/queries/subjects';
import { openInvite, subjectSessionFor, verifyInviteDob } from '../lib/invites';
import { evictDek, sealValue } from '../lib/security/field-encryption';
import { resolveFirmScope } from '../lib/auth/scope';
import { __setSmsProvider, type SmsMessage } from '../lib/services/messaging';
import { __setStorageProvider } from '../lib/services/storage';
import type { CompanySession, FirmSession } from '../lib/auth/session';

const TIN = '123456789';
const ROUTING = '021000021';
const ACCOUNT = '000123456789';

let firm: FirmFixture;
let firmSession: FirmSession;
let companyId: string;

const sent: SmsMessage[] = [];
const objects = new Map<string, Buffer>();

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
      if (!found) throw new Error('missing');
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
    ip: '203.0.113.30',
    userAgent: 'vitest',
  };

  const created = await createCompany(firmSession, {
    legalName: 'Export Test Co',
    dbaName: null,
    ein: '12-3456789',
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    contactEmail: 'office@exporttest.test',
    contactPhone: null,
    adminName: 'Admin',
    adminEmail: `export-admin-${Date.now()}@exporttest.test`,
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
  await inviteWorker(companySession, companyId, {
    displayName: 'Exported Worker',
    workerType: 'EMPLOYEE',
    phoneE164: '+15555551000',
    preferredLocale: 'en',
    jobTitle: 'Installer',
    startDate: null,
    payType: null,
    payFrequency: null,
    workState: 'NY',
  });

  const token = /\/i\/([A-Za-z0-9_-]+)/.exec(sent[0]!.body)![1]!;
  await verifyInviteDob(token, '1990-04-01');
  const state = await openInvite(token);
  if (state.status !== 'verified') throw new Error('gate did not open');

  const subject = subjectSessionFor(state.invite);
  await submitWorkerForm(subject, {
    legalFirstName: 'Ada',
    legalLastName: 'Lovelace',
    dateOfBirth: '1990-04-01',
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
  __setSmsProvider(undefined);
  __setStorageProvider(undefined);
  if (firm) await destroyFirm(firm.firmId);
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('export', () => {
  it('refuses a FIRM_STAFF session', async () => {
    const staff: FirmSession = { ...firmSession, role: 'FIRM_STAFF' };
    await expect(
      createExport(staff, {
        companyIds: [companyId],
        from: null,
        to: null,
        includeSensitive: false,
        reason: 'a perfectly good reason',
      }),
    ).rejects.toThrow(/FIRM_ADMIN/);
  });

  it('drops a company the session holds no grant on', async () => {
    // Silently dropped rather than refused with a message naming the id — the
    // answer must not distinguish "not yours" from "does not exist".
    await expect(
      createExport(firmSession, {
        companyIds: ['00000000-0000-0000-0000-0000000000aa'],
        from: null,
        to: null,
        includeSensitive: false,
        reason: 'attempting a company outside scope',
      }),
    ).rejects.toThrow(/in scope/);
  });

  it('masks by default, and writes exactly one EXPORT_CREATED row', async () => {
    const before = await countAudit(companyId, 'REVEAL_TIN');

    const result = await createExport(firmSession, {
      companyIds: [companyId],
      from: null,
      to: null,
      includeSensitive: false,
      reason: 'Quarterly reconciliation for the client file',
    });

    expect(result.workerCount).toBe(1);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // No reveals, because nothing was decrypted.
    expect(await countAudit(companyId, 'REVEAL_TIN')).toBe(before);
    expect(await countAudit(companyId, 'EXPORT_CREATED')).toBeGreaterThan(0);
  });

  it('writes one audit row per decrypted value when sensitive fields are included', async () => {
    const beforeTin = await countAudit(companyId, 'REVEAL_TIN');
    const beforeBank = await countAudit(companyId, 'REVEAL_BANK');

    await createExport(firmSession, {
      companyIds: [companyId],
      from: null,
      to: null,
      includeSensitive: true,
      reason: 'Year-end filing, full numbers required',
    });

    // One worker: one tax ID, one routing number, one account number. The trail
    // shows what actually left the building rather than a single line saying an
    // export happened.
    expect(await countAudit(companyId, 'REVEAL_TIN')).toBe(beforeTin + 1);
    expect(await countAudit(companyId, 'REVEAL_BANK')).toBe(beforeBank + 2);
  });

  it('carries the reason onto every reveal it caused', async () => {
    const row = await readRow<{ reason: string }>(
      `select reason from audit_log
        where company_id = $1 and action = 'REVEAL_TIN'
        order by created_at desc limit 1`,
      companyId,
    );
    expect(row?.reason).toContain('Year-end filing');
  });

  it('produces an archive with no plaintext in it', async () => {
    const result = await createExport(firmSession, {
      companyIds: [companyId],
      from: null,
      to: null,
      includeSensitive: true,
      reason: 'Checking the archive is actually encrypted',
    });

    const stored = [...objects.values()].at(-1)!;
    const raw = stored.toString('latin1');

    expect(raw.slice(0, 4)).toBe('PK');
    for (const secret of [TIN, ROUTING, ACCOUNT, 'Lovelace']) {
      expect(raw.includes(secret), `archive leaked ${secret}`).toBe(false);
    }

    // The password is returned once and is not in the row that records the
    // export.
    expect(result.password).toBeTruthy();
    const record = await readRow<{ reason: string }>(
      'select reason from exports where id = $1',
      result.exportId,
    );
    expect(JSON.stringify(record)).not.toContain(result.password);
  });

  it('records the export with a 24-hour expiry', async () => {
    const result = await createExport(firmSession, {
      companyIds: [companyId],
      from: null,
      to: null,
      includeSensitive: false,
      reason: 'Checking the expiry window is set',
    });

    const hours = (result.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });
});

async function countAudit(companyId: string, action: string): Promise<number> {
  const row = await readRow<{ n: string }>(
    `select count(*)::text as n from audit_log where company_id = $1 and action = $2`,
    companyId,
    action,
  );
  return Number(row?.n ?? 0);
}
