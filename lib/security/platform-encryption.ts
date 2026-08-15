/**
 * Envelope encryption for data that has no company.
 *
 * A TOTP secret belongs to a user. Wrapping it with a company DEK would be
 * wrong twice over: a firm admin has no company, and destroying a company's DEK
 * on deletion — which is the whole point of the cryptographic-shred design —
 * would lock that company's own staff out of their authenticators.
 *
 * So there is a second envelope, rooted in the same KMS master key, keyed by
 * purpose rather than by tenant. Same algorithm, same provider, same rotation
 * story; the only difference is what the key is scoped to.
 *
 * This module is deliberately narrow. It is not a general-purpose crypto
 * helper, and there is no `decryptPlatformField(anything)` — the callers are
 * lib/auth/totp-store.ts and nothing else.
 */
import { eq } from 'drizzle-orm';
import { schema, withScope } from '../db/scoped';
import { anonymousSession } from '../auth/session';
import { getKms } from './kms';
// eslint-disable-next-line no-restricted-imports
import { open, seal } from './aes';

export type PlatformKeyPurpose = 'totp';

const DEK_TTL_MS = 5 * 60 * 1000;

interface CachedDek {
  key: Buffer;
  expiresAt: number;
}

const cache = new Map<PlatformKeyPurpose, CachedDek>();

export function evictPlatformDek(purpose?: PlatformKeyPurpose): void {
  if (purpose) {
    cache.get(purpose)?.key.fill(0);
    cache.delete(purpose);
    return;
  }
  for (const entry of cache.values()) entry.key.fill(0);
  cache.clear();
}

/**
 * Loads the wrapped DEK for `purpose`, creating it on first use.
 *
 * The insert is `on conflict do nothing` followed by a re-read rather than a
 * check-then-insert: two processes starting at once would otherwise each
 * generate a key, one would win, and every secret written under the loser would
 * be undecryptable. The row is the arbiter, not the timing.
 */
async function loadPlatformDek(purpose: PlatformKeyPurpose): Promise<Buffer> {
  const hit = cache.get(purpose);
  if (hit && Date.now() < hit.expiresAt) return hit.key;
  if (hit) {
    hit.key.fill(0);
    cache.delete(purpose);
  }

  const session = anonymousSession();
  const context = { purpose };

  const ciphertext = await withScope(session, async (db) => {
    const existing = await db
      .select({ dekCiphertext: schema.platformKeys.dekCiphertext })
      .from(schema.platformKeys)
      .where(eq(schema.platformKeys.purpose, purpose))
      .limit(1);

    if (existing[0]) return existing[0].dekCiphertext;

    const generated = await getKms().generateDataKey(context);
    await db
      .insert(schema.platformKeys)
      .values({
        purpose,
        dekCiphertext: generated.ciphertext,
        dekKeyId: generated.keyId,
      })
      .onConflictDoNothing();

    const settled = await db
      .select({ dekCiphertext: schema.platformKeys.dekCiphertext })
      .from(schema.platformKeys)
      .where(eq(schema.platformKeys.purpose, purpose))
      .limit(1);

    if (!settled[0]) throw new Error(`Could not establish the platform key for ${purpose}.`);
    return settled[0].dekCiphertext;
  });

  const key = await getKms().decryptDataKey(ciphertext, context);
  cache.set(purpose, { key, expiresAt: Date.now() + DEK_TTL_MS });
  return key;
}

export async function encryptPlatformField(
  purpose: PlatformKeyPurpose,
  plaintext: string,
): Promise<Buffer> {
  if (!plaintext) throw new Error('Refusing to encrypt an empty value.');
  const key = await loadPlatformDek(purpose);
  return seal(key, plaintext, purpose);
}

export async function decryptPlatformField(
  purpose: PlatformKeyPurpose,
  ciphertext: Buffer,
): Promise<string> {
  const key = await loadPlatformDek(purpose);
  return open(key, ciphertext, purpose);
}
