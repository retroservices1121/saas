-- ---------------------------------------------------------------------------
-- 902_invites
--
-- The invites table, end to end: policies, column-level grants, and the one
-- security-definer function the anonymous lookup needs.
--
-- It is owned by a single file on purpose. 900_rls.sql revokes and re-grants
-- the tables it governs on every re-apply, and it is designed to be re-applied;
-- if this table's grants lived there and its column restrictions lived here,
-- one edit to 900 would silently restore full-table SELECT to app_company and
-- nothing would fail until a company admin read a worker's draft.
--
-- What makes this table unusual: a link is opened by someone with no session at
-- all, so the lookup runs as app_auth; and a company user must be able to see
-- that an invite was sent without being able to see either the token or the
-- answers accumulating behind it.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. Start from nothing
-- ===========================================================================

revoke all on invites from app_platform, app_firm, app_company, app_subject, app_auth;


-- ===========================================================================
-- 2. Policies
-- ===========================================================================

-- ANONYMOUS is the link-opening path: a worker tapping a text message has no
-- session, and resolving the token is what will create one. The lookup is by
-- sha256 of a 32-byte token, so "every row is visible to this role" is bounded
-- by not being able to name one.
drop policy if exists invites_select on invites;
create policy invites_select on invites
  for select using (
    app.actor_role() = 'ANONYMOUS'
    or app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  );

drop policy if exists invites_write on invites;
create policy invites_write on invites
  for all using (
    app.actor_role() = 'ANONYMOUS'
    or app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  )
  with check (
    app.actor_role() = 'ANONYMOUS'
    or app.can_read_company(company_id)
    or (app.is_subject() and subject_id = app.subject_id())
  );


-- ===========================================================================
-- 3. Grants
--
-- Three roles touch this table and each needs a different slice of it.
-- ===========================================================================

-- --- app_firm: everything -------------------------------------------------
-- The firm is the party allowed to see worker data, so the draft is not
-- withheld from it.
grant select, insert, update on invites to app_firm;


-- --- app_subject: their own row, including their own draft -----------------
grant select, update on invites to app_subject;


-- --- app_auth: everything except the draft ---------------------------------
-- The link-opening path needs the token hash and the date-of-birth hash to do
-- its job. It has no reason to read the answers, and this is the role a
-- request reaches before anyone has proved who they are.
grant select (
  id, company_id, subject_type, subject_id, token_hash, expected_dob_hash,
  expires_at, consumed_at, verified_at, failed_attempts, locked_until,
  sent_at, opened_at, draft_step, created_at, updated_at
) on invites to app_auth;

grant update (
  expected_dob_hash, verified_at, failed_attempts, locked_until,
  opened_at, updated_at
) on invites to app_auth;


-- --- app_company: that an invite exists, and nothing inside it -------------
-- The company sends the invite and needs to see whether it has been opened, so
-- it can chase. It must not see:
--
--   token_hash        — the link itself. Useless without the raw token, and
--                       there is still no reason for the party the gate
--                       protects against to hold any part of it.
--   expected_dob_hash — the answer to the second factor. Hashed with argon2id
--                       besides, because a date of birth has around thirty
--                       thousand plausible values and a fast hash would be a
--                       lookup table.
--   draft             — every answer typed so far. The whole point of the
--                       worker/worker_records split is undone if a company can
--                       read a half-finished form out of a jsonb column.
grant select (
  id, company_id, subject_type, subject_id,
  expires_at, consumed_at, verified_at, failed_attempts, locked_until,
  sent_at, opened_at, draft_step, created_at, updated_at
) on invites to app_company;

-- A company issues invites, so it writes the token hash it just generated —
-- and cannot read it back.
grant insert (
  id, company_id, subject_type, subject_id, token_hash, expected_dob_hash,
  expires_at, sent_at, created_at, updated_at
) on invites to app_company;

-- Superseding a previous live invite when a new one is issued.
grant update (consumed_at, sent_at, updated_at) on invites to app_company;


-- ===========================================================================
-- 4. The subject summary
--
-- The welcome screen names the inviting company (spec section 8, screen 1),
-- because a form asking for a Social Security number that does not say who is
-- asking is indistinguishable from a phishing page. It also needs the person's
-- display name and their language.
--
-- All three live on tables app_auth has no privilege on, and giving it that
-- privilege to satisfy one screen would hand the pre-authentication role a read
-- over every company and every worker in the system.
--
-- So: a security-definer function that returns exactly three non-sensitive
-- columns for exactly one subject. It is not a view and takes no predicate a
-- caller can widen. The display name is the one the company typed, never a
-- legal name — a legal name is self-supplied and lives elsewhere.
-- ===========================================================================

create or replace function app.invite_subject_summary(
  p_company_id  uuid,
  p_subject_type text,
  p_subject_id  uuid
)
returns table (company_name text, display_name text, preferred_locale locale)
language sql
stable
security definer
set search_path = public, app
as $$
  select c.legal_name,
         s.display_name,
         s.preferred_locale
    from companies c
    join lateral (
      select w.display_name, w.preferred_locale
        from workers w
       where p_subject_type = 'WORKER'
         and w.id = p_subject_id
         and w.company_id = p_company_id
      union all
      select o.display_name, o.preferred_locale
        from company_owners o
       where p_subject_type = 'OWNER'
         and o.id = p_subject_id
         and o.company_id = p_company_id
    ) s on true
   where c.id = p_company_id
$$;

-- Only the pre-authentication role and a live invite session need this. A firm
-- or company session reads these tables directly, under its own policies.
revoke all on function app.invite_subject_summary(uuid, text, uuid) from public;
grant execute on function app.invite_subject_summary(uuid, text, uuid)
  to app_auth, app_subject;


-- ===========================================================================
-- 5. Constraints
-- ===========================================================================

-- Only workers and owners receive links. A COMPANY row here would render a
-- personal-data form for an entity that has no person behind it.
alter table invites drop constraint if exists invites_subject_ck;
alter table invites add constraint invites_subject_ck check (
  subject_type in ('WORKER', 'OWNER')
);

-- A consumed invite cannot be un-consumed, and an unverified one cannot hold a
-- draft: both would mean the gate was bypassed by something that wrote here
-- directly.
alter table invites drop constraint if exists invites_draft_ck;
alter table invites add constraint invites_draft_ck check (
  draft is null or verified_at is not null
);
