-- ---------------------------------------------------------------------------
-- 905_retention
--
-- Makes the retention purge possible without giving up what NOT NULL was
-- protecting.
--
-- Spec section 13 requires a nightly job that "nulls the `_enc` and `_last4`
-- columns, keeps the row skeleton and the full audit trail". Spec section 4
-- declares `tin_enc` and `tin_last4` NOT NULL, which is right for a live
-- record — a submitted worker record without a tax ID is a data-loss bug, and
-- the constraint is what catches it.
--
-- Both are correct, and they contradict each other for exactly one row state:
-- purged. So the columns become nullable and a check constraint restores the
-- guarantee conditionally — a tax ID may be absent if and only if the row is
-- marked purged. A record cannot be written without one, and cannot lose one
-- except by being purged, which is stamped and audited.
--
-- The alternative, deleting the row, was rejected: the audit log points at
-- these ids, and "REVEAL_TIN on record X" with no record X is a dangling
-- reference in exactly the trail an investigation would be reading.
-- ---------------------------------------------------------------------------

alter table worker_records drop constraint if exists worker_records_purge_ck;
alter table worker_records add constraint worker_records_purge_ck check (
  -- Live: both present. Purged: both absent.
  (purged_at is null and tin_enc is not null and tin_last4 is not null)
  or (purged_at is not null and tin_enc is null and tin_last4 is null)
);

-- The last-4 format check has to tolerate the purged state now.
alter table worker_records drop constraint if exists worker_records_last4_ck;
alter table worker_records add constraint worker_records_last4_ck check (
  (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$')
  and (routing_last4 is null or routing_last4 ~ '^[0-9]{4}$')
  and (account_last4 is null or account_last4 ~ '^[0-9]{4}$')
);

-- A purged record keeps no banking either.
alter table worker_records drop constraint if exists worker_records_purge_bank_ck;
alter table worker_records add constraint worker_records_purge_bank_ck check (
  purged_at is null
  or (routing_enc is null and routing_last4 is null
      and account_enc is null and account_last4 is null)
);

-- Owners are already nullable — an owner who has not submitted has no tax ID —
-- so only the purged-means-empty half applies.
alter table company_owners drop constraint if exists owners_purge_ck;
alter table company_owners add constraint owners_purge_ck check (
  purged_at is null or (tin_enc is null and tin_last4 is null)
);

-- Purging is an owner-level operation, run out of band. No application role
-- gains anything here: worker_records already has UPDATE revoked from all of
-- them, and this restates it so the revocation survives a future file that
-- grants broadly.
revoke update on worker_records from app_platform, app_firm, app_company, app_subject, app_auth;
