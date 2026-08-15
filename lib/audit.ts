/**
 * The audit log (spec section 4, build order step 3).
 *
 * Two entry points, and choosing between them is a correctness decision rather
 * than a stylistic one:
 *
 *   `audit(db, ...)`  joins the caller's transaction. Use it whenever the event
 *                     and the change it describes must succeed or fail together
 *                     — a GRANT_CREATED row with no grant, or a grant with no
 *                     row, are both worse than neither.
 *
 *   `auditNow(...)`   opens its own transaction. Use it for events that are not
 *                     tied to a write at all: a login, an invite opened, a
 *                     failed verification.
 *
 * The table is append-only at the privilege level — UPDATE and DELETE are
 * revoked from every application role including app_user — so nothing written
 * here can be amended afterwards, by this code or by anything holding its
 * credentials.
 */
import { schema, withScope, type ScopedDb } from './db/scoped';
import { actorUserIdOf, firmIdOf, scopeOf, type ActorRole, type Session } from './auth/session';

/** The action vocabulary from spec section 4, plus SECURITY_VIOLATION. */
export type AuditAction = (typeof schema.auditAction.enumValues)[number];

export interface AuditEvent {
  action: AuditAction;
  /**
   * Defaults to the session's single company. Pass it explicitly for firm
   * sessions, which have many, and for platform events, which have none.
   */
  companyId?: string | null | undefined;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  /** Required on every reveal and every export. */
  reason?: string | null | undefined;
  /**
   * Never put a field value in here. The redaction filter scrubs known key
   * names on the way to the log, but this column is not a log line — it is
   * storage, and it is retained for the life of the record.
   */
  metadata?: Record<string, unknown> | null | undefined;
}

function rowFor(session: Session, event: AuditEvent) {
  const scope = scopeOf(session);
  return {
    firmId: firmIdOf(session),
    // A firm session touching one company must name it; falling back to the
    // first id in scope would misattribute the event to whichever company
    // happened to sort first.
    companyId: event.companyId ?? (scope.length === 1 ? scope[0]! : null),
    actorUserId: actorUserIdOf(session),
    actorRole: session.role as ActorRole,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    reason: event.reason ?? null,
    ip: session.ip ?? null,
    userAgent: session.userAgent ?? null,
    metadata: event.metadata ?? null,
  };
}

/** Append inside the caller's transaction. Failure rolls the caller back. */
export async function audit(db: ScopedDb, session: Session, event: AuditEvent): Promise<void> {
  await db.insert(schema.auditLog).values(rowFor(session, event));
}

/** Append in a transaction of its own. */
export async function auditNow(session: Session, event: AuditEvent): Promise<void> {
  await withScope(session, async (db) => audit(db, session, event));
}

/**
 * For paths where losing the event is preferable to failing the request — an
 * INVITE_OPENED on a page load, say. Everything else should use the throwing
 * variants: an audit trail with silent holes in it is not an audit trail.
 */
export async function auditBestEffort(session: Session, event: AuditEvent): Promise<void> {
  try {
    await auditNow(session, event);
  } catch (err) {
    console.error(`[audit] failed to record ${event.action}`, err);
  }
}
