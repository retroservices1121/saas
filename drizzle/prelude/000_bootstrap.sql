-- ---------------------------------------------------------------------------
-- 000_bootstrap
--
-- Runs before any table exists. Creates the `app` schema that holds the RLS
-- helper functions and the uuid v7 generator, so that generated DDL can
-- reference app.uuid_generate_v7() in its DEFAULT clauses.
-- ---------------------------------------------------------------------------

-- gen_random_bytes, used by the uuid v7 generator below.
create extension if not exists pgcrypto;

create schema if not exists app;

-- Migration bookkeeping. Lives in `app` rather than `public` so it is not
-- mistaken for application data.
create table if not exists app.schema_migrations (
  filename    text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- uuid v7
--
-- Postgres 16 has no native uuidv7() — that arrived in 18. This is the RFC 9562
-- layout: 48 bits of Unix epoch milliseconds, version nibble 7, then random.
-- Time-ordered primary keys keep index inserts append-mostly, which matters for
-- worker_records and audit_log, both of which are write-heavy and never updated.
-- ---------------------------------------------------------------------------
create or replace function app.uuid_generate_v7()
returns uuid
language plpgsql
volatile
parallel safe
as $$
declare
  unix_ts_ms bigint;
  uuid_bytes bytea;
begin
  unix_ts_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;

  -- 16 random bytes, then overwrite the first 6 with the timestamp.
  uuid_bytes := gen_random_bytes(16);
  uuid_bytes := set_byte(uuid_bytes, 0, ((unix_ts_ms >> 40) & 255)::int);
  uuid_bytes := set_byte(uuid_bytes, 1, ((unix_ts_ms >> 32) & 255)::int);
  uuid_bytes := set_byte(uuid_bytes, 2, ((unix_ts_ms >> 24) & 255)::int);
  uuid_bytes := set_byte(uuid_bytes, 3, ((unix_ts_ms >> 16) & 255)::int);
  uuid_bytes := set_byte(uuid_bytes, 4, ((unix_ts_ms >>  8) & 255)::int);
  uuid_bytes := set_byte(uuid_bytes, 5, ( unix_ts_ms        & 255)::int);

  -- version 7 in the high nibble of byte 6
  uuid_bytes := set_byte(uuid_bytes, 6, ((get_byte(uuid_bytes, 6) & 15) | 112));
  -- RFC 4122 variant in the top two bits of byte 8
  uuid_bytes := set_byte(uuid_bytes, 8, ((get_byte(uuid_bytes, 8) & 63) | 128));

  return encode(uuid_bytes, 'hex')::uuid;
end;
$$;
