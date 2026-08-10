import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * `bytea` for ciphertext columns. Drizzle has no first-class bytea, and we do
 * not want one that silently coerces to a string — a ciphertext that round-trips
 * through a text encoding is a ciphertext that can be corrupted or logged.
 * Buffer in, Buffer out, nothing else.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    // postgres.js returns Uint8Array for bytea on some driver versions.
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new TypeError('bytea column did not decode to a binary value.');
  },
  toDriver(value: Buffer): Buffer {
    if (!Buffer.isBuffer(value)) throw new TypeError('bytea column requires a Buffer.');
    return value;
  },
});

/** Postgres 16 has no native uuidv7(); the function is installed by migration 0000. */
export const uuidV7Pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`app.uuid_generate_v7()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Every table in the spec carries id / created_at / updated_at. */
export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};
