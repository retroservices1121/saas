/**
 * The job runner.
 *
 *   pnpm jobs reminders          send due reminders and escalate stale invites
 *   pnpm jobs retention          purge eligible records
 *   pnpm jobs expire-exports     hard-delete export artifacts past 24 hours
 *   pnpm jobs prune-sessions     remove long-expired staff sessions
 *   pnpm jobs nightly            all of the above, in that order
 *   pnpm jobs destroy-key <id> "<reason>"   cryptographic shred, irreversible
 *
 * Add `--dry-run` to any of them to see what would happen without doing it.
 *
 * These connect as the table owner. See the note at the top of
 * lib/jobs/context.ts for why that is necessary and what it costs.
 */
import 'dotenv/config';
import { openAdminConnection, type JobResult } from '../lib/jobs/context';
import { runReminders } from '../lib/jobs/reminders';
import {
  destroyCompanyKey,
  expireExports,
  pruneSessions,
  purgeRecords,
} from '../lib/jobs/retention';

function report(result: JobResult): void {
  console.log(
    `${result.name}: examined ${result.examined}, acted on ${result.acted}`,
  );
  for (const note of result.notes) console.log(`  ${note}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'nightly';
  const positional = args.filter((arg) => !arg.startsWith('--')).slice(1);

  const sql = openAdminConnection();

  try {
    switch (command) {
      case 'reminders':
        report(await runReminders(sql, { dryRun }));
        break;
      case 'retention':
        report(await purgeRecords(sql, { dryRun }));
        break;
      case 'expire-exports':
        report(await expireExports(sql, { dryRun }));
        break;
      case 'prune-sessions':
        report(await pruneSessions(sql));
        break;
      case 'destroy-key': {
        const [companyId, reason] = positional;
        if (!companyId || !reason) {
          throw new Error('Usage: pnpm jobs destroy-key <companyId> "<reason>"');
        }
        report(await destroyCompanyKey(sql, companyId, reason));
        break;
      }
      case 'nightly':
        report(await runReminders(sql, { dryRun }));
        report(await purgeRecords(sql, { dryRun }));
        report(await expireExports(sql, { dryRun }));
        report(await pruneSessions(sql));
        break;
      default:
        throw new Error(`Unknown job: ${command}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
