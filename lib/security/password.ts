/**
 * Password hashing, argon2id (spec section 3).
 *
 * @noble/hashes rather than the native `argon2` binding: this is audited pure
 * JavaScript with no build step, which matters because a native module that
 * fails to compile on a deploy target gets swapped for bcrypt by whoever is
 * on call that night.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's argon2id row —
 * m=19456 KiB, t=2, p=1. They are recorded inside every hash rather than read
 * from a constant at verification time, so raising them later does not
 * invalidate existing passwords: an old hash verifies under its own parameters
 * and is rewritten on the next successful login.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

interface Params {
  m: number;
  t: number;
  p: number;
}

const CURRENT: Params = { m: 19456, t: 2, p: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const VERSION = 19; // 0x13, the argon2 version these parameters describe

function derive(password: string, salt: Buffer, params: Params): Buffer {
  return Buffer.from(
    argon2id(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, {
      m: params.m,
      t: params.t,
      p: params.p,
      dkLen: HASH_BYTES,
      version: VERSION,
    }),
  );
}

/** Standard PHC string, so the stored value is portable to any argon2 library. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, CURRENT);
  return [
    '',
    'argon2id',
    `v=${VERSION}`,
    `m=${CURRENT.m},t=${CURRENT.t},p=${CURRENT.p}`,
    salt.toString('base64').replace(/=+$/, ''),
    hash.toString('base64').replace(/=+$/, ''),
  ].join('$');
}

interface ParsedHash {
  params: Params;
  salt: Buffer;
  hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', salt, hash]
  if (parts.length !== 6 || parts[1] !== 'argon2id') return null;

  const paramMatch = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[3] ?? '');
  if (!paramMatch) return null;

  try {
    return {
      params: {
        m: Number(paramMatch[1]),
        t: Number(paramMatch[2]),
        p: Number(paramMatch[3]),
      },
      salt: Buffer.from(parts[4]!, 'base64'),
      hash: Buffer.from(parts[5]!, 'base64'),
    };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  valid: boolean;
  /** True when the stored hash used weaker parameters than the current policy. */
  needsRehash: boolean;
}

export function verifyPassword(password: string, encoded: string | null): VerifyResult {
  if (!encoded) {
    // No password set — a user who has not completed setup. Burn the same time
    // as a real verification would, so the absence is not detectable by
    // measuring the response.
    derive(password, Buffer.alloc(SALT_BYTES), CURRENT);
    return { valid: false, needsRehash: false };
  }

  const parsed = parse(encoded);
  if (!parsed) return { valid: false, needsRehash: false };

  const candidate = derive(password, parsed.salt, parsed.params);
  const valid =
    candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);

  return {
    valid,
    needsRehash:
      valid &&
      (parsed.params.m < CURRENT.m ||
        parsed.params.t < CURRENT.t ||
        parsed.params.p !== CURRENT.p),
  };
}
