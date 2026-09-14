# Onboarding Platform

Three-party intake platform for Kijoenna Services Inc. Built to
[`ONBOARDING_SAAS_SPEC_V2.md`](./ONBOARDING_SAAS_SPEC_V2.md).

An accounting firm onboards its client companies and is the only party that ever
reads sensitive data. A company registers itself and invites its owners and
workers. Each of those people supplies their own tax ID and banking details
through their own single-use link.

> *el empleador no debe ver ni recolectar estos datos directamente*

The employer must not see or collect the worker's data directly. Every design
decision here follows from that sentence.

**This is not payroll.** It collects, validates, stores, and hands off. It does
not calculate, withhold, file, or move money.

---

## Build status

All seventeen steps of the spec's build order are implemented. 165 tests pass
against Postgres 16 with row level security forced.

| Step | Status |
|---|---|
| 1. Schema, RLS, grants, five isolation tests | Done — all five pass against a real database |
| 2. Field encryption, KMS wiring, ESLint restriction, log redaction | Done (KMS behind a provider interface; `local` implemented, `aws` stubbed) |
| 3. Audit log | Done |
| 4. Staff auth with mandatory TOTP | Done — first-party, see the deviation below |
| 5. Firm creates company, grant, company admin setup | Done |
| 6. Company profile, documents, company banking | Done |
| 7. Invite engine | Done — see the note on the date-of-birth gate |
| 8–9. Owner and worker forms | Done |
| 10. E-signature | Done — **text is placeholder, needs counsel** |
| 11. i18n across everything | Done — `en` and `es`, no hardcoded strings |
| 12. Firm dashboard, masked views, reveal | Done |
| 13. Company dashboard, status-only views | Done |
| 14. Notes and documents tabs with the visibility split | Done |
| 15. Reminders | Done |
| 16. Export | Done — AES-256 archive, verified against an independent reader |
| 17. Retention jobs | Done |

### What must happen before this touches a real tax ID

1. **The e-signature text.** `lib/esign/documents.ts` contains competent
   placeholder copy that no lawyer has read. Spec sections 9 and 16 require the
   direct deposit authorization and the data accuracy certification to come from
   the client's counsel in English and then be **human**-translated to Spanish.
   The Spanish in the repo is machine translation and is marked as such in
   `messages/es.json`. The application refuses to start in production until
   `ESIGN_TEXTS_APPROVED=true` is set, which should only happen once the
   approved copy is in place.
2. **A data processing agreement.** The platform is a processor; the firm and
   the companies are controllers.
3. **The date-of-birth gate on a first invite** — see below.
4. **A real key custodian.** `KMS_PROVIDER=vault` and a Vault Transit key —
   see "Deploying on Railway" below. The `local` provider puts a master key in
   an environment variable, which means anyone holding that variable holds
   every tenant's data and nothing records that they used it.

---

## Running it

```bash
pnpm install

# 1. A Postgres 16. ADMIN_DATABASE_URL owns the tables; DATABASE_URL is the app.
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # APP_DB_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # LOCAL_KMS_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # AUTH_SECRET

pnpm db:bootstrap    # migrate, then create app_user
pnpm test            # 165 tests, needs the database
pnpm db:seed         # a demo firm, company, worker and owner, with links
pnpm dev
```

`pnpm db:seed` prints a company-admin setup link and two invite links. Following
the worker link walks the whole intake flow.

### Why two connection strings

Railway hands you a superuser. **A superuser bypasses Row Level Security
unconditionally** — `FORCE ROW LEVEL SECURITY` does not apply to it. Running the
application on that credential would silently disable layer 1 while every policy
still looked correct in the schema, and every isolation test would pass for the
wrong reason.

So `ADMIN_DATABASE_URL` owns the tables and runs migrations, and `DATABASE_URL`
points at `app_user`, which holds **no table privileges of its own**
(`NOINHERIT`). It acquires them for the duration of a single transaction by
switching into one of five group roles. `lib/db/scoped.ts` is the only code that
performs that switch. The app refuses to boot if it detects it is connected as a
superuser.

---

## Access enforcement

Three layers. All three required. Each holds on its own — that is the point of
having three.

**Layer 1 — Postgres RLS.** Every company-scoped table has a policy keyed on
`app.can_read_company()`, which reads the transaction-local scope *and*, for firm
sessions, re-derives the grant from `firm_company_grants`. A bug that put the
wrong company id into a session's scope still reads nothing.

**Layer 2 — the scoped DAL.** All queries go through `lib/db/scoped.ts`. No route
handler imports the raw Drizzle client; `no-restricted-imports` makes a bypass a
build failure rather than a code-review miss.

**Layer 3 — the decrypt guard.** `decryptField()` refuses unless the caller is a
firm role, the data subject inside a live invite session, or a `COMPANY_ADMIN`
reading its own company's bank account. A `COMPANY_ADMIN` session reaching it for
anything else throws and writes a `SECURITY_VIOLATION` row rather than returning
empty — an empty return looks like missing data and gets triaged as a
data-quality ticket instead of a security defect.

### The part RLS cannot do

Row Level Security has no column dimension, and the spec requires that a company
user never see a worker's or owner's sensitive fields **"not even last-4."** So
`app_company` holds column-level `SELECT` on `company_owners` covering the
company-entered columns only. `tin_last4` is not nameable by that role — a
hand-written query selecting it fails with `insufficient_privilege`, which the
DAL converts into not-found plus an audit row.

On `worker_records`, `app_company` holds **nothing at all**. Not a
column-limited select, not a count.

The same technique protects `invites`: a company can see that an invite exists
and whether it has been opened, and cannot name `token_hash`, `expected_dob_hash`,
or `draft` — the last of which holds every answer typed so far.

### The five Postgres roles

| Role | Reached by | Can see |
|---|---|---|
| `app_firm` | firm sessions | everything within granted companies |
| `app_company` | company sessions | its own company; column-limited on owners; **nothing** on worker_records |
| `app_subject` | a live invite session | its own row |
| `app_platform` | platform admin | firms, users, audit metadata. No company data at all |
| `app_auth` | the login and invite-open paths, before identity exists | users, sessions, setup tokens, the platform key. Cannot name a company, worker, owner, document, or note |

`app_auth` exists because a login has to read a row in order to work out who is
asking, which no scope can express. Its `UPDATE` on `users` is limited to the
login bookkeeping columns, so the login path cannot change anyone's role, firm,
or company. There is a test that tries.

---

## Deviations and open questions

### Auth is first-party, not Auth.js v5

The spec's stack table names Auth.js v5. What this system needs from auth is
step-up re-authentication bound to a single field reveal, session scope derived
from `firm_company_grants` at session start, and subject invite sessions that are
not logins at all. Auth.js would have been a wrapper around code that still had
to exist. So `lib/auth/` is first-party: argon2id via `@noble/hashes`, RFC 6238
TOTP on `node:crypto`, and server-side session rows behind an HMAC-signed
httpOnly cookie.

Server-side sessions rather than a self-contained JWT, because the two things
this system most needs are to revoke a session immediately and to know which
sessions exist. A stateless token can do neither.

### TOTP codes are single-use

The accepted time step is recorded and never accepted again. That costs a firm
user up to a 30-second wait between two consecutive reveals. It is real friction
and it belongs in the conversation the spec opens in section 16 item 4 — but a
replayable one-time password is not a second factor.

### The date-of-birth gate on a first invite

This is the one place where the implementation cannot fully deliver what section
7.5 describes, and it needs a decision from the client.

The gate exists so that a link intercepted by the company admin is inert. That
requires an expected date of birth to check against. On a **re-issued** link
there is one — the current `worker_records` row — and the gate is real. On a
**first** invite there is nothing: a worker who has never submitted has no date
of birth anywhere in this system, by design, because the company was never asked
for one.

What is implemented: the first visit pins whatever date is entered, and every
later visit must match it. That defends a link forwarded or intercepted
mid-flow, and it is what makes screen 3 a read-only confirmation. It does not
defend the initial email.

This is why `assertInvitableEmail` refuses an invite address on the company's
own email domain. The two gaps compound: an employer who controls the mailbox
receives the first link, and a first link's gate pins on whatever date the
reader types. Refusing the mailbox removes the only version of that attack that
happens by default rather than on purpose.

Closing that gap means asking the company to supply the worker's date of birth
when creating them — which the spec says they do not have, though in practice an
employer usually does. **That is a question for the client, not a decision to
make in code.**

The expected value is stored as an argon2id hash, never as a date, and the
column is outside `app_company`'s grant — so even the party the gate protects
against cannot read it, and could not invert it quickly if they could.

### Additions to the spec's enums

`SECURITY_VIOLATION`, `DOCUMENT_UPLOADED`, and `DOCUMENT_DELETED` were added to
the audit action list; `SIGNED_AUTHORIZATION` was added to the document types.
The last one was a bug fix: signature PDFs were being stored as `OTHER`, which is
the type a company admin uses for an ordinary business document, so they were
landing `COMPANY_VISIBLE`.

---

## What a security review found

An adversarial pass over the finished system found seven real defects. They are
fixed, and `tests/rls-policies.test.ts` exists because of the first two — it
exercises the Postgres policies directly rather than through the data access
layer, since going through the DAL proves the two layers together and cannot
tell you which one is holding.

**A `FOR ALL` policy applies its USING clause to SELECT.** `users_write` was
`FOR ALL` with no firm predicate, and permissive policies are OR-ed per command,
so it silently became the effective read rule for the whole table. Measured on a
seeded instance: a firm admin could read all 11 users including 8 belonging to
other firms, and a password hash. Layer 1 contributed nothing on `users`; only
the hand-written `WHERE` clauses were holding, which is the inverse of the
design.

**`can_read_company()` is true for a subject's own company**, so an invite policy
reading `can_read_company(company_id) OR subject_id = app.subject_id()` made the
second clause dead code. One worker could read every other worker's `draft` —
their legal name, date of birth and address, in plaintext, mid-form — and could
write another subject's `token_hash` to mint a session as them.

**Nothing rate-limited TOTP.** The password path had a throttle; the second
factor had none, no attempt counter, and a wrong code left the pending session
alive. Five minutes of unlimited six-digit guesses is roughly a coin flip — and
a correct password used to clear the lockout, so an attacker holding one could
mint fresh windows indefinitely.

**The session token was not rotated when the session was promoted** from
password-verified to TOTP-verified. Textbook session fixation: a token observed
while it was worth nothing became a twelve-hour session the moment the real user
finished logging in.

**A setup link reactivated a suspended user.** `completeSetup` validated the
token and never read `users.status`, and suspending a user does not touch their
setup tokens — so anyone suspended within their first 24 hours could open the
link they had already been sent and set themselves back to active.

**Two server actions trusted a bound `companyId`.** A server action argument is
an HTTP parameter however it was bound in the component. A firm user with grants
on two companies could file a worker's corrected record under the wrong one,
sealed with the wrong data key — which silently breaks both grant revocation and
the cryptographic shred.

**The DEK cache was consulted before the scope check.** The scoped `SELECT` is
the only thing enforcing "this company is in your scope", and a cache hit skipped
it. `decryptField` has an independent guard and was never exposed; the write
paths had no second guard.

---

## Things worth knowing before changing this code

**Drizzle names every column in an INSERT**, passing `default` for the ones you
did not supply. Postgres checks INSERT privilege on every column *mentioned*, so
column-level INSERT grants are unusable through the ORM — it fails with
`permission denied for table`, which reads like a missing grant. `insertColumns()`
in `lib/db/scoped.ts` exists for the two tables where the grant is the control.

**`INSERT ... RETURNING` is invisible to the inserting session** when RLS applies,
because Postgres applies the SELECT policy to the RETURNING clause. That is why
ids are generated in the application (`lib/uuid.ts`).

**The migration runner re-applies all of `drizzle/post/` when any of them
changes.** They are idempotent, and a later file often narrows what an earlier
one granted; re-applying only the changed file restores the wider grant and
drops the narrowing.

**`use server` files may only export async functions.** An exported constant
500s every page that imports the module.

**postgres.js serializes JSON for a `jsonb` parameter itself.** Passing it a
pre-stringified object stores a jsonb *string*, the insert succeeds, and every
later `metadata->>'key'` returns null. Use `sql.json()`.

---

## Layout

```
app/
  (auth)/              sign in, TOTP, account setup
  (app)/               authenticated staff: firm and company dashboards
  i/[token]            the invite link — a route handler, so the token leaves
                       the URL in one hop
  i/verify             the date-of-birth gate
  form/[step]          the worker and owner flow, one question per screen
  api/exports/[id]     authenticated export download
  api/files            signed URLs for the local storage provider
  _actions/            server actions; return i18n keys, never sentences
lib/
  auth/                sessions, TOTP, scope derivation
  db/
    client.ts          the ONLY place a connection is opened — import-banned
    scoped.ts          the ONLY entry point for queries
    schema/            Drizzle table definitions
    queries/           explicit column projections; no `select *` anywhere
  security/            AES, KMS, field encryption, redaction, response scanning
  esign/               the authorization texts and ESIGN capture
  jobs/                reminders and retention — run as the table owner, on
                       purpose; see the note at the top of context.ts
  forms/wizard.ts      the screen list, as data
  zip.ts               WinZip AE-2 AES-256, for exports
  pdf.ts               a minimal PDF writer, for signature records
drizzle/
  prelude/             app schema, uuid v7
  generated/           produced by `pnpm db:generate` — never hand-edited
  post/                RLS, roles, grants, triggers, constraints
tests/                 165 tests; isolation.test.ts is spec section 5,
                       rls-policies.test.ts exercises layer 1 on its own
docs/DESIGN_BRIEF.md   a brief for designing the UI properly
```

## Commands

```bash
pnpm dev              # development server
pnpm typecheck        # tsc --noEmit
pnpm lint             # includes the Layer 2 import ban
pnpm test             # everything (needs a database)
pnpm zip:verify       # reads an export back with pyzipper, an independent
                      # AES-zip implementation (pip install pyzipper)
pnpm db:generate      # regenerate table DDL from lib/db/schema
pnpm db:bootstrap     # migrate + create app_user
pnpm db:seed          # a demo tenant, with links printed
pnpm jobs nightly     # reminders, purge, export expiry, session pruning
pnpm jobs <name> --dry-run
```

`pnpm jobs` connects as the table owner. That is necessary because the retention
purge needs `UPDATE` on `worker_records`, and that privilege is revoked from
every application role precisely so the table is append-only.

## External services

All behind interfaces, with local implementations so the build runs without
credentials. Swapping to the real service is an environment change, not a
refactor.

| Service | `local` / `console` | Production |
|---|---|---|
| Key management | master key in env, same AES-256-GCM envelope | Vault Transit (`KMS_PROVIDER=vault`). AWS KMS is stubbed. |
| Object storage | filesystem | Any S3-compatible bucket (`STORAGE_PROVIDER=s3`) |
| Email | server log | Resend (implemented, needs credentials) |

---

## Deploying on Railway

Nothing here needs AWS.

### Storage — Railway Buckets

Attach a Bucket to the service. Railway injects `AWS_S3_BUCKET_NAME`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL` and
`AWS_DEFAULT_REGION`, which the S3 provider picks up without further
configuration. Set `STORAGE_PROVIDER=s3`.

The same provider works unchanged against Cloudflare R2, MinIO, and AWS S3 —
they are the same API.

Two things Railway Buckets do not have, and why neither matters here:

- **No server-side encryption.** Every object is encrypted with the owning
  company's data key *before* upload, so the provider holds ciphertext and no
  key. That is strictly stronger than SSE-KMS: a compromise of the bucket yields
  nothing, and destroying a company's DEK shreds its voided checks and ID
  photographs along with its tax IDs — which server-side encryption under the
  provider's key could not do. There is a test for exactly that.
- **No lifecycle rules.** The 24-hour export deletion is done by
  `pnpm jobs expire-exports`, in application code, with an audit row. A
  lifecycle rule would have been the version that deletes silently.

A consequence worth knowing: because stored objects are ciphertext, presigned
URLs are meaningless and there are none. Documents stream through the
application, which means every read is an authenticated request that writes a
`DOCUMENT_VIEWED` row, and revoking a session revokes the read with it.

### Keys — Vault Transit

Railway has no key management service, and no amount of configuration makes an
environment variable into one. The realistic options are Vault, a hyperscaler
KMS, or accepting the risk explicitly.

With [HCP Vault](https://developer.hashicorp.com/vault) (free tier) or any Vault
you run:

```bash
vault secrets enable transit
vault write -f transit/keys/onboarding derived=true
```

Then set `KMS_PROVIDER=vault`, `VAULT_ADDR`, and `VAULT_TOKEN`.

`derived=true` is the part that matters. Vault then derives a distinct wrapping
key per company, so a wrapped DEK lifted from one company's row cannot be
unwrapped as another's even by a caller holding a valid Vault token. It is the
same property the local provider gets from AAD, obtained from the key hierarchy
instead.

The application does a real wrap/unwrap at boot and refuses to start if the
token, mount, key name, or `derived` setting disagree — a misconfigured KMS
otherwise surfaces the first time somebody onboards a company, which is the
worst possible moment to discover it.

Rotation is `vault write -f transit/keys/onboarding/rotate`. New DEKs wrap under
v2; every existing `vault:v1:` DEK keeps unwrapping. Nothing is re-encrypted.

### The first account

A freshly migrated database has nobody who can log in. Every account has a
maker — a platform admin creates a firm and its first admin, a firm admin
creates a company and its first admin, a company admin invites owners and
workers — and that chain has to start outside the request path, because the
first account has no session that predates it.

```bash
pnpm db:create-platform-admin "Ada Lovelace" ada@yourfirm.com
```

It prints a 24-hour single-use setup link. It does **not** set a password: the
first admin enrolls their own password and their own authenticator through the
same `/setup/[token]` screen everyone else uses, so no operator ever knows their
credentials. The link is printed rather than emailed because at bootstrap the
mail credentials may not be configured yet, and a link that silently went
nowhere would leave an account nobody can reach.

It refuses to run a second time. Further platform staff go through the platform
UI, where the action is audited — this script is not.

### Jobs — a second Railway service

Reminders and retention do not run unless something schedules them. On Railway
that is a **second service from the same repo**, with a cron schedule and no
healthcheck:

1. New service → same GitHub repo.
2. Variables → `RAILWAY_CONFIG_PATH = railway.cron.json`, and give it the same
   `ADMIN_DATABASE_URL`, `KMS_PROVIDER`, `VAULT_*`, `STORAGE_PROVIDER`, `AWS_*`
   (or `S3_*`), `EMAIL_PROVIDER`, `RESEND_API_KEY` and `EMAIL_FROM` values as
   the web service. Use Railway variable references — `${{saas.ADMIN_DATABASE_URL}}`
   and so on — rather than pasting values, so rotating a key on the web service
   rotates it here too. The nightly job sends reminders; without the mail
   credentials it will run to completion and deliver nothing.
3. Confirm Settings → Cron Schedule reads `0 9 * * *` (UTC). Set it there if the
   config file did not apply it.

`railway.cron.json` sets the start command to `pnpm jobs nightly` and
`restartPolicyType: NEVER` — a cron service that restarts on exit is an infinite
loop, not a schedule.

Two failure modes are worth knowing about, because both are silent:

**A job that does not exit stops the schedule permanently.** Railway skips the
next execution while the previous one is still Active, so a lingering
keep-alive socket — the AWS SDK's pool will do it — turns one hung run into
"reminders stopped going out three weeks ago". `scripts/jobs.ts` calls
`process.exit` explicitly rather than trusting the event loop to drain.

**Two overlapping runs send duplicate reminders.** Railway's skip covers the
scheduled case, not an operator running `pnpm jobs nightly` by hand during one,
or a second environment pointed at the same database. The runner takes a
Postgres advisory lock and exits 0 with "another job run holds the lock" if it
cannot get it — the jobs are each idempotent, but not against themselves
running at the same instant.

Any scheduler works, not just Railway's: the command is `pnpm jobs nightly` and
it is safe to invoke from anywhere, as often as you like.

```bash
pnpm jobs nightly --dry-run   # what would happen, without doing it
```
