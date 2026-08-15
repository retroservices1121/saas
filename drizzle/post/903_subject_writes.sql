-- ---------------------------------------------------------------------------
-- 903_subject_writes
--
-- What a worker or owner may write about themselves, and nothing more.
--
-- An owner has this already: 900 gives app_subject UPDATE on company_owners and
-- the policy limits it to their own row. A worker does not, and cannot be given
-- the same thing, because the worker's own data is not on `workers` — that table
-- is the company's, and letting a subject write to it would let them change a
-- job title or a start date the company entered.
--
-- What a worker must be able to do at the end of the form is exactly two
-- things: insert their `worker_records` row (already granted), and mark
-- themselves submitted. So: two columns, one policy, and no more.
-- ---------------------------------------------------------------------------

-- Multiple permissive policies on the same command are OR-ed, so this sits
-- alongside workers_write rather than replacing it.
drop policy if exists workers_subject_update on workers;
create policy workers_subject_update on workers
  for update using (
    app.can_read_company(company_id)
    and app.actor_role() = 'WORKER'
    and id = app.subject_id()
  )
  with check (
    app.can_read_company(company_id)
    and app.actor_role() = 'WORKER'
    and id = app.subject_id()
  );

-- Column-limited: status and the submission timestamp. A statement naming
-- job_title, pay_type, or phone_e164 fails with insufficient_privilege before
-- the policy is ever consulted.
grant update (status, submitted_at, updated_at) on workers to app_subject;

-- The owner side, restated here so both halves of "a subject marks itself
-- submitted" are in one file rather than split across two.
grant update (
  status, submitted_at, legal_first_name, legal_middle_name, legal_last_name,
  date_of_birth, address_line1, address_line2, city, state, postal_code,
  email, tin_type, tin_enc, tin_last4, updated_at
) on company_owners to app_subject;

-- And the read side for an owner filling in their own row: they may see the
-- name and percentage the company entered, plus whatever they have already
-- supplied. The column list is the whole table because it is their own data —
-- what stops this being a leak is the policy, which restricts it to
-- `id = app.subject_id()`.
grant select on company_owners to app_subject;
