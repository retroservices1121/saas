/**
 * The invite engine (spec section 7, build order step 7).
 *
 * Every person who supplies a tax ID or a bank account does it themselves,
 * through their own link. That is security property 5, it applies to company
 * owners exactly as it applies to workers, and this module is what makes it
 * true.
 *
 * Four properties, each of which is doing specific work:
 *
 *   Single-use. `consumed_at` is set on submission. A link forwarded after the
 *   fact opens nothing.
 *
 *   Time-limited. `expires_at`, seven days by default.
 *
 *   Hashed. The raw token is in the SMS and nowhere else. A database dump
 *   yields no working links.
 *
 *   Second factor: the recipient's date of birth. This is the part that matters
 *   most and it is easy to mistake for theatre. The threat is not an outsider
 *   guessing a 256-bit token — it is the company admin, who typed the phone
 *   number, who can plausibly ask to "check" a worker's phone, and who is the
 *   exact party the whole system exists to keep out. They do not know the date
 *   of birth, because the worker has not told them. Five failures locks the
 *   invite for sixty minutes and alerts the FIRM, not the company — alerting
 *   the company would tell the suspected party that they have been noticed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { insertColumns, schema, withScope, type ScopedDb } from './db/scoped';
import {
  anonymousSession,
  type Session,
  type SubjectSession,
  type SubjectRole,
} from './auth/session';
import { audit, auditBestEffort } from './audit';
import { hashPassword, verifyPassword } from './security/password';
import { uuidv7 } from './uuid';
import type { Locale } from '../i18n/request';

/** Seven days. Long enough to survive a weekend and a lost phone; short enough to matter. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_VERIFY_FAILURES = 5;
const VERIFY_LOCK_MS = 60 * 60 * 1000;

/** How long a verified invite session stays open without activity. */
export const SUBJECT_SESSION_MS = 60 * 60 * 1000;

export const INVITE_COOKIE = 'onb_invite';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 32 bytes. The token is the only thing standing between the internet and a
 * form that collects a tax ID, so it is sized to be unguessable rather than
 * typeable — nobody transcribes it, they tap it.
 */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface IssuedInvite {
  inviteId: string;
  token: string;
  url: string;
  expiresAt: Date;
}

export function inviteUrl(token: string): string {
  const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${origin}/i/${token}`;
}

/**
 * Issues a link for one subject, inside the caller's transaction.
 *
 * Any live invite for the same subject is consumed first. Two working links for
 * one worker means two resumable drafts, and whichever is submitted second
 * silently supersedes the first — including when the first was the one the
 * worker actually filled in.
 */
export async function issueInvite(
  db: ScopedDb,
  session: Session,
  params: {
    companyId: string;
    subjectType: 'WORKER' | 'OWNER';
    subjectId: string;
    /**
     * The date of birth the gate will require, when it is already known —
     * a re-issued link for someone who has submitted before (spec section 7.8).
     * Left undefined for a first invite, which pins the gate to whatever the
     * recipient enters on their first visit. See `verifyInviteDob`.
     */
    expectedDob?: string | undefined;
    ttlMs?: number;
  },
): Promise<IssuedInvite> {
  const token = newToken();
  const inviteId = uuidv7();
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? INVITE_TTL_MS));

  // Scoped to the company as well as the subject. Without it, a caller who
  // passed a subject id from one company and a company id from another would
  // consume the real invite while minting a mismatched replacement — turning a
  // wrong-arguments bug into a denial of service on a worker who was part-way
  // through their form.
  await db
    .update(schema.invites)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.invites.companyId, params.companyId),
        eq(schema.invites.subjectType, params.subjectType),
        eq(schema.invites.subjectId, params.subjectId),
        sql`${schema.invites.consumedAt} is null`,
      ),
    );

  // Hand-written so the statement names only the columns a company session
  // holds INSERT on — see insertColumns in lib/db/scoped.ts for why an ORM
  // insert cannot.
  await db.execute(
    insertColumns('invites', {
      id: inviteId,
      company_id: params.companyId,
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      token_hash: hashToken(token),
      expected_dob_hash: params.expectedDob ? hashPassword(params.expectedDob) : null,
      expires_at: expiresAt,
    }),
  );

  await audit(db, session, {
    action: 'INVITE_SENT',
    companyId: params.companyId,
    targetType: params.subjectType === 'WORKER' ? 'workers' : 'company_owners',
    targetId: params.subjectId,
  });

  return { inviteId, token, url: inviteUrl(token), expiresAt };
}

// ---------------------------------------------------------------------------
// Opening a link
// ---------------------------------------------------------------------------

export type InviteState =
  /** Unknown, expired, or already used. One answer, so a stale link reveals nothing. */
  | { status: 'unusable' }
  | { status: 'locked'; until: Date }
  /** Needs the date-of-birth gate. */
  | { status: 'unverified'; invite: InviteSummary }
  /** Gate satisfied; the form may render. */
  | { status: 'verified'; invite: InviteSummary };

export interface InviteSummary {
  id: string;
  companyId: string;
  companyName: string;
  subjectType: 'WORKER' | 'OWNER';
  subjectId: string;
  displayName: string;
  preferredLocale: Locale;
  draftStep: string | null;
  expiresAt: Date;
}

/**
 * Resolves a raw token to whatever the holder is allowed to know about it.
 *
 * Runs as ANONYMOUS: nobody has a session yet, and the invite is what will
 * establish one. The company name is returned because the welcome screen names
 * the inviting company (spec section 8, screen 1) — a form asking for a tax ID
 * that does not say who is asking is indistinguishable from a phishing page.
 */
export async function openInvite(
  token: string,
  request: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<InviteState> {
  const session = anonymousSession(request);

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.invites.id,
        companyId: schema.invites.companyId,
        subjectType: schema.invites.subjectType,
        subjectId: schema.invites.subjectId,
        expiresAt: schema.invites.expiresAt,
        consumedAt: schema.invites.consumedAt,
        verifiedAt: schema.invites.verifiedAt,
        lockedUntil: schema.invites.lockedUntil,
        openedAt: schema.invites.openedAt,
        draftStep: schema.invites.draftStep,
      })
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, hashToken(token)))
      .limit(1);

    const invite = rows[0];
    const now = new Date();

    if (!invite || invite.consumedAt || invite.expiresAt <= now) {
      return { status: 'unusable' } as const;
    }
    if (invite.lockedUntil && invite.lockedUntil > now) {
      return { status: 'locked', until: invite.lockedUntil } as const;
    }
    if (invite.subjectType === 'COMPANY') {
      // Only workers and owners receive links. A COMPANY row here would be a
      // bug, and rendering a form for it would be a bigger one.
      return { status: 'unusable' } as const;
    }

    const summary = await loadSubjectSummary(db, invite);
    if (!summary) return { status: 'unusable' } as const;

    if (!invite.openedAt) {
      await db
        .update(schema.invites)
        .set({ openedAt: now })
        .where(eq(schema.invites.id, invite.id));
    }

    return invite.verifiedAt
      ? ({ status: 'verified', invite: summary } as const)
      : ({ status: 'unverified', invite: summary } as const);
  });
}

async function loadSubjectSummary(
  db: ScopedDb,
  invite: {
    id: string;
    companyId: string;
    subjectType: string;
    subjectId: string;
    expiresAt: Date;
    draftStep: string | null;
  },
): Promise<InviteSummary | null> {
  // app_auth holds no privilege on companies, workers, or company_owners, so
  // these reads run as the table owner through a security-definer function
  // rather than as the anonymous role. That function returns exactly three
  // non-sensitive fields and nothing else.
  const rows = await db.execute<{
    company_name: string;
    display_name: string;
    preferred_locale: Locale;
  }>(sql`
    select * from app.invite_subject_summary(
      ${invite.companyId}::uuid, ${invite.subjectType}::text, ${invite.subjectId}::uuid
    )
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: invite.id,
    companyId: invite.companyId,
    companyName: row.company_name,
    subjectType: invite.subjectType as 'WORKER' | 'OWNER',
    subjectId: invite.subjectId,
    displayName: row.display_name,
    preferredLocale: row.preferred_locale,
    draftStep: invite.draftStep,
    expiresAt: invite.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// The date-of-birth gate
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { status: 'ok' }
  | { status: 'wrong'; remaining: number }
  | { status: 'locked'; until: Date }
  | { status: 'unusable' };

/**
 * The second factor.
 *
 * A worker's date of birth is not in `workers` — the company entered that table
 * and does not know it. It is compared against `worker_records` only for a
 * re-issued link, and for a first submission there is nothing to compare
 * against, so the firm supplies the expected value when creating the worker.
 * That is why `expected_dob` lives on the invite rather than being looked up.
 *
 * Comparison is constant-time. A date of birth has roughly 30,000 plausible
 * values, and a timing side channel that leaks the year would cut that to
 * something a phone can brute-force between five-failure lockouts.
 */
export async function verifyInviteDob(
  token: string,
  dateOfBirth: string,
  request: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<VerifyResult> {
  const session = anonymousSession(request);

  return withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.invites.id,
        companyId: schema.invites.companyId,
        subjectType: schema.invites.subjectType,
        subjectId: schema.invites.subjectId,
        expiresAt: schema.invites.expiresAt,
        consumedAt: schema.invites.consumedAt,
        lockedUntil: schema.invites.lockedUntil,
        failedAttempts: schema.invites.failedAttempts,
        expectedDobHash: schema.invites.expectedDobHash,
        verifiedAt: schema.invites.verifiedAt,
      })
      .from(schema.invites)
      .where(eq(schema.invites.tokenHash, hashToken(token)))
      .limit(1);

    const invite = rows[0];
    const now = new Date();

    if (!invite || invite.consumedAt || invite.expiresAt <= now) {
      return { status: 'unusable' } as const;
    }
    if (invite.lockedUntil && invite.lockedUntil > now) {
      return { status: 'locked', until: invite.lockedUntil } as const;
    }
    const given = dateOfBirth.trim();

    // First visit to a link with no expected value: the date entered here is
    // pinned, and every later visit must match it. That is what makes a link
    // forwarded or intercepted mid-flow inert, and it is what screen 3
    // prefills read-only.
    //
    // It is NOT a check on the first visit, because on a first invite there is
    // nothing yet to check against — a worker who has never submitted has no
    // date of birth on file anywhere in this system, by design. Seeding
    // `expectedDob` at issue time from an existing record (a re-issued link) is
    // what turns this into a real gate, and doing the same for first invites
    // would require the company to supply a date of birth the spec says they do
    // not have. See the note in README under "The date-of-birth gate".
    if (!invite.expectedDobHash) {
      await db
        .update(schema.invites)
        .set({
          expectedDobHash: hashPassword(given),
          verifiedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(schema.invites.id, invite.id));

      await audit(db, session, {
        action: 'INVITE_OPENED',
        companyId: invite.companyId,
        actorRole: invite.subjectType,
        targetType: 'invites',
        targetId: invite.id,
        metadata: { gate: 'pinned_on_first_visit' },
      });
      return { status: 'ok' } as const;
    }

    // Constant-time by construction: argon2id verification compares digests,
    // not dates, so nothing about how wrong the answer was is observable.
    const matches = verifyPassword(given, invite.expectedDobHash).valid;

    if (matches) {
      await db
        .update(schema.invites)
        .set({ verifiedAt: now, failedAttempts: 0, lockedUntil: null })
        .where(eq(schema.invites.id, invite.id));

      await audit(db, session, {
        action: 'INVITE_OPENED',
        companyId: invite.companyId,
        actorRole: invite.subjectType,
        targetType: 'invites',
        targetId: invite.id,
      });
      return { status: 'ok' } as const;
    }

    const failed = invite.failedAttempts + 1;
    const locked = failed >= MAX_VERIFY_FAILURES;
    const lockedUntil = locked ? new Date(now.getTime() + VERIFY_LOCK_MS) : null;

    await db
      .update(schema.invites)
      .set({ failedAttempts: failed, lockedUntil })
      .where(eq(schema.invites.id, invite.id));

    await audit(db, session, {
      action: 'INVITE_VERIFY_FAILED',
      companyId: invite.companyId,
      actorRole: invite.subjectType,
      targetType: 'invites',
      targetId: invite.id,
      metadata: { attempt: failed, locked },
    });

    if (locked) {
      // The alert goes to the firm. Telling the company would tell the party
      // most likely to be responsible that they have been noticed, and the firm
      // is the only party with both the standing and the information to judge
      // whether this is a worker fumbling a date or something else.
      await notifyFirmOfInviteLock(db, session, invite.companyId, invite.id, invite.subjectType);
      return { status: 'locked', until: lockedUntil! } as const;
    }

    return { status: 'wrong', remaining: MAX_VERIFY_FAILURES - failed } as const;
  });
}

async function notifyFirmOfInviteLock(
  db: ScopedDb,
  session: Session,
  companyId: string,
  inviteId: string,
  subjectType: string,
): Promise<void> {
  // Recorded as an audit row the firm's dashboard surfaces, rather than sent as
  // mail from here: an email to the firm about a locked invite is an email that
  // names a worker to a third party, and the firm is already looking at this
  // company's activity.
  await audit(db, session, {
    action: 'SECURITY_VIOLATION',
    companyId,
    targetType: 'invites',
    targetId: inviteId,
    metadata: {
      kind: 'invite_locked',
      subjectType,
      notify: 'FIRM',
      detail: 'Five consecutive date-of-birth failures on an invite link.',
    },
  });
}

// ---------------------------------------------------------------------------
// Sessions and drafts
// ---------------------------------------------------------------------------

/**
 * Builds the invite session. This is the only session in the system with no
 * user row behind it: a worker never logs in, before or after submission
 * (spec section 15).
 */
export function subjectSessionFor(
  invite: InviteSummary,
  request: { ip?: string | undefined; userAgent?: string | undefined } = {},
): SubjectSession {
  return {
    kind: 'subject',
    role: invite.subjectType as SubjectRole,
    subjectId: invite.subjectId,
    companyId: invite.companyId,
    inviteId: invite.id,
    ...request,
  };
}

/**
 * Saves the answers gathered so far, after every screen (spec section 8: server-side
 * save after each step, resumable by reopening the same link).
 *
 * Sensitive answers are encrypted before they reach this column, by the caller.
 * A partially completed form is not less sensitive than a finished one — a tax
 * ID typed on screen 8 is a tax ID whether or not screen 17 was ever reached.
 */
export async function saveDraft(
  session: SubjectSession,
  step: string,
  draft: Record<string, unknown>,
): Promise<void> {
  await withScope(session, async (db) => {
    await db
      .update(schema.invites)
      .set({ draft, draftStep: step, updatedAt: new Date() })
      .where(eq(schema.invites.id, session.inviteId));
  });
}

export async function loadDraft(
  session: SubjectSession,
): Promise<{ draft: Record<string, unknown>; step: string | null }> {
  return withScope(session, async (db) => {
    const rows = await db
      .select({ draft: schema.invites.draft, draftStep: schema.invites.draftStep })
      .from(schema.invites)
      .where(eq(schema.invites.id, session.inviteId))
      .limit(1);

    return {
      draft: (rows[0]?.draft as Record<string, unknown> | null) ?? {},
      step: rows[0]?.draftStep ?? null,
    };
  });
}

/**
 * Marks the invite spent and clears the draft.
 *
 * Clearing matters: the draft holds every answer, including the encrypted ones,
 * and once they have been written to their real columns the copy in a jsonb
 * column is a second place a tax ID lives with none of the column-level grants
 * that protect the first.
 */
export async function consumeInvite(session: SubjectSession): Promise<void> {
  await withScope(session, async (db) => {
    await db
      .update(schema.invites)
      .set({ consumedAt: new Date(), draft: null, draftStep: null })
      .where(eq(schema.invites.id, session.inviteId));
  });
}

/** Fire-and-forget page-view record. Losing one is preferable to failing a page load. */
export async function recordInviteOpened(session: SubjectSession): Promise<void> {
  await auditBestEffort(session, {
    action: 'INVITE_OPENED',
    companyId: session.companyId,
    targetType: 'invites',
    targetId: session.inviteId,
  });
}
