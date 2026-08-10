/**
 * Creates the runtime login role.
 *
 * The application must not connect as the table owner. On Railway the
 * connection string you are handed is a superuser, and a superuser bypasses Row
 * Level Security unconditionally — FORCE ROW LEVEL SECURITY does not apply to
 * it. Running the app on that credential would disable layer 1 completely while
 * every policy still looked correct in the schema.
 *
 * So: `app_user` logs in holding no table privileges of its own (NOINHERIT),
 * and acquires them for the duration of a single transaction by switching into
 * app_firm / app_company / app_subject / app_platform. lib/db/scoped.ts is the
 * only code that performs that switch.
 *
 * Run after `pnpm db:migrate`, which is what creates the four group roles.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.ADMIN_DATABASE_URL;
  const appPassword = process.env.APP_DB_PASSWORD;

  if (!url) throw new Error('ADMIN_DATABASE_URL is not set.');
  if (!appPassword || appPassword.length < 16) {
    throw new Error(
      'APP_DB_PASSWORD must be set and at least 16 characters. Generate one with:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"",
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const dbName = (await sql<{ current_database: string }[]>`select current_database()`)[0]!
      .current_database;

    await sql.begin(async (tx) => {
      // NOINHERIT is the point: privileges are acquired only by SET ROLE, for
      // the length of one transaction, and revert on commit or rollback.
      await tx.unsafe(`
        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = 'app_user') then
            create role app_user login noinherit password ${literal(appPassword)};
          else
            alter role app_user login noinherit password ${literal(appPassword)};
          end if;
        end
        $$;
      `);

      await tx.unsafe(`
        grant app_platform, app_firm, app_company, app_subject to app_user;
        grant connect on database ${quoteIdent(dbName)} to app_user;
        grant usage on schema public, app to app_user;
      `);

      // Belt and braces. If a future migration forgets, this still holds.
      await tx.unsafe(`
        alter role app_user nosuperuser nocreatedb nocreaterole nobypassrls;
      `);

      // Anything created later by the owner is picked up automatically, so a
      // new table does not silently arrive with no grants and break the app —
      // or arrive with too many and break the isolation guarantee. Note this
      // deliberately does NOT include worker_records-style blanket SELECT for
      // app_company: default privileges are per-role and we only widen the
      // firm role here.
      await tx.unsafe(`
        alter default privileges in schema public
          grant select, insert on tables to app_firm;
      `);
    });

    const [check] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'app_user'
    `;
    if (!check) throw new Error('app_user was not created.');
    if (check.rolsuper || check.rolbypassrls) {
      throw new Error('app_user still bypasses RLS. Refusing to report success.');
    }

    console.log('app_user is ready.');
    console.log('Point DATABASE_URL at it — NOT at the admin/superuser connection string.');
  } finally {
    await sql.end();
  }
}

/** Single-quoted SQL string literal. Role passwords cannot be parameterized. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
