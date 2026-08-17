/**
 * The export archive.
 *
 * These assertions are structural — they check the bytes are a well-formed
 * AE-2 ZIP and that the pieces are where the format says they should be. They
 * cannot prove 7-Zip will open it, and the thing that does prove that is
 * `scripts/verify-zip.py`, which reads the archive back with pyzipper, an
 * independent implementation. Run it after any change to lib/zip.ts:
 *
 *   pnpm zip:verify
 */
import { describe, expect, it } from 'vitest';
import { createEncryptedZip, generateArchivePassword, toCsv } from '../lib/zip';

const FIXED_DATE = new Date('2026-08-17T10:30:00Z');

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

describe('archive password', () => {
  it('omits characters that are indistinguishable in most fonts', () => {
    // The password is read off a screen and typed into an unzipper. 0/O and
    // 1/l/I are the difference between an archive that opens and one that is
    // simply lost.
    const password = generateArchivePassword(200);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it('is long enough to matter and grouped for reading aloud', () => {
    const password = generateArchivePassword(24);
    expect(password.replace(/-/g, '')).toHaveLength(24);
    expect(password).toContain('-');
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateArchivePassword()));
    expect(seen.size).toBe(50);
  });
});

describe('encrypted zip', () => {
  const entries = [
    { name: 'workers.csv', data: Buffer.from('name,tin\r\nAda,123456789\r\n') },
    // Over one AES block, which is what catches a big-endian counter.
    { name: 'documents/big.txt', data: Buffer.from('x'.repeat(5000)) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];

  it('produces a zip with the right signatures and entry count', () => {
    const zip = createEncryptedZip(entries, generateArchivePassword(), FIXED_DATE);

    expect(readUInt32(zip, 0)).toBe(0x04034b50); // first local file header

    const eocd = zip.length - 22;
    expect(readUInt32(zip, eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 8)).toBe(entries.length);
    expect(zip.readUInt16LE(eocd + 10)).toBe(entries.length);
  });

  it('marks every entry AES-encrypted with the AE-2 extra field', () => {
    const zip = createEncryptedZip(entries, generateArchivePassword(), FIXED_DATE);

    // Compression method 99 signals AES; the real method lives in the extra
    // field.
    expect(zip.readUInt16LE(8)).toBe(99);
    // Bit 0 encrypted, bit 11 UTF-8 names.
    expect(zip.readUInt16LE(6) & 0x0001).toBe(0x0001);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);

    const nameLength = zip.readUInt16LE(26);
    const extraOffset = 30 + nameLength;
    expect(zip.readUInt16LE(extraOffset)).toBe(0x9901); // AES extra field id
    expect(zip.readUInt16LE(extraOffset + 2)).toBe(7); // data size
    expect(zip.readUInt16LE(extraOffset + 4)).toBe(2); // AE-2
    expect(zip.subarray(extraOffset + 6, extraOffset + 8).toString('ascii')).toBe('AE');
    expect(zip.readUInt8(extraOffset + 8)).toBe(3); // AES-256
  });

  it('stores a CRC of zero, which is what AE-2 requires', () => {
    // AE-1 keeps the real CRC, and a CRC of a file whose contents an attacker
    // can guess is a free verification oracle. AE-2 exists because of that.
    const zip = createEncryptedZip(entries, generateArchivePassword(), FIXED_DATE);
    expect(readUInt32(zip, 14)).toBe(0);
  });

  it('never contains the plaintext', () => {
    const zip = createEncryptedZip(
      [{ name: 'workers.csv', data: Buffer.from('SSN 123456789 ACCOUNT 000123456789') }],
      generateArchivePassword(),
      FIXED_DATE,
    );
    const raw = zip.toString('latin1');
    expect(raw).not.toContain('123456789');
    expect(raw).not.toContain('ACCOUNT');
  });

  it('produces different bytes for the same input, because the salt is random', () => {
    const password = generateArchivePassword();
    const first = createEncryptedZip(entries, password, FIXED_DATE);
    const second = createEncryptedZip(entries, password, FIXED_DATE);
    expect(first.equals(second)).toBe(false);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes, and newlines', () => {
    const csv = toCsv([{ a: 'has, comma', b: 'has "quotes"', c: 'has\nnewline' }]);
    expect(csv).toContain('"has, comma"');
    expect(csv).toContain('"has ""quotes"""');
    expect(csv).toContain('"has\nnewline"');
  });

  it('neutralizes spreadsheet formula injection', () => {
    // A worker whose name field starts with `=` should not become a formula
    // when the firm opens the export in Excel.
    const csv = toCsv([
      { a: '=cmd|calc' },
      { a: '+1+1' },
      { a: '-1' },
      { a: '@SUM(A1)' },
    ]);
    for (const line of csv.trim().split('\r\n').slice(1)) {
      expect(line.startsWith("'")).toBe(true);
    }
  });

  it('uses CRLF, which is what RFC 4180 and Excel expect', () => {
    expect(toCsv([{ a: '1' }, { a: '2' }])).toBe('a\r\n1\r\n2\r\n');
  });

  it('returns an empty string rather than a bare header for no rows', () => {
    expect(toCsv([])).toBe('');
  });
});
