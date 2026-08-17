-- ---------------------------------------------------------------------------
-- 906_platform
--
-- One number, for the platform admin's firm list.
--
-- The dashboard wants to show "this firm has eleven client companies", which is
-- genuinely useful to whoever operates the installation — a firm sitting at zero
-- a month after signup is a stalled onboarding, and that is a platform
-- question. But `app_platform` has no privilege on `companies` and should not
-- get one: spec section 2 gives that role firms, users and audit metadata, and
-- nothing else. A count written as a subquery over the table failed with
-- `permission denied for table companies`, which was the design working.
--
-- So: a security-definer function that returns an integer. Not a view, not a
-- column grant. It cannot be widened by its caller, it takes one firm id, and
-- an integer discloses no company's name, id, or existence individually.
-- ---------------------------------------------------------------------------

create or replace function app.firm_company_count(p_firm_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, app
as $$
  select count(*)::int from companies where firm_id = p_firm_id
$$;

revoke all on function app.firm_company_count(uuid) from public;
grant execute on function app.firm_company_count(uuid) to app_platform;
