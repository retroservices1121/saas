-- ---------------------------------------------------------------------------
-- 908_email_invites
--
-- Invites moved from SMS to email. Two consequences for the grants.
--
-- `company_owners` is column-limited for app_company — that is what makes
-- "not even last-4" true — so the new `invite_email` has to be added to that
-- grant explicitly. It belongs firmly on the company-entered side: the company
-- types it in order to send the link.
--
-- The self-supplied `email` column, which the owner fills in on their own form,
-- stays out of the company's reach exactly as before. Two columns holding an
-- email address, two provenances, two different answers to "may the company
-- read this".
-- ---------------------------------------------------------------------------

grant select (invite_email) on company_owners to app_company;
grant insert (invite_email) on company_owners to app_company;
grant update (invite_email) on company_owners to app_company;

-- A subject may still write its own half of the row.
grant update (invite_email) on company_owners to app_subject;
