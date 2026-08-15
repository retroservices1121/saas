-- ---------------------------------------------------------------------------
-- 901_auth
--
-- The authentication tables and the fifth application role.
--
-- Everything in 900_rls.sql answers "what may this session read". This file
-- answers a question that comes before it: how does a request that has no
-- session yet read the one row it needs in order to have one?
--
-- The answer is app_auth — a role that can see users, sessions, setup tokens
-- and the platform key, and cannot name a company, a worker, an owner, a
-- document, or a note. It is the only role permitted to run before identity is
-- established, and lib/auth is the only code that enters it.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. The role
-- ===========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    create role app_auth nologin noinherit;
  end if;
end
$$;

grant usage on schema app, public to app_auth;
grant execute on all functions in schema app to app_auth;


-- ===========================================================================
-- 2. RLS on the new tables
-- ===========================================================================

alter table staff_sessions    enable row level security;
alter table staff_sessions    force  row level security;
alter table user_setup_tokens enable row level security;
alter table user_setup_tokens force  row level security;
alter table platform_keys     enable row level security;
alter table platform_keys     force  row level security;
alter table login_attempts    enable row level security;
alter table login_attempts    force  row level security;

-- Start from nothing on all four, for every role including the ones that never
-- touch them. `alter default privileges` in scripts/setup-roles.ts hands
-- app_firm select+insert on every table created after it ran, which is every
-- table in this migration — so these revokes are load-bearing, not decorative.
do $$
declare t text;
begin
  foreach t in array array[
    'staff_sessions','user_setup_tokens','platform_keys','login_attempts'
  ]
  loop
    execute format(
      'revoke all on %I from app_platform, app_firm, app_company, app_subject, app_auth', t
    );
  end loop;
end
$$;


-- --- staff_sessions --------------------------------------------------------
-- app_auth manages every session. A logged-in user may additionally see and
-- revoke their own — "sign out everywhere" needs no elevated path.
drop policy if exists staff_sessions_auth on staff_sessions;
create policy staff_sessions_auth on staff_sessions
  for all using (
    app.actor_role() = 'ANONYMOUS'
    or user_id = app.actor_user_id()
  )
  with check (
    app.actor_role() = 'ANONYMOUS'
    or user_id = app.actor_user_id()
  );

grant select, insert, update on staff_sessions to app_auth;
-- Sessions are revoked, never deleted, so a session that existed on the day of
-- an incident is still there to be found afterwards. The expiry sweep in
-- scripts/jobs deletes rows that are long past their absolute expiry, and it
-- runs as the owner.
grant select, update on staff_sessions to app_firm, app_company, app_platform;


-- --- user_setup_tokens -----------------------------------------------------
-- Created by whoever invited the staff member (a firm admin, or the platform
-- admin creating a firm), consumed by the anonymous setup page.
drop policy if exists user_setup_tokens_rw on user_setup_tokens;
create policy user_setup_tokens_rw on user_setup_tokens
  for all using (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN', 'FIRM_ADMIN')
  )
  with check (
    app.actor_role() in ('ANONYMOUS', 'PLATFORM_ADMIN', 'FIRM_ADMIN')
  );

grant select, update on user_setup_tokens to app_auth;
grant select, insert on user_setup_tokens to app_firm, app_platform;


-- --- platform_keys ---------------------------------------------------------
-- Wraps the key that encrypts TOTP secrets. Reachable by app_auth alone: a firm
-- session verifying a step-up code does so through lib/auth, which opens an
-- anonymous scope for exactly that read, so no application role ever needs to
-- name this table.
drop policy if exists platform_keys_auth on platform_keys;
create policy platform_keys_auth on platform_keys
  for all using (app.actor_role() = 'ANONYMOUS')
  with check (app.actor_role() = 'ANONYMOUS');

grant select, insert on platform_keys to app_auth;


-- --- login_attempts --------------------------------------------------------
-- Throttling state. Keyed on the address attempted, not on a user id, so that
-- failures against an address that does not exist are counted too — otherwise
-- the throttle is itself an oracle for which addresses are real.
drop policy if exists login_attempts_auth on login_attempts;
create policy login_attempts_auth on login_attempts
  for all using (app.actor_role() = 'ANONYMOUS')
  with check (app.actor_role() = 'ANONYMOUS');

grant select, insert, delete on login_attempts to app_auth;


-- ===========================================================================
-- 3. What app_auth may reach outside its own tables
-- ===========================================================================

grant select on users to app_auth;

-- Column-limited UPDATE. The login path sets password hashes, enrolls
-- authenticators, advances the TOTP replay counter, and records lockouts. It
-- has no business changing a role, a firm_id, or a company_id, and after this
-- grant it cannot: a statement naming one of those columns fails with
-- insufficient_privilege before any policy is consulted.
grant update (
  password_hash,
  totp_secret_enc,
  totp_enabled_at,
  totp_last_counter,
  status,
  last_login_at,
  failed_login_count,
  locked_until,
  updated_at
) on users to app_auth;

-- LOGIN_SUCCESS, LOGIN_FAILURE, and the lockout notice. Append only, like
-- everyone else.
grant insert on audit_log to app_auth;

grant usage on all sequences in schema public to app_auth;


-- ===========================================================================
-- 4. Constraints
-- ===========================================================================

-- A session cannot slide past its own ceiling.
alter table staff_sessions drop constraint if exists staff_sessions_expiry_ck;
alter table staff_sessions add constraint staff_sessions_expiry_ck check (
  expires_at <= absolute_expires_at
);

-- A user row that holds a TOTP secret has to say when it was enrolled, and one
-- that claims enrollment has to hold a secret. Either half alone is a user who
-- cannot log in, discovered at the worst possible moment.
alter table users drop constraint if exists users_totp_pair_ck;
alter table users add constraint users_totp_pair_ck check (
  (totp_secret_enc is null) = (totp_enabled_at is null)
);
