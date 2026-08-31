/**
 * Creates the first platform administrator.
 *
 * This is the one account the application cannot create for itself. Everything
 * else has a maker: a platform admin creates a firm and its first admin, a firm
 * admin creates a company and its first admin, a company admin invites owners
 * and workers. The chain has to start somewhere outside the request path,
 * because the first account has no session that predates it.
 *
 *   pnpm db:create-platform-admin "Ada Lovelace" ada@firm.example
 *
 * It runs on ADMIN_DATABASE_URL for that reason — no scope exists yet to run it
 * under, and `app_platform` cannot insert the row that would authorize it.
 *
 * It does NOT set a password. It issues the same 24-hour single-use setup link
 * the rest of the system uses, so the first admin enrolls their own password and
 * their own authenticator, and no operator ever knows their credentials. That is
 * also why this prints the link rather than emailing it: at bootstrap there may
 * be no mail credentials configured yet, and a link that silently went nowhere
 * would leave an account nobody can reach.
 *
 * Refuses to create a second one. After the first, use the platform UI — which
 * is audited, and this is not.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '../lib/uuid';

const SETUP_TOKEN_MS = 24 * 60 * 60 * 1000;

function usage(): never {
  console.error('Usage: pnpm db:create-platform-admin "Full Name" email@example.com');
  process.exit(1);
}

async function main(): Promise<void> {
  const [name, email] = process.argv.slice(2);
  if (!name || !email) usage();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`"${email}" is not an email address.`);
    process.exit(1);
  }

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set.');

  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });

  try {
    const existing = await sql<{ email: string }[]>`
      select email from users where role = 'PLATFORM_ADMIN' limit 1
    `;
    if (existing.length > 0) {
      console.error(
        `A platform admin already exists (${existing[0]!.email}).\n` +
          'Create further platform staff through the platform UI, where the action is audited.',
      );
      process.exit(1);
    }

    // Stored lowercase, because that is what the login lookup compares against.
    // Printed the same way, so the operator does not hand the new admin an
    // address in a case the database does not hold.
    const normalizedEmail = email.trim().toLowerCase();
    const userId = uuidv7();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await sql.begin(async (tx) => {
      // firm_id and company_id are both null: the check constraint from
      // migration 0001 requires exactly that pairing for PLATFORM_ADMIN.
      await tx`
        insert into users (id, email, name, role, firm_id, company_id, status)
        values (${userId}, ${normalizedEmail}, ${name}, 'PLATFORM_ADMIN', null, null, 'pending')
      `;
      await tx`
        insert into user_setup_tokens (id, user_id, token_hash, expires_at)
        values (${uuidv7()}, ${userId}, ${tokenHash},
                ${new Date(Date.now() + SETUP_TOKEN_MS)})
      `;
    });

    const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

    console.log('');
    console.log('  Platform administrator created.');
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log(`  ${name}  <${normalizedEmail}>`);
    console.log('');
    console.log('  Setup link — 24 hours, single use, sets a password and enrolls TOTP:');
    console.log('');
    console.log(`    ${origin}/setup/${token}`);
    console.log('');
    console.log('  This link is not stored anywhere and is not recoverable. If it expires');
    console.log('  before it is used, delete the row and run this again.');
    console.log('');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
