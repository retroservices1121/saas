/**
 * UUID v7, generated in the application rather than by the database default.
 *
 * The reason is Row Level Security, not preference. A firm session creating a
 * company holds no scope over it yet — scope comes from live grants resolved at
 * session start, and the grant is being written by the same transaction. So
 * `insert ... returning id` comes back empty: Postgres applies the SELECT policy
 * to a RETURNING clause, and the policy quite correctly says this session cannot
 * see that row.
 *
 * Knowing the id before the insert sidesteps that entirely, and it is needed
 * anyway — the company id, the grant row, the DEK's encryption context, and the
 * company admin's user row all have to agree, inside one transaction.
 *
 * v7 rather than v4 because the first 48 bits are a millisecond timestamp, so
 * ids sort by creation time. That keeps B-tree inserts at the right-hand edge of
 * the index instead of scattering them, which is the difference between an index
 * that stays compact and one that fragments.
 */
import { randomBytes } from 'node:crypto';

export function uuidv7(at: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit big-endian milliseconds since the Unix epoch.
  bytes[0] = (at / 2 ** 40) & 0xff;
  bytes[1] = (at / 2 ** 32) & 0xff;
  bytes[2] = (at / 2 ** 24) & 0xff;
  bytes[3] = (at / 2 ** 16) & 0xff;
  bytes[4] = (at / 2 ** 8) & 0xff;
  bytes[5] = at & 0xff;

  // Version 7 in the high nibble of byte 6, variant 10xx in byte 8. The
  // remaining 74 bits stay random.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
