/**
 * Migration runner.
 *
 * Applies, in this fixed order:
 *   drizzle/prelude/*.sql    hand-written; the app schema and uuid v7
 *   drizzle/generated/*.sql  produced by `pnpm db:generate`, never hand-edited
 *   drizzle/post/*.sql       hand-written; RLS, roles, grants, triggers
 *
 * Drizzle-kit's own migrator only knows about the middle group, which is why
 * this exists: the RLS layer is the majority of the security model and has to
 * be versioned alongside the tables it protects.
 *
 * Runs as ADMIN_DATABASE_URL — the owning role. Never as app_user.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

const MIGRATION_DIRS = ['drizzle/prelude', 'drizzle/generated', 'drizzle/post'] as const;

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

async function collect(): Promise<Migration[]> {
  const out: Migration[] = [];
  for (const dir of MIGRATION_DIRS) {
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      // A missing directory is fine — `generated` does not exist until the
      // first `pnpm db:generate`.
      continue;
    }
    for (const entry of entries) {
      const sql = await readFile(join(dir, entry), 'utf8');
      out.push({
        // Namespaced so a filename collision across directories is impossible.
        filename: `${dir}/${entry}`,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error(
      'ADMIN_DATABASE_URL is not set. Migrations run as the table owner, not as app_user.',
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const migrations = await collect();
  if (migrations.length === 0) {
    console.log('No migrations found.');
    await sql.end();
    return;
  }

  try {
    // The bookkeeping table lives in the first prelude migration, so on a
    // virgin database it does not exist yet. Treat that as "nothing applied".
    let applied = new Map<string, string>();
    try {
      const rows = await sql<{ filename: string; checksum: string }[]>`
        select filename, checksum from app.schema_migrations
      `;
      applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    } catch {
      console.log('No migration history yet — bootstrapping.');
    }

    // If ANY hand-written post migration changed, re-apply ALL of them, in
    // order.
    //
    // They are idempotent by construction, so re-running is free. What is not
    // free is the alternative: these files revoke and re-grant privileges on
    // the tables they govern, and a later file often narrows what an earlier
    // one granted. Re-applying only the changed file restores the wider grant
    // and silently drops the narrowing — the failure surfaces later as a role
    // that can read a column it should not, which is precisely the class of bug
    // this whole schema exists to prevent, arriving through the tool meant to
    // prevent it.
    const postChanged = migrations.some(
      (m) =>
        m.filename.startsWith('drizzle/post/') &&
        applied.has(m.filename) &&
        applied.get(m.filename) !== m.checksum,
    );
    if (postChanged) {
      console.log('A post migration changed — re-applying all of drizzle/post in order.');
    }

    let ran = 0;
    for (const m of migrations) {
      const previous = applied.get(m.filename);
      const forced = postChanged && m.filename.startsWith('drizzle/post/');

      if (forced && previous && previous === m.checksum) {
        console.log(`~ ${m.filename} (unchanged, re-applying after a sibling change)`);
      } else if (previous && previous !== m.checksum) {
        // A hand-written post/ migration is allowed to be re-run: every
        // statement in it is idempotent by construction (create or replace,
        // drop policy if exists, add constraint after drop). A generated
        // migration is not, and editing one is always a mistake.
        if (m.filename.startsWith('drizzle/generated/')) {
          throw new Error(
            `${m.filename} has changed since it was applied. Generated migrations are ` +
              'immutable — create a new one with `pnpm db:generate` instead of editing this.',
          );
        }
        console.log(`~ ${m.filename} (changed, re-applying)`);
      } else if (previous) {
        continue;
      } else {
        console.log(`+ ${m.filename}`);
      }

      await sql.begin(async (tx) => {
        // Simple-query protocol: the whole file goes to the server as one
        // script, so dollar-quoted function bodies and their embedded
        // semicolons are parsed by Postgres rather than by a regex here.
        await tx.unsafe(m.sql);
        await tx`
          insert into app.schema_migrations (filename, checksum)
          values (${m.filename}, ${m.checksum})
          on conflict (filename) do update set checksum = excluded.checksum,
                                               applied_at = now()
        `;
      });
      ran++;
    }

    console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
