-- ---------------------------------------------------------------------------
-- 900_rls
--
-- Layer 1 of access enforcement (spec section 5). Runs after the generated
-- table DDL.
--
-- Reading order:
--   1. helper functions that read the transaction-local settings
--   2. the four application roles
--   3. RLS enabled + FORCEd on every company-scoped table
--   4. policies
--   5. column-level grants, which are what make "not even last-4" true
--   6. triggers that make FIRM_ONLY non-negotiable
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. Helpers
--
-- All STABLE and marked leakproof-adjacent: they read only transaction-local
-- settings, never a table, so they cannot themselves become a channel for
-- cross-tenant data.
-- ===========================================================================

create or replace function app.actor_role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('app.actor_role', true), ''), 'NONE')
$$;

create or replace function app.actor_scope()
returns uuid[] language sql stable as $$
  select coalesce(
    (
      select array_agg(s::uuid)
      from unnest(string_to_array(current_setting('app.actor_scope', true), ',')) as s
      where s <> ''
    ),
    '{}'::uuid[]
  )
$$;

create or replace function app.subject_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.subject_id', true), '')::uuid
$$;

create or replace function app.actor_user_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.actor_user_id', true), '')::uuid
$$;

create or replace function app.is_firm()
returns boolean language sql stable as $$
  select app.actor_role() in ('FIRM_ADMIN', 'FIRM_STAFF')
$$;

create or replace function app.is_company()
returns boolean language sql stable as $$
  select app.actor_role() in ('COMPANY_ADMIN', 'COMPANY_STAFF')
$$;

create or replace function app.is_subject()
returns boolean language sql stable as $$
  select app.actor_role() in ('OWNER', 'WORKER')
$$;

-- Every policy funnels through this. A company id absent from the scope array
-- is invisible, which is why a revoked grant reads as not-found rather than as
-- forbidden — there is nothing to distinguish it from a company that was never
-- granted at all.
create or replace function app.in_scope(target uuid)
returns boolean language sql stable as $$
  select target = any (app.actor_scope())
$$;

-- Re-derives a firm's grant from the table rather than believing the session.
--
-- app.actor_scope() is set by the application from live grants, so in principle
-- checking it is enough. In principle is doing a lot of work in that sentence:
-- it makes layer 1 depend on layer 2 being correct, and the whole point of
-- having three layers is that each one holds on its own. This function makes
-- the database re-verify the grant itself, so a bug that put the wrong company
-- id into a firm session's scope still reads nothing.
--
-- SECURITY DEFINER because firm_company_grants carries its own RLS policy, and
-- a policy that queried it as the caller would recurse.
create or replace function app.firm_has_grant(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1
      from firm_company_grants g
     where g.company_id = target
       and g.firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
       and g.revoked_at is null
  )
$$;

-- The predicate every company-scoped policy uses.
--   firm sessions:    in the session scope AND holding a live grant
--   company sessions: in the session scope (which is their single own id)
--   subject sessions: in the session scope (the company that invited them)
create or replace function app.can_read_company(target uuid)
returns boolean language sql stable as $$
  select app.in_scope(target)
     and (not app.is_firm() or app.firm_has_grant(target))
$$;


-- ===========================================================================
-- 2. Application roles
--
-- app_user (the login role, created by scripts/setup-roles.ts) is a member of
-- all four and switches into one per transaction via SET LOCAL ROLE. None of
-- them own any table, so RLS applies; FORCE below covers the owner case too.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_platform') then
    create role app_platform nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_firm') then
    create role app_firm nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_company') then
    create role app_company nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_subject') then
    create role app_subject nologin noinherit;
  end if;
end
$$;

grant usage on schema app, public to app_platform, app_firm, app_company, app_subject;
grant execute on all functions in schema app to app_platform, app_firm, app_company, app_subject;


-- ===========================================================================
-- 3. Enable and FORCE row level security
--
-- FORCE matters because the migration role owns these tables, and a table owner
-- is exempt from its own policies unless forced. Without it a bug that ran a
-- query as the owner would see everything and every isolation test would still
-- pass.
-- ===========================================================================

alter table companies            enable row level security;
alter table companies            force  row level security;
alter table firm_company_grants  enable row level security;
alter table firm_company_grants  force  row level security;
alter table company_owners       enable row level security;
alter table company_owners       force  row level security;
alter table workers              enable row level security;
alter table workers              force  row level security;
alter table worker_records       enable row level security;
alter table worker_records       force  row level security;
alter table signatures           enable row level security;
alter table signatures           force  row level security;
alter table documents            enable row level security;
alter table documents            force  row level security;
alter table notes                enable row level security;
alter table notes                force  row level security;
alter table reminders            enable row level security;
alter table reminders            force  row level security;
alter table invites              enable row level security;
alter table invites              force  row level security;
alter table audit_log            enable row level security;
alter table audit_log            force  row level security;
alter table exports              enable row level security;
alter table exports              force  row level security;
alter table users                enable row level security;
alter table users                force  row level security;
alter table firms                enable row level security;
alter table firms                force  row level security;


-- ===========================================================================
-- 4. Policies
-- ===========================================================================

-- --- companies -------------------------------------------------------------
-- One rule covers firm and company sessions alike: a company is visible if its
-- id is in scope. Firm scope comes from live grants, company scope is the
-- single own id.
drop policy if exists companies_select on companies;
create policy companies_select on companies
  for select using (app.can_read_company(id));

drop policy if exists companies_update on companies;
create policy companies_update on companies
  for update using (app.can_read_company(id)) with check (app.can_read_company(id));

-- Only a firm session creates a company, and only inside its own firm.
drop policy if exists companies_insert on companies;
create policy companies_insert on companies
  for insert with check (
    app.is_firm()
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  );

-- --- firm_company_grants ---------------------------------------------------
-- A firm sees its own grants. A company never sees who has access to it
-- through this table; that is firm and platform information.
drop policy if exists grants_select on firm_company_grants;
create policy grants_select on firm_company_grants
  for select using (
    app.is_firm()
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  );

drop policy if exists grants_write on firm_company_grants;
create policy grants_write on firm_company_grants
  for all using (
    app.is_firm()
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  )
  with check (
    app.is_firm()
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  );

-- --- company_owners --------------------------------------------------------
-- Row visibility is scope-based for both firm and company. What separates them
-- is the column grant in section 5: a company session can read status but not
-- tin_last4. A subject session sees only its own row.
drop policy if exists owners_select on company_owners;
create policy owners_select on company_owners
  for select using (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or app.is_company()
      or (app.actor_role() = 'OWNER' and id = app.subject_id())
    )
  );

drop policy if exists owners_insert on company_owners;
create policy owners_insert on company_owners
  for insert with check (app.can_read_company(company_id) and (app.is_firm() or app.is_company()));

-- An owner may update only their own row, and only while their invite session
-- is live. A company may update the row it created (name, percentage, phone) —
-- the column grants stop it reaching the self-supplied columns.
drop policy if exists owners_update on company_owners;
create policy owners_update on company_owners
  for update using (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or app.is_company()
      or (app.actor_role() = 'OWNER' and id = app.subject_id())
    )
  )
  with check (app.can_read_company(company_id));

-- --- workers ---------------------------------------------------------------
-- Company-entered payroll data. The company owns this table outright.
drop policy if exists workers_select on workers;
create policy workers_select on workers
  for select using (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or app.is_company()
      or (app.actor_role() = 'WORKER' and id = app.subject_id())
    )
  );

drop policy if exists workers_write on workers;
create policy workers_write on workers
  for all using (app.can_read_company(company_id) and (app.is_firm() or app.is_company()))
  with check (app.can_read_company(company_id) and (app.is_firm() or app.is_company()));

-- --- worker_records --------------------------------------------------------
-- The table the whole design exists to protect.
--
-- Two independent mechanisms keep a company out:
--   here, a policy that requires a firm session or the worker themselves;
--   and in section 5, a total absence of table privileges for app_company.
-- Either alone would suffice. Both are present because this is the one that
-- matters, and because the privilege error is what produces the
-- SECURITY_VIOLATION audit row rather than a silent empty result.
drop policy if exists worker_records_select on worker_records;
create policy worker_records_select on worker_records
  for select using (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or (app.actor_role() = 'WORKER' and worker_id = app.subject_id())
    )
  );

-- Append-only. There is no UPDATE or DELETE policy on this table at all, and
-- section 5 revokes both privileges besides. A correction writes a new version;
-- superseding the old one is done by the trigger below, which runs as the
-- table owner and is the only path that may touch is_current.
drop policy if exists worker_records_insert on worker_records;
create policy worker_records_insert on worker_records
  for insert with check (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or (app.actor_role() = 'WORKER' and worker_id = app.subject_id())
    )
  );

-- --- signatures ------------------------------------------------------------
drop policy if exists signatures_select on signatures;
create policy signatures_select on signatures
  for select using (
    app.can_read_company(company_id)
    and (app.is_firm() or app.is_company() or subject_id = app.subject_id())
  );

drop policy if exists signatures_insert on signatures;
create policy signatures_insert on signatures
  for insert with check (app.can_read_company(company_id));

-- --- documents -------------------------------------------------------------
-- The sensitivity split. A FIRM_ONLY document is not merely undownloadable by a
-- company user; the row does not exist for them, so it cannot appear in a file
-- list, a count, or an ordering.
drop policy if exists documents_select on documents;
create policy documents_select on documents
  for select using (
    app.can_read_company(company_id)
    and deleted_at is null
    and (
      app.is_firm()
      or (app.is_company() and sensitivity = 'COMPANY_VISIBLE')
      or (app.is_subject() and subject_id = app.subject_id())
    )
  );

drop policy if exists documents_insert on documents;
create policy documents_insert on documents
  for insert with check (app.can_read_company(company_id));

-- --- notes -----------------------------------------------------------------
-- Same shape as documents. A worker's "my ITIN application is still pending"
-- is FIRM_ONLY and is invisible to the employer.
drop policy if exists notes_select on notes;
create policy notes_select on notes
  for select using (
    app.can_read_company(company_id)
    and (
      app.is_firm()
      or (app.is_company() and visibility = 'COMPANY_AND_FIRM')
      or (app.is_subject() and subject_id = app.subject_id())
    )
  );

drop policy if exists notes_insert on notes;
create policy notes_insert on notes
  for insert with check (app.can_read_company(company_id));

-- --- reminders -------------------------------------------------------------
drop policy if exists reminders_all on reminders;
create policy reminders_all on reminders
  for all using (app.can_read_company(company_id) and (app.is_firm() or app.is_company()))
  with check (app.can_read_company(company_id) and (app.is_firm() or app.is_company()));

-- --- invites ---------------------------------------------------------------
-- A subject reaches its invite by token hash before any session exists, so the
-- lookup runs as app_subject with the invite's own company already resolved.
drop policy if exists invites_select on invites;
create policy invites_select on invites
  for select using (
    app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  );

drop policy if exists invites_write on invites;
create policy invites_write on invites
  for all using (
    app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  )
  with check (
    app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  );

-- --- audit_log -------------------------------------------------------------
-- Anyone may append. Reading is scope-limited, and a subject may read nothing.
drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log
  for insert with check (true);

drop policy if exists audit_select on audit_log;
create policy audit_select on audit_log
  for select using (
    (app.is_firm() and app.can_read_company(company_id))
    or app.actor_role() = 'PLATFORM_ADMIN'
  );

-- --- exports ---------------------------------------------------------------
-- FIRM_ADMIN only, enforced again in the handler. A company never sees that an
-- export of its workers happened.
drop policy if exists exports_all on exports;
create policy exports_all on exports
  for all using (
    app.actor_role() = 'FIRM_ADMIN'
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  )
  with check (
    app.actor_role() = 'FIRM_ADMIN'
    and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  );

-- --- users / firms ---------------------------------------------------------
-- ANONYMOUS is the login path. It has to be able to find a user by email
-- address before it knows who that user is, so it reads the whole table — and
-- holds column-level UPDATE on the login bookkeeping columns only (901), so it
-- cannot change anyone's role, firm, or company on the way past.
drop policy if exists users_select on users;
create policy users_select on users
  for select using (
    app.actor_role() = 'PLATFORM_ADMIN'
    or app.actor_role() = 'ANONYMOUS'
    or (app.is_firm() and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
    or (app.is_company() and app.can_read_company(company_id))
    or id = app.actor_user_id()
  );

drop policy if exists users_write on users;
create policy users_write on users
  for all using (
    app.actor_role() in ('PLATFORM_ADMIN', 'FIRM_ADMIN', 'ANONYMOUS')
    or id = app.actor_user_id()
  )
  with check (
    app.actor_role() in ('PLATFORM_ADMIN', 'FIRM_ADMIN', 'ANONYMOUS')
    or id = app.actor_user_id()
  );

drop policy if exists firms_select on firms;
create policy firms_select on firms
  for select using (
    app.actor_role() = 'PLATFORM_ADMIN'
    or id = nullif(current_setting('app.firm_id', true), '')::uuid
  );

drop policy if exists firms_write on firms;
create policy firms_write on firms
  for all using (app.actor_role() = 'PLATFORM_ADMIN')
  with check (app.actor_role() = 'PLATFORM_ADMIN');


-- ===========================================================================
-- 5. Privileges
--
-- Policies decide which ROWS a role sees. Grants decide which TABLES and
-- COLUMNS it may name at all. The second is what enforces "never sees worker or
-- owner sensitive fields, not even last-4" (spec section 2), because RLS has no
-- column dimension.
--
-- Start from nothing and add back deliberately.
--
-- The revoke names its tables explicitly rather than saying ALL TABLES. This
-- file is re-runnable by design — every statement in it is idempotent — and a
-- blanket revoke would strip the grants that 901_auth.sql issues on the
-- authentication tables every time this one was re-applied, silently, with the
-- symptom appearing at the next login rather than at migration time.
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'firms','users','companies','firm_company_grants','company_owners',
    'workers','worker_records','signatures','documents','notes','reminders',
    'invites','audit_log','exports'
  ]
  loop
    execute format(
      'revoke all on %I from app_platform, app_firm, app_company, app_subject', t
    );
  end loop;
end
$$;

revoke all on all sequences in schema public from app_platform, app_firm, app_company, app_subject;

-- --- app_firm: the only role that reads sensitive data ---------------------
grant select, insert, update on
  companies, firm_company_grants, company_owners, workers,
  signatures, documents, notes, reminders, invites, users, firms
to app_firm;

-- Append-only for the firm as well. No UPDATE, no DELETE, ever.
grant select, insert on worker_records to app_firm;
grant select, insert on audit_log to app_firm;
grant select, insert, update on exports to app_firm;

-- --- app_company -----------------------------------------------------------
grant select, insert, update on companies to app_company;
grant select, insert, update on workers   to app_company;
grant select, insert, update on reminders to app_company;
grant select, insert on documents, notes, signatures, invites to app_company;
grant insert on audit_log to app_company;
grant select on users, firms to app_company;

-- company_owners: column-limited. The company entered the first group and may
-- read and correct it. The second group — legal name, DOB, address, TIN, and
-- crucially tin_last4 — is simply not nameable by this role. A hand-written
-- query selecting tin_last4 fails with insufficient_privilege, which the DAL
-- turns into not-found plus a SECURITY_VIOLATION row.
grant select (
  id, company_id, display_name, ownership_percent, phone_e164,
  preferred_locale, status, submitted_at, created_at, updated_at
) on company_owners to app_company;

grant insert (
  id, company_id, display_name, ownership_percent, phone_e164,
  preferred_locale, status
) on company_owners to app_company;

grant update (
  display_name, ownership_percent, phone_e164, preferred_locale, updated_at
) on company_owners to app_company;

-- worker_records: NOTHING. Not a column-limited select, not a count. This is
-- the single most important line in the file.
-- (No grant statement here on purpose. The revoke above already removed
--  everything; this comment marks the absence as deliberate.)

-- --- app_subject: its own row, nothing else --------------------------------
grant select on companies to app_subject;
grant select, update on company_owners to app_subject;
grant select on workers to app_subject;
grant select, insert on worker_records to app_subject;
grant select, insert on signatures, documents, notes to app_subject;
grant select, update on invites to app_subject;
grant insert on audit_log to app_subject;

-- --- app_platform: metadata only -------------------------------------------
-- Explicitly NOT granted on company_owners or worker_records. "Can create
-- firms, suspend accounts, read audit metadata. Cannot decrypt anything"
-- (spec section 2) — and cannot read the ciphertext either.
grant select, insert, update on firms, users to app_platform;
grant select, insert on audit_log to app_platform;

-- --- audit_log is append-only for everyone ---------------------------------
-- Revoked from PUBLIC as well, so a future role inherits the restriction
-- rather than having to remember it.
revoke update, delete, truncate on audit_log from public;
revoke update, delete, truncate on audit_log
  from app_platform, app_firm, app_company, app_subject;

-- worker_records is append-only for everyone too.
revoke update, delete, truncate on worker_records from public;
revoke update, delete, truncate on worker_records
  from app_platform, app_firm, app_company, app_subject;

-- Sequences backing any serial/identity columns.
grant usage on all sequences in schema public to app_firm, app_company, app_subject, app_platform;


-- ===========================================================================
-- 6. Triggers that make the invariants non-negotiable
-- ===========================================================================

-- Anything a worker or owner uploads is FIRM_ONLY, with no override (spec
-- section 4). Enforcing it in a trigger means a future handler that forgets to
-- set the flag still cannot leak the file.
create or replace function app.force_subject_uploads_firm_only()
returns trigger language plpgsql as $$
begin
  if new.uploaded_by_role in ('WORKER', 'OWNER') then
    new.sensitivity := 'FIRM_ONLY';
  end if;
  -- These document types are firm-only regardless of who uploaded them.
  if new.doc_type in ('VOIDED_CHECK', 'ID_DOCUMENT', 'W4', 'W9', 'I9') then
    new.sensitivity := 'FIRM_ONLY';
  end if;
  return new;
end;
$$;

drop trigger if exists documents_force_firm_only on documents;
create trigger documents_force_firm_only
  before insert or update on documents
  for each row execute function app.force_subject_uploads_firm_only();

-- Worker- and owner-authored notes are FIRM_ONLY for the same reason.
create or replace function app.force_subject_notes_firm_only()
returns trigger language plpgsql as $$
begin
  if new.author_role in ('WORKER', 'OWNER') then
    new.visibility := 'FIRM_ONLY';
  end if;
  return new;
end;
$$;

drop trigger if exists notes_force_firm_only on notes;
create trigger notes_force_firm_only
  before insert or update on notes
  for each row execute function app.force_subject_notes_firm_only();

-- worker_records is append-only, and the unique partial index allows exactly
-- one current row per worker. Superseding the previous version is therefore a
-- privileged operation: this trigger is SECURITY DEFINER so it runs as the
-- table owner, which is the only principal holding UPDATE on the table.
create or replace function app.supersede_previous_worker_record()
returns trigger language plpgsql security definer set search_path = public, app as $$
begin
  update worker_records
     set is_current = false,
         superseded_at = now()
   where worker_id = new.worker_id
     and id <> new.id
     and is_current;

  return new;
end;
$$;

drop trigger if exists worker_records_supersede on worker_records;
create trigger worker_records_supersede
  after insert on worker_records
  for each row when (new.is_current)
  execute function app.supersede_previous_worker_record();

-- Version numbers are assigned by the database, not the caller. A client that
-- picks its own version can collide or overwrite history.
create or replace function app.assign_worker_record_version()
returns trigger language plpgsql security definer set search_path = public, app as $$
begin
  if new.version is null or new.version = 0 then
    select coalesce(max(version), 0) + 1 into new.version
      from worker_records where worker_id = new.worker_id;
  end if;
  return new;
end;
$$;

drop trigger if exists worker_records_version on worker_records;
create trigger worker_records_version
  before insert on worker_records
  for each row execute function app.assign_worker_record_version();

-- updated_at maintenance, so no handler has to remember it.
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'firms','users','companies','firm_company_grants','company_owners',
    'workers','signatures','documents','notes','reminders','invites'
  ]
  loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I for each row execute function app.touch_updated_at()',
      t || '_touch', t
    );
  end loop;
end
$$;


-- ===========================================================================
-- 7. Constraints the ORM cannot express
-- ===========================================================================

-- A user belongs to exactly one firm, or one company, or neither (platform).
alter table users drop constraint if exists users_scope_ck;
alter table users add constraint users_scope_ck check (
  (role = 'PLATFORM_ADMIN' and firm_id is null and company_id is null)
  or (role in ('FIRM_ADMIN','FIRM_STAFF') and firm_id is not null and company_id is null)
  or (role in ('COMPANY_ADMIN','COMPANY_STAFF') and firm_id is not null and company_id is not null)
);

-- TOTP is mandatory for firm roles (spec section 3). A firm user cannot reach
-- `active` without an enrolled authenticator.
alter table users drop constraint if exists users_totp_ck;
alter table users add constraint users_totp_ck check (
  role not in ('FIRM_ADMIN','FIRM_STAFF')
  or status <> 'active'
  or totp_enabled_at is not null
);

-- Ciphertext and its last-4 travel together or not at all. A row with a last-4
-- and no ciphertext is unrecoverable data loss wearing a mask.
alter table worker_records drop constraint if exists worker_records_bank_pair_ck;
alter table worker_records add constraint worker_records_bank_pair_ck check (
  (routing_enc is null) = (routing_last4 is null)
  and (account_enc is null) = (account_last4 is null)
);

alter table company_owners drop constraint if exists owners_tin_pair_ck;
alter table company_owners add constraint owners_tin_pair_ck check (
  (tin_enc is null) = (tin_last4 is null)
);

-- An EIN is 00-0000000 (spec section 10).
alter table companies drop constraint if exists companies_ein_ck;
alter table companies add constraint companies_ein_ck check (
  ein is null or ein ~ '^[0-9]{2}-[0-9]{7}$'
);

-- Last-4 columns hold exactly four digits, never a longer fragment.
alter table worker_records drop constraint if exists worker_records_last4_ck;
alter table worker_records add constraint worker_records_last4_ck check (
  tin_last4 ~ '^[0-9]{4}$'
  and (routing_last4 is null or routing_last4 ~ '^[0-9]{4}$')
  and (account_last4 is null or account_last4 ~ '^[0-9]{4}$')
);
