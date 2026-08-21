-- ---------------------------------------------------------------------------
-- 907_policy_hardening
--
-- Two holes found by auditing layer 1 on its own, rather than through the data
-- access layer. Both were invisible to tests/isolation.test.ts because layer 2
-- happens to write the right WHERE clause every time — which is the inverse of
-- the design: the policy is supposed to be what holds when the query is wrong.
--
-- ===========================================================================
-- 1. A `FOR ALL` policy applies its USING clause to SELECT
-- ===========================================================================
--
-- `users_write` was written as `FOR ALL USING (actor_role in (PLATFORM_ADMIN,
-- FIRM_ADMIN, ANONYMOUS) or id = actor_user_id())` — intended as the rule for
-- writes. But FOR ALL covers SELECT, and permissive policies are OR-ed per
-- command, so the effective read rule on `users` became
--
--     users_select.USING  OR  users_write.USING
--
-- and the second half has no firm predicate. A FIRM_ADMIN could read every user
-- row in the database. Measured on a seeded instance: 11 of 11 users visible to
-- a firm holding 3 of them, including 1 password hash belonging to another
-- firm. `app_firm` holds table-wide SELECT, so nothing else stopped it.
--
-- Fixed three ways, because any one of them alone would have prevented this and
-- all three are cheap:
--   * per-command policies, so a USING clause cannot leak across commands;
--   * a firm predicate on the FIRM_ADMIN branch;
--   * column-level SELECT and UPDATE grants that make the credential columns
--     unnameable by any role except app_auth.
--
-- ===========================================================================
-- 2. `can_read_company()` is true for a subject's own company
-- ===========================================================================
--
-- `invites_select` read `ANONYMOUS OR can_read_company(company_id) OR
-- (is_subject() AND subject_id = app.subject_id())`. For a subject session
-- `app.actor_scope` is its own company and `is_firm()` is false, so the middle
-- clause is unconditionally true and the third is dead code.
--
-- One worker could therefore read every invite in their company, including the
-- `draft` column — which holds another worker's legal name, date of birth and
-- home address in plaintext while they are part-way through the form. The write
-- side was worse: setting another subject's `token_hash` and `verified_at`
-- would mint a session as them, past the date-of-birth gate.
--
-- The rule is now written per role rather than leaning on a helper whose
-- meaning changes with the caller.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- users
-- ===========================================================================

drop policy if exists users_select on users;
drop policy if exists users_write on users;
drop policy if exists users_insert on users;
drop policy if exists users_update on users;

-- A firm sees its own staff and its own companies' admins. Nothing else.
create policy users_select on users
  for select using (
    app.actor_role() = 'PLATFORM_ADMIN'
    -- The login path, which must find a user by address before it knows who is
    -- asking. Column grants below keep it to what a login needs.
    or app.actor_role() = 'ANONYMOUS'
    or (app.is_firm() and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid)
    or (app.is_company() and app.can_read_company(company_id))
    or id = app.actor_user_id()
  );

-- Creating a user: a firm may only create one inside its own firm, and the
-- platform admin only outside any company.
create policy users_insert on users
  for insert with check (
    app.actor_role() = 'PLATFORM_ADMIN'
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    )
  );

-- Updating a user. Both halves of the predicate carry the firm check, so a row
-- cannot be read out of one firm and written into another.
create policy users_update on users
  for update using (
    app.actor_role() = 'PLATFORM_ADMIN'
    or app.actor_role() = 'ANONYMOUS'
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    )
    or id = app.actor_user_id()
  )
  with check (
    app.actor_role() = 'PLATFORM_ADMIN'
    or app.actor_role() = 'ANONYMOUS'
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    )
    or id = app.actor_user_id()
  );


-- --- column grants ---------------------------------------------------------
-- Start from nothing, because 900_rls.sql grants `users` table-wide to app_firm
-- and this file has to narrow that.
revoke all on users from app_firm, app_company, app_platform;

-- Everything except the credentials. app_auth is the only role that has any
-- business naming a password hash or a TOTP secret, and it already holds them
-- from 901_auth.sql.
grant select (
  id, email, name, role, firm_id, company_id, status,
  last_login_at, failed_login_count, locked_until, totp_enabled_at,
  created_at, updated_at
) on users to app_firm, app_company, app_platform;

-- A firm admin suspends and reactivates staff. That is the whole of it: `role`,
-- `firm_id` and `company_id` are not writable, so a firm cannot promote its own
-- user to PLATFORM_ADMIN or move one between tenants.
grant update (status, updated_at) on users to app_firm, app_platform;

-- Drizzle names every column in an INSERT (see insertColumns in
-- lib/db/scoped.ts), so a column-limited INSERT would be unusable through the
-- ORM. The `users_insert` policy above carries the firm predicate instead.
grant insert on users to app_firm, app_platform;


-- ===========================================================================
-- invites
-- ===========================================================================

drop policy if exists invites_select on invites;
drop policy if exists invites_write on invites;
drop policy if exists invites_insert on invites;
drop policy if exists invites_update on invites;

-- Written per role. `can_read_company()` is deliberately not used for the
-- subject branch: it answers "is this company in your scope", and a subject's
-- own company always is — which is what made the old subject clause dead code.
create policy invites_select on invites
  for select using (
    -- The link-opening path, before any session exists. Bounded by having to
    -- name a row by the sha256 of a 32-byte token.
    app.actor_role() = 'ANONYMOUS'
    or (app.is_firm() and app.can_read_company(company_id))
    or (app.is_company() and app.can_read_company(company_id))
    or (app.is_subject() and subject_id = app.subject_id())
  );

create policy invites_insert on invites
  for insert with check (
    app.actor_role() = 'ANONYMOUS'
    or ((app.is_firm() or app.is_company()) and app.can_read_company(company_id))
  );

create policy invites_update on invites
  for update using (
    app.actor_role() = 'ANONYMOUS'
    or ((app.is_firm() or app.is_company()) and app.can_read_company(company_id))
    or (app.is_subject() and subject_id = app.subject_id())
  )
  with check (
    app.actor_role() = 'ANONYMOUS'
    or ((app.is_firm() or app.is_company()) and app.can_read_company(company_id))
    or (app.is_subject() and subject_id = app.subject_id())
  );


-- ===========================================================================
-- Insert policies that check the company but not the actor
--
-- `signatures_insert`, `documents_insert` and `notes_insert` asserted only
-- `can_read_company(company_id)`, so a subject session could insert a row
-- carrying a different subject's `subject_id`. Signature forgery is the one
-- that matters — the e-signature is the legal artifact, and a row claiming a
-- worker consented is exactly what it exists to prove.
--
-- Not reachable today: every call site takes `subject_id` from the session. The
-- select policies already pin it correctly; these bring the insert side into
-- line so the two halves say the same thing.
-- ===========================================================================

drop policy if exists signatures_insert on signatures;
create policy signatures_insert on signatures
  for insert with check (
    app.can_read_company(company_id)
    and (not app.is_subject() or subject_id = app.subject_id())
  );

drop policy if exists documents_insert on documents;
create policy documents_insert on documents
  for insert with check (
    app.can_read_company(company_id)
    and (not app.is_subject() or subject_id = app.subject_id())
  );

drop policy if exists notes_insert on notes;
create policy notes_insert on notes
  for insert with check (
    app.can_read_company(company_id)
    and (not app.is_subject() or subject_id = app.subject_id())
  );


-- ===========================================================================
-- workers
--
-- `workers_write` was `FOR ALL`, and its USING clause is a strict subset of
-- `workers_select`'s, so unlike `users_write` it widened nothing. It is split
-- anyway.
--
-- The reason is the invariant rather than this policy: "no FOR ALL on a table
-- whose SELECT is meant to be narrower" is a rule a test can check, and a rule
-- with one grandfathered exception is a rule nobody checks. Splitting it costs
-- four lines and keeps the check meaningful for whoever writes the next policy.
-- ===========================================================================

drop policy if exists workers_write on workers;

create policy workers_insert on workers
  for insert with check (
    app.can_read_company(company_id) and (app.is_firm() or app.is_company())
  );

create policy workers_update on workers
  for update using (
    app.can_read_company(company_id) and (app.is_firm() or app.is_company())
  )
  with check (
    app.can_read_company(company_id) and (app.is_firm() or app.is_company())
  );
