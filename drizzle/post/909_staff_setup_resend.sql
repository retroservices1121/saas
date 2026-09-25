-- ===========================================================================
-- Re-issuing a firm staff setup link
--
-- A setup link lasts 24 hours and sometimes never arrives at all, so a firm
-- admin can send a fresh one. Issuing it is an INSERT app_firm already had.
-- Retiring the previous one is an UPDATE it did not.
--
-- Retiring it is the point. Without that, a resend leaves every earlier link
-- live until its own expiry, and a setup link is a bearer credential that sets
-- a password and enrolls an authenticator — the same reasoning that makes
-- `issueInvite` consume a subject's outstanding invites before issuing
-- another. Only `consumed_at` is writable, so a firm cannot extend a link's
-- life or swap the hash under it, and DELETE is granted to nobody: a
-- superseded token stays as evidence that it was issued.
--
-- The existing policy was `FOR ALL USING (actor_role in (ANONYMOUS,
-- PLATFORM_ADMIN, FIRM_ADMIN))`, with no firm predicate — harmless while
-- app_firm held only SELECT and INSERT on a table of hashes, and not harmless
-- at all once it holds UPDATE: any firm admin could retire any other firm's
-- outstanding setup links. So the policy is split per command and given the
-- firm predicate first, for the same three reasons as `users_write` in
-- 907_policy_hardening.sql.
-- ===========================================================================

-- SECURITY DEFINER because `users` carries its own RLS, and a policy that
-- queried it as the caller would be reasoning about one policy through
-- another. Reads nothing but the one row it is asked about.
create or replace function app.setup_token_user_in_actor_firm(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1
      from users u
     where u.id = target
       and u.firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  )
$$;

-- 900_rls.sql and 901_auth.sql grant execute on every function in the schema,
-- but they run before this file — including on a re-apply — so this one needs
-- its own grant. A policy the caller cannot execute is a policy that fails
-- closed with a permission error rather than a denial.
grant execute on function app.setup_token_user_in_actor_firm(uuid)
  to app_platform, app_firm, app_company, app_subject, app_auth;

-- The firm admin who invited them, the platform admin who created the firm,
-- and the anonymous setup page that spends the token.
drop policy if exists user_setup_tokens_rw     on user_setup_tokens;
drop policy if exists user_setup_tokens_select on user_setup_tokens;
drop policy if exists user_setup_tokens_insert on user_setup_tokens;
drop policy if exists user_setup_tokens_update on user_setup_tokens;

create policy user_setup_tokens_select on user_setup_tokens
  for select using (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN')
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and app.setup_token_user_in_actor_firm(user_id)
    )
  );

create policy user_setup_tokens_insert on user_setup_tokens
  for insert with check (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN')
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and app.setup_token_user_in_actor_firm(user_id)
    )
  );

-- Both halves carry the predicate, so a row cannot be read under one firm and
-- written under another.
create policy user_setup_tokens_update on user_setup_tokens
  for update using (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN')
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and app.setup_token_user_in_actor_firm(user_id)
    )
  )
  with check (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN')
    or (
      app.actor_role() = 'FIRM_ADMIN'
      and app.setup_token_user_in_actor_firm(user_id)
    )
  );

revoke all on user_setup_tokens from app_firm, app_platform;
grant select, insert on user_setup_tokens to app_firm, app_platform;
-- Retiring a link, and nothing else about it.
grant update (consumed_at) on user_setup_tokens to app_firm, app_platform;
