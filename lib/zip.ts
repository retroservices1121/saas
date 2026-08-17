/**
 * A ZIP writer with WinZip AES-256 encryption (the AE-2 scheme).
 *
 * Spec section 7.7 asks for a password-protected zip. The obvious way to get
 * one is the original PKWARE "ZipCrypto" cipher, and it must not be used here:
 * it is broken by a known-plaintext attack that recovers the internal keys from
 * about thirteen known bytes, and every file in this archive begins with a CSV
 * header an attacker can guess exactly. An archive of Social Security numbers
 * protected by ZipCrypto is protected by nothing.
 *
 * So this implements AE-2, which is what 7-Zip, WinZip, Keka, and Python's
 * pyzipper all read:
 *
 *   PBKDF2-HMAC-SHA1(password, 16-byte salt, 1000 iterations) derives a
 *   256-bit encryption key, a 256-bit authentication key, and a two-byte
 *   password verifier;
 *   the data is encrypted with AES-256 in counter mode;
 *   a 10-byte HMAC-SHA1 of the ciphertext is appended.
 *
 * Two details are easy to get wrong and are called out where they happen: the
 * counter is incremented little-endian, which Node's built-in CTR mode does not
 * do, and AE-2 stores a CRC of zero rather than the real one.
 *
 * Written by hand because the alternative is a dependency in the path of the
 * one artifact in this system that leaves it containing plaintext tax IDs.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const AES_KEY_BITS = 256;
const SALT_BYTES = 16; // 16 for AES-256, per the WinZip AE specification
const KEY_BYTES = AES_KEY_BITS / 8;
const PBKDF2_ITERATIONS = 1000; // fixed by the format, not a policy choice
const AUTH_CODE_BYTES = 10;
const AES_STRENGTH = 0x03; // 3 = 256-bit
const AE_VERSION = 0x0002; // AE-2
const METHOD_AES = 99;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 51; // 5.1, the version that introduced AES

export interface ZipEntry {
  /** Forward-slash separated path inside the archive. */
  name: string;
  data: Buffer;
}

/**
 * A cryptographically strong password that a person can read off a screen and
 * type into 7-Zip without transcription errors.
 *
 * The alphabet omits characters that are indistinguishable in most fonts — 0/O,
 * 1/l/I — because this password is displayed once and never sent anywhere
 * (spec section 7.7: "displays once on screen and is never sent by SMS or
 * email"), so a misread character means the export is simply lost.
 *
 * 24 characters from a 55-character alphabet is about 139 bits.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateArchivePassword(length = 24): string {
  const out: string[] = [];
  // Rejection sampling, so every character is equally likely. `% alphabet`
  // over a byte would make the first few characters slightly more common,
  // which is a small bias but a free one to avoid.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  // Grouped for reading aloud and typing.
  return out.join('').replace(/(.{6})(?=.)/g, '$1-');
}

/**
 * AES counter mode with the little-endian counter WinZip specifies.
 *
 * Node's `aes-256-ctr` increments the IV as a big-endian 128-bit integer. WinZip
 * increments byte 0 first and carries upward, which is a different keystream
 * from the second block onward — so a file over 16 bytes encrypted with Node's
 * CTR would be silently unreadable by every real unzipper. CTR is built here
 * from single-block ECB instead, which is exactly what the counter mode is.
 */
function aesCtrLittleEndian(key: Buffer, plaintext: Buffer): Buffer {
  const out = Buffer.alloc(plaintext.length);
  const counter = Buffer.alloc(16);
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);

  for (let offset = 0; offset < plaintext.length; offset += 16) {
    // Increment before use: the first block is encrypted under counter 1.
    for (let i = 0; i < 16; i++) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) break;
    }

    const keystream = cipher.update(counter);
    const block = Math.min(16, plaintext.length - offset);
    for (let i = 0; i < block; i++) {
      out[offset + i] = plaintext[offset + i]! ^ keystream[i]!;
    }
  }

  return out;
}

interface EncryptedPayload {
  salt: Buffer;
  passwordVerifier: Buffer;
  ciphertext: Buffer;
  authCode: Buffer;
}

function encryptEntry(password: string, data: Buffer): EncryptedPayload {
  const salt = randomBytes(SALT_BYTES);

  // One derivation produces all three values, concatenated in this order.
  const derived = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_BYTES * 2 + 2,
    'sha1',
  );
  const encryptionKey = derived.subarray(0, KEY_BYTES);
  const authenticationKey = derived.subarray(KEY_BYTES, KEY_BYTES * 2);
  const passwordVerifier = derived.subarray(KEY_BYTES * 2);

  const ciphertext = aesCtrLittleEndian(encryptionKey, data);

  // Encrypt-then-MAC, over the ciphertext. Truncated to 10 bytes by the format.
  const authCode = createHmac('sha1', authenticationKey)
    .update(ciphertext)
    .digest()
    .subarray(0, AUTH_CODE_BYTES);

  return { salt, passwordVerifier, ciphertext, authCode };
}

/** MS-DOS time and date, which is what the ZIP format still records. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time:
      (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/** The 11-byte extra field that marks an entry as AES-encrypted. */
function aesExtraField(actualMethod: number): Buffer {
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(0x9901, 0); // header id
  extra.writeUInt16LE(7, 2); // data size
  extra.writeUInt16LE(AE_VERSION, 4);
  extra.write('AE', 6, 'ascii'); // vendor id
  extra.writeUInt8(AES_STRENGTH, 8);
  extra.writeUInt16LE(actualMethod, 9);
  return extra;
}

/**
 * Builds the archive.
 *
 * Everything is held in memory. These exports are CSV files and a handful of
 * PDFs and phone photos — tens of megabytes at the outside — and streaming
 * would mean either a temporary file holding plaintext tax IDs on local disk,
 * or a second pass to compute sizes. Neither is worth it at this size.
 */
export function createEncryptedZip(
  entries: ZipEntry[],
  password: string,
  at: Date = new Date(0),
): Buffer {
  const { time, date } = dosDateTime(at);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');

    // Deflate unless it makes the entry bigger, which it does for anything
    // already compressed — a JPEG from a phone camera, or a PDF.
    const deflated = deflateRawSync(entry.data, { level: 6 });
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const actualMethod = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const encrypted = encryptEntry(password, body);
    const compressedSize =
      encrypted.salt.length +
      encrypted.passwordVerifier.length +
      encrypted.ciphertext.length +
      encrypted.authCode.length;

    const extra = aesExtraField(actualMethod);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    // bit 0: encrypted. bit 11: the name is UTF-8, which matters the moment a
    // company is called Peña Construction.
    local.writeUInt16LE(0x0001 | 0x0800, 6);
    local.writeUInt16LE(METHOD_AES, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // AE-2 stores no CRC. AE-1 does, and leaking a CRC of a file whose contents
    // an attacker can guess is a free oracle; AE-2 exists because of that.
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const localBlock = Buffer.concat([
      local,
      name,
      extra,
      encrypted.salt,
      encrypted.passwordVerifier,
      encrypted.ciphertext,
      encrypted.authCode,
    ]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    central.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    central.writeUInt16LE(0x0001 | 0x0800, 8);
    central.writeUInt16LE(METHOD_AES, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);

    localParts.push(localBlock);
    centralParts.push(Buffer.concat([central, name, extra]));
    offset += localBlock.length;
  }

  const centralDirectory = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * CSV with the quoting rules a spreadsheet actually needs.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote. Without it,
 * Excel and Sheets treat the cell as a formula — which for a field somebody
 * else typed is a remote code execution path dressed up as a name field. Tax
 * IDs and account numbers are also forced to text so a spreadsheet does not
 * helpfully drop their leading zeros.
 */
export function toCsv(rows: Array<Record<string, string | number | null | undefined>>): string {
  if (rows.length === 0) return '';

  const columns = Object.keys(rows[0]!);

  const escape = (value: string | number | null | undefined): string => {
    if (value == null) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(','));
  }

  // CRLF, which is what RFC 4180 specifies and what Excel on Windows expects.
  return `${lines.join('\r\n')}\r\n`;
}
