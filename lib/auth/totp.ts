/**
 * TOTP, RFC 6238 over HOTP, RFC 4226. Mandatory for every firm role (spec
 * section 3) and re-entered on every reveal (section 7.6).
 *
 * Implemented directly on node:crypto. The algorithm is an HMAC, a truncation,
 * and a modulo; a dependency here would add a supply-chain surface to a
 * function that is thirty lines long and has not changed since 2011.
 *
 * SHA-1 is not a mistake. RFC 6238 specifies HMAC-SHA1 and every authenticator
 * app implements it; SHA-256 variants exist but enrollment silently fails on
 * several popular apps. HMAC-SHA1 is unaffected by the SHA-1 collision results,
 * which concern collision resistance rather than the PRF property HMAC relies
 * on.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How many steps either side of "now" are accepted. One step means a code
 * remains usable for up to 90 seconds in the worst case, which covers ordinary
 * clock drift on a phone and someone typing slowly. Two would be generous
 * enough to matter to an attacker reading a code over a shoulder.
 */
const WINDOW = 1;

// ---------------------------------------------------------------------------
// base32, RFC 4648 without padding — the encoding every authenticator expects
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

export function base32Decode(input: string): Buffer {
  // Tolerate the spacing and lowercase that people produce when typing a secret
  // in by hand, and the '=' padding some apps emit.
  const cleaned = input.toUpperCase().replace(/[\s=-]/g, '');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

export function counterForTime(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. It stays well inside the safe
  // integer range until the year 4-and-a-bit billion, so the high word is
  // written from a float divide rather than with BigInt.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(message).digest();

  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TotpVerification {
  valid: boolean;
  /**
   * The time step the code belonged to. Persist it: a code is valid once, and
   * refusing any counter at or below the last accepted one is what makes a code
   * observed over a shoulder — or captured by a phishing proxy seconds earlier
   * — useless.
   */
  counter?: number;
}

/**
 * `lastCounter` is the highest step already spent by this user. Pass it, and
 * store the returned counter on success. Omitting it turns a one-time code into
 * a 90-second reusable one.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastCounter: number | null | undefined,
  atMs: number = Date.now(),
): TotpVerification {
  const trimmed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(trimmed)) return { valid: false };

  const secret = base32Decode(secretBase32);
  const current = counterForTime(atMs);

  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const counter = current + offset;
    if (counter < 0) continue;
    if (lastCounter != null && counter <= lastCounter) continue;

    const expected = Buffer.from(hotp(secret, counter));
    const given = Buffer.from(trimmed);
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      return { valid: true, counter };
    }
  }

  return { valid: false };
}

/**
 * The `otpauth://` URI an authenticator app consumes, by QR or by paste.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter —
 * because different apps read different ones, and an entry labelled only with
 * an email address is unidentifiable in a list of fifteen.
 */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Groups of four, for a secret someone has to read off a screen and type. */
export function formatSecretForDisplay(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}
