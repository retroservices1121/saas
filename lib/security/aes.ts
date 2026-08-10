/**
 * AES-256-GCM primitives. Nothing outside lib/security/field-encryption.ts and
 * the KMS providers may import this file — the ESLint rule enforces it.
 *
 * Wire format is `nonce || ciphertext || tag`, which is what the spec's
 * `*_enc bytea` columns hold. The nonce is prepended rather than stored
 * separately so that a ciphertext is always self-contained: there is no way to
 * end up with a value whose nonce was lost in a migration.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12; // 96 bits, the GCM-recommended size
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function assertKey(key: Buffer, label = 'key'): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`${label} must be exactly ${KEY_BYTES} bytes, got ${key.length}.`);
  }
  return key;
}

/**
 * `aad` binds the ciphertext to a context — we pass the company id — so a
 * ciphertext lifted from one company's row cannot be decrypted under another
 * company's key even if that key were somehow obtained. It is authenticated,
 * not encrypted, and is not stored.
 */
export function seal(key: Buffer, plaintext: string, aad?: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, ciphertext, tag]);
}

export function open(key: Buffer, sealed: Buffer, aad?: string): string {
  assertKey(key);
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Ciphertext is too short to be well-formed.');
  }

  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);

  // A tag mismatch throws here. That is the desired behaviour: a tampered or
  // mis-keyed ciphertext must fail loudly, never return partial plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Constant-time compare, for token hashes and the like. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
