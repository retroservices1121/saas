/**
 * The reminder job (spec section 11).
 *
 * Runs daily. A subject that has been INVITED or IN_PROGRESS for three days
 * gets a reminder in their own language; again at seven and at fourteen. After
 * fourteen the subject is marked NEEDS_ATTENTION and the company admin is
 * notified for a worker, or the firm for a company.
 *
 * Two things follow from the invite design and are worth stating.
 *
 * A reminder cannot resend the original link. The raw token was never stored —
 * only its sha256 — which is exactly the property that makes a database dump
 * useless. So a reminder issues a NEW invite, which supersedes the old one.
 * That is better than resending anyway: the recipient gets a fresh seven-day
 * window rather than a link that expires the day after they are reminded.
 *
 * The message says nothing about what is missing. Spec section 11: reminder
 * content "never includes what data is missing beyond a generic prompt, since
 * SMS is not a secure channel". "Your bank details are missing" tells whoever
 * picks up the phone something they did not know.
 */
import { auditSystem, type AdminSql, type JobResult } from './context';
import { sendInviteReminder } from '../notifications';
import { inviteUrl } from '../invites';
import { hashPassword } from '../security/password';
import { uuidv7 } from '../uuid';
import { randomBytes, createHash } from 'node:crypto';
import type { Locale } from '../../i18n/request';

/** Days after which a reminder is due. After the last one, escalate. */
const REMINDER_DAYS = [3, 7, 14] as const;
const ESCALATE_AFTER_DAYS = 14;
const INVITE_TTL_DAYS = 7;

interface PendingSubject {
  subject_type: 'WORKER' | 'OWNER';
  subject_id: string;
  company_id: string;
  firm_id: string;
  company_name: string;
  display_name: string;
  phone_e164: string;
  preferred_locale: Locale;
  days_waiting: number;
  reminders_sent: number;
  expected_dob: string | null;
  company_admin_email: string | null;
}

/**
 * Everything outstanding, with how long it has been outstanding and how many
 * reminders it has already had.
 *
 * One query across both subject tables rather than two passes: the escalation
 * rule is the same for both, and two queries would drift apart the first time
 * one of them is changed.
 */
async function findPending(sql: AdminSql, now: Date): Promise<PendingSubject[]> {
  return sql<PendingSubject[]>`
    with subjects as (
      select 'WORKER'::text as subject_type, w.id as subject_id, w.company_id,
             w.display_name, w.phone_e164, w.preferred_locale, w.created_at,
             (select r.date_of_birth from worker_records r
               where r.worker_id = w.id and r.is_current) as expected_dob
        from workers w
       where w.status in ('INVITED', 'IN_PROGRESS')
         and w.archived_at is null
      union all
      select 'OWNER'::text, o.id, o.company_id,
             o.display_name, o.phone_e164, o.preferred_locale, o.created_at,
             o.date_of_birth
        from company_owners o
       where o.status in ('INVITED', 'IN_PROGRESS')
    )
    select s.subject_type,
           s.subject_id,
           s.company_id,
           c.firm_id,
           c.legal_name       as company_name,
           s.display_name,
           s.phone_e164,
           s.preferred_locale,
           floor(extract(epoch from (${now} - s.created_at)) / 86400)::int as days_waiting,
           (select count(*)::int from reminders rm
             where rm.subject_id = s.subject_id and rm.sent_at is not null) as reminders_sent,
           s.expected_dob::text as expected_dob,
           (select u.email from users u
             where u.company_id = s.company_id and u.role = 'COMPANY_ADMIN'
               and u.status = 'active' order by u.created_at limit 1) as company_admin_email
      from subjects s
      join companies c on c.id = s.company_id
     where c.status = 'active'
     order by s.created_at
  `;
}

/**
 * How many reminders should have been sent by now. Comparing that against how
 * many actually went out is what makes the job idempotent — running it twice in
 * one day sends nothing the second time, and a job that was down for a week
 * catches up to the right count rather than sending four messages at once.
 */
function remindersDue(daysWaiting: number): number {
  return REMINDER_DAYS.filter((day) => daysWaiting >= day).length;
}

export async function runReminders(
  sql: AdminSql,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<JobResult> {
  const now = options.now ?? new Date();
  const pending = await findPending(sql, now);

  const result: JobResult = {
    name: 'reminders',
    examined: pending.length,
    acted: 0,
    notes: [],
  };

  for (const subject of pending) {
    const due = remindersDue(subject.days_waiting);

    // --- escalation ------------------------------------------------------
    if (subject.days_waiting >= ESCALATE_AFTER_DAYS && subject.subject_type === 'WORKER') {
      if (options.dryRun) {
        result.notes.push(`would escalate worker ${subject.subject_id}`);
      } else {
        const updated = await sql`
          update workers set status = 'NEEDS_ATTENTION'
           where id = ${subject.subject_id} and status <> 'NEEDS_ATTENTION'
           returning id
        `;
        if (updated.length > 0) {
          await auditSystem(sql, {
            firmId: subject.firm_id,
            companyId: subject.company_id,
            action: 'REMINDER_SENT',
            targetType: 'workers',
            targetId: subject.subject_id,
            metadata: {
              escalated: true,
              daysWaiting: subject.days_waiting,
              notified: subject.company_admin_email ? 'COMPANY_ADMIN' : 'FIRM',
            },
          });
          result.acted++;
          result.notes.push(`escalated worker ${subject.subject_id} to NEEDS_ATTENTION`);
        }
      }
      continue;
    }

    if (due <= subject.reminders_sent) continue;

    // --- reminder --------------------------------------------------------
    if (options.dryRun) {
      result.notes.push(
        `would remind ${subject.subject_type} ${subject.subject_id} (day ${subject.days_waiting})`,
      );
      result.acted++;
      continue;
    }

    // A fresh link, because the old token exists nowhere in recoverable form.
    const token = randomBytes(32).toString('base64url');
    const inviteId = uuidv7();

    await sql.begin(async (tx) => {
      await tx`
        update invites set consumed_at = now()
         where subject_id = ${subject.subject_id} and consumed_at is null
      `;
      await tx`
        insert into invites (id, company_id, subject_type, subject_id, token_hash,
                             expected_dob_hash, expires_at, sent_at)
        values (
          ${inviteId}, ${subject.company_id}, ${subject.subject_type}::subject_type,
          ${subject.subject_id},
          ${createHash('sha256').update(token).digest('hex')},
          ${subject.expected_dob ? hashPassword(subject.expected_dob) : null},
          ${new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000)},
          now()
        )
      `;
      await tx`
        insert into reminders (company_id, subject_type, subject_id, reason,
                               scheduled_for, sent_at, channel, attempt)
        values (
          ${subject.company_id}, ${subject.subject_type}::subject_type, ${subject.subject_id},
          ${`day-${subject.days_waiting}`}, ${now}, ${now}, 'SMS', ${subject.reminders_sent + 1}
        )
      `;
    });

    await sendInviteReminder({
      subjectType: subject.subject_type,
      phoneE164: subject.phone_e164,
      locale: subject.preferred_locale,
      companyName: subject.company_name,
      url: inviteUrl(token),
    });

    await auditSystem(sql, {
      firmId: subject.firm_id,
      companyId: subject.company_id,
      action: 'REMINDER_SENT',
      targetType: subject.subject_type === 'WORKER' ? 'workers' : 'company_owners',
      targetId: subject.subject_id,
      metadata: {
        attempt: subject.reminders_sent + 1,
        daysWaiting: subject.days_waiting,
        channel: 'SMS',
      },
    });

    result.acted++;
    result.notes.push(
      `reminded ${subject.subject_type} ${subject.subject_id} (attempt ${
        subject.reminders_sent + 1
      })`,
    );
  }

  return result;
}
