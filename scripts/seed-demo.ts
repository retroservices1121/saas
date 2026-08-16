/**
 * Seeds a demo tenant and prints the links you need to walk the product.
 *
 * Everything goes through the real code paths — createCompany, inviteWorker,
 * inviteOwner — so this exercises the same grants, policies, and encryption a
 * real request would. Nothing here writes past RLS.
 *
 *   pnpm db:seed
 *
 * Safe to run repeatedly; each run creates a fresh firm.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createCompany } from '../lib/db/queries/firm';
import { inviteOwner, inviteWorker } from '../lib/db/queries/subjects';
import { resolveFirmScope } from '../lib/auth/scope';
import { uuidv7 } from '../lib/uuid';
import { __setSmsProvider, type SmsMessage } from '../lib/services/messaging';
import type { CompanySession, FirmSession } from '../lib/auth/session';

const captured: SmsMessage[] = [];

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set.');

  __setSmsProvider({
    name: 'capture',
    async send(message) {
      captured.push(message);
    },
  });

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const tag = randomBytes(3).toString('hex');
  const firmId = uuidv7();
  const firmUserId = uuidv7();

  // The firm and its first admin are the one thing that cannot be created
  // through the application: there is no session that predates them.
  await admin.begin(async (tx) => {
    await tx`
      insert into firms (id, name, contact_email, status)
      values (${firmId}, ${`Demo Accounting ${tag}`}, ${`firm-${tag}@example.test`}, 'active')
    `;
    await tx`
      insert into users (id, email, name, role, firm_id, status, totp_secret_enc, totp_enabled_at)
      values (
        ${firmUserId}, ${`firm-admin-${tag}@example.test`}, 'Demo Firm Admin',
        'FIRM_ADMIN', ${firmId}, 'active', ${Buffer.from(randomBytes(60))}, now()
      )
    `;
  });

  const firmSession: FirmSession = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firmUserId,
    firmId,
    companyIds: [],
    ip: '127.0.0.1',
    userAgent: 'seed-demo',
  };

  const company = await createCompany(firmSession, {
    legalName: `Northside Drywall ${tag} LLC`,
    dbaName: null,
    ein: '12-3456789',
    addressLine1: '14 Mill Road',
    addressLine2: null,
    city: 'Yonkers',
    state: 'NY',
    postalCode: '10701',
    contactEmail: `office-${tag}@example.test`,
    contactPhone: '+19145550100',
    adminName: 'Dolores Vega',
    adminEmail: `company-admin-${tag}@example.test`,
  });

  const scoped: FirmSession = {
    ...firmSession,
    companyIds: await resolveFirmScope(firmId, firmUserId),
  };
  void scoped;

  const companySession: CompanySession = {
    kind: 'company',
    role: 'COMPANY_ADMIN',
    userId: company.adminUserId,
    firmId,
    companyId: company.companyId,
    ip: '127.0.0.1',
    userAgent: 'seed-demo',
  };

  const worker = await inviteWorker(companySession, company.companyId, {
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

  const owner = await inviteOwner(companySession, company.companyId, {
    displayName: 'D. Vega',
    ownershipPercent: 100,
    phoneE164: '+15555550200',
    preferredLocale: 'en',
  });

  const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  console.log('');
  console.log('  Demo tenant seeded.');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  Firm            Demo Accounting ${tag}`);
  console.log(`  Company         Northside Drywall ${tag} LLC`);
  console.log('');
  console.log('  Company admin setup link (24h, single use):');
  console.log(`    ${origin}/setup/${company.setupToken}`);
  console.log(`    signs in afterwards as  company-admin-${tag}@example.test`);
  console.log('');
  console.log('  Worker invite (Spanish, gate pins on first visit):');
  console.log(`    ${worker.invite.url}`);
  console.log('');
  console.log('  Owner invite (English):');
  console.log(`    ${owner.invite.url}`);
  console.log('');
  console.log('  The firm admin has no password — this script cannot set one without');
  console.log('  an authenticator. Use the company admin setup link above to sign in.');
  console.log('');

  await admin.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
