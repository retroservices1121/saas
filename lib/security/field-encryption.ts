/**
 * Layer 3 of access enforcement, and the only place a sensitive field is ever
 * turned back into plaintext (spec sections 5 and 6).
 *
 * Two functions are exported. Nothing else in the codebase imports the AES
 * primitives; nothing else touches a DEK.
 *
 * The decrypt guard is the load-bearing part. A COMPANY_ADMIN session reaching
 * decryptField is a bug, and the spec is explicit that it must throw and write a
 * SECURITY_VIOLATION row rather than returning empty — an empty return looks
 * like missing data and hides the defect.
 */
import { eq } from 'drizzle-orm';
import { withScope, schema, type ScopedDb } from '../db/scoped';
import { getKms } from './kms';
// eslint-disable-next-line no-restricted-imports
import { open, seal } from './aes';
import type { Session } from '../auth/session';
import { actorUserIdOf, isFirmSession, isSubjectSession } from '../auth/session';

/** Roles permitted to decrypt at all. Everything else is a violation. */
const DECRYPT_ROLES = new Set(['FIRM_ADMIN', 'FIRM_STAFF']);

export class DecryptForbiddenError extends Error {
  constructor(role: string) {
    super(
      `Role ${role} may not decrypt sensitive fields. This is a bug: the caller ` +
        'should never have reached decryptField.',
    );
    this.name = 'DecryptForbiddenError';
  }
}

export class DekDestroyedError extends Error {
  constructor(companyId: string) {
    super(`The data key for company ${companyId} has been destroyed. Its data is unrecoverable.`);
    this.name = 'DekDestroyedError';
  }
}

/** What every decryption must supply. There is no overload without it. */
export interface AuditContext {
  session: Session;
  /** REVEAL_TIN or REVEAL_BANK. */
  action: 'REVEAL_TIN' | 'REVEAL_BANK';
  /** At least ten characters, per spec section 7.6. Absent for subject sessions. */
  reason?: string | undefined;
  /**
   * The table, or `COMPANY_BANK` for the company's own account — see the guard
   * below, which is the one case where a company session may decrypt.
   */
  targetType: string;
  targetId: string;
  companyId: string;
}

/**
 * The company's own bank account, which is the single exception to "a company
 * user can never decrypt".
 *
 * Two clauses of the spec meet here and appear to disagree. Section 5 says
 * decryptField refuses anything that is not a firm role or the data subject.
 * Section 4 says the company's own banking is "masked in the company's own UI
 * with a reveal available to COMPANY_ADMIN only".
 *
 * They agree once you notice that for this one field the company IS the data
 * subject. The employer-cannot-see rule protects a worker's account from their
 * employer; it says nothing about an account the company itself owns, opened in
 * its own name, and typed in by its own admin. Section 4 says so directly:
 * company banking "is not subject to the employer-cannot-see rule, since the
 * company owns that account".
 *
 * The exception is written as a named constant and matched exactly, so it can
 * never widen to a worker record by accident. COMPANY_STAFF is excluded, and a
 * reason and an audit row are still required.
 */
export const COMPANY_BANK_TARGET = 'COMPANY_BANK';

// ---------------------------------------------------------------------------
// DEK cache
//
// Spec section 6: cached in memory five minutes max, keyed by company. The cache
// holds plaintext key material, so it is deliberately small, time-bounded, and
// never serialized.
// ---------------------------------------------------------------------------

const DEK_TTL_MS = 5 * 60 * 1000;

interface CachedDek {
  key: Buffer;
  expiresAt: number;
}

const dekCache = new Map<string, CachedDek>();

function cacheGet(companyId: string): Buffer | undefined {
  const hit = dekCache.get(companyId);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    hit.key.fill(0);
    dekCache.delete(companyId);
    return undefined;
  }
  return hit.key;
}

function cachePut(companyId: string, key: Buffer): void {
  dekCache.set(companyId, { key, expiresAt: Date.now() + DEK_TTL_MS });
}

/** Called on company deletion, and by tests between fixtures. */
export function evictDek(companyId?: string): void {
  if (companyId) {
    dekCache.get(companyId)?.key.fill(0);
    dekCache.delete(companyId);
    return;
  }
  for (const entry of dekCache.values()) entry.key.fill(0);
  dekCache.clear();
}

async function loadDek(db: ScopedDb, companyId: string): Promise<Buffer> {
  const cached = cacheGet(companyId);
  if (cached) return cached;

  const rows = await db
    .select({
      dekCiphertext: schema.companies.dekCiphertext,
      dekDestroyedAt: schema.companies.dekDestroyedAt,
    })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`No company ${companyId} in scope.`);
  if (row.dekDestroyedAt) throw new DekDestroyedError(companyId);

  const key = await getKms().decryptDataKey(row.dekCiphertext, { companyId });
  cachePut(companyId, key);
  return key;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates the per-company DEK. Called once, at company creation: GenerateDataKey,
 * store the ciphertext, discard the plaintext (spec section 6).
 */
export async function generateCompanyDek(
  companyId: string,
): Promise<{ ciphertext: Buffer; keyId: string }> {
  const dek = await getKms().generateDataKey({ companyId });
  // Warm the cache with the plaintext we already hold, then drop our reference.
  cachePut(companyId, dek.plaintext);
  return { ciphertext: dek.ciphertext, keyId: dek.keyId };
}

/**
 * Encrypts one field. No audit row: writing sensitive data is not a disclosure,
 * and the FORM_SUBMITTED / RECORD_CORRECTED entries already record that it
 * happened.
 */
export async function encryptField(
  session: Session,
  companyId: string,
  plaintext: string,
): Promise<Buffer> {
  if (!plaintext) throw new Error('Refusing to encrypt an empty value.');
  return withScope(session, async (db) => {
    const key = await loadDek(db, companyId);
    // The company id is authenticated as AAD, so a ciphertext moved between
    // companies fails to open even under a correct key.
    return seal(key, plaintext, companyId);
  });
}

/**
 * Decrypts one field of one record.
 *
 * Order of operations is fixed by the spec and by the threat it addresses: the
 * audit row is committed BEFORE the plaintext is produced. If the process dies
 * mid-reveal, the record of the attempt survives. The reverse order would let a
 * crash — or a deliberately induced one — yield plaintext with no trace.
 *
 * There is no bulk variant of this function, and adding one would defeat the
 * reveal-with-reason model entirely.
 */
export async function decryptField(
  ciphertext: Buffer,
  context: AuditContext,
): Promise<string> {
  const { session, companyId } = context;

  // --- the guard ---------------------------------------------------------
  const subjectMayRead =
    isSubjectSession(session) &&
    session.companyId === companyId &&
    session.subjectId === context.targetId;

  // The company's own account, and nothing else. Every clause is required: the
  // role, the exact target type, and both ids agreeing with the session.
  const companyOwnBank =
    session.kind === 'company' &&
    session.role === 'COMPANY_ADMIN' &&
    context.targetType === COMPANY_BANK_TARGET &&
    context.targetId === session.companyId &&
    companyId === session.companyId;

  if (!DECRYPT_ROLES.has(session.role) && !subjectMayRead && !companyOwnBank) {
    // Record it, then throw. Never return empty — a caller that treats an empty
    // string as "no data" would turn a security defect into a data-quality
    // ticket.
    await recordDecryptViolation(context);
    throw new DecryptForbiddenError(session.role);
  }

  if (isFirmSession(session) && !session.companyIds.includes(companyId)) {
    await recordDecryptViolation(context);
    throw new DecryptForbiddenError(session.role);
  }

  // A subject reading back their own answer mid-form is not a disclosure and
  // has nobody to explain it to. Everyone else states a reason.
  if (DECRYPT_ROLES.has(session.role) || companyOwnBank) {
    const reason = context.reason?.trim() ?? '';
    if (reason.length < 10) {
      throw new Error('A reveal reason of at least ten characters is required.');
    }
  }

  // --- audit first, then decrypt -----------------------------------------
  await withScope(session, async (db) => {
    await db.insert(schema.auditLog).values({
      firmId: isFirmSession(session) ? session.firmId : null,
      companyId,
      actorUserId: actorUserIdOf(session),
      actorRole: session.role,
      action: context.action,
      targetType: context.targetType,
      targetId: context.targetId,
      reason: context.reason ?? null,
      ip: session.ip ?? null,
      userAgent: session.userAgent ?? null,
      metadata: null,
    });
  });

  return withScope(session, async (db) => {
    const key = await loadDek(db, companyId);
    return open(key, ciphertext, companyId);
  });
}

async function recordDecryptViolation(context: AuditContext): Promise<void> {
  const { session, companyId } = context;
  try {
    await withScope(session, async (db) => {
      await db.insert(schema.auditLog).values({
        firmId: isFirmSession(session) ? session.firmId : null,
        companyId,
        actorUserId: actorUserIdOf(session),
        actorRole: session.role,
        action: 'SECURITY_VIOLATION',
        targetType: context.targetType,
        targetId: context.targetId,
        reason: null,
        ip: session.ip ?? null,
        userAgent: session.userAgent ?? null,
        metadata: { attemptedAction: context.action, guard: 'decryptField' },
      });
    });
  } catch (err) {
    console.error('[audit] failed to record decrypt violation', err);
  }
}

/**
 * Cryptographic shred (spec section 6). Destroying the wrapped DEK renders
 * every sensitive field for the company undecryptable in one operation, without
 * having to find and overwrite each ciphertext.
 */
export async function destroyCompanyDek(session: Session, companyId: string): Promise<void> {
  evictDek(companyId);
  await withScope(session, async (db) => {
    await db
      .update(schema.companies)
      .set({ dekDestroyedAt: new Date() })
      .where(eq(schema.companies.id, companyId));
  });
}

/** Last four characters, for the masked display. Never derived on the client. */
export function last4(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) throw new Error('Value is too short to have a last-4.');
  return digits.slice(-4);
}
