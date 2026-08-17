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

All seventeen steps of the spec's build order are implemented. 133 tests pass
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
4. **`KMS_PROVIDER=aws`** and **`STORAGE_PROVIDER=s3`**, both of which are
   interfaces with the local implementation written and the production one
   stubbed with an explicit error.

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
pnpm test            # 133 tests, needs the database
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
defend the initial SMS.

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
tests/                 133 tests; the isolation suite is spec section 5
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
| Key management | master key in env, same AES-256-GCM envelope | AWS KMS (`KMS_PROVIDER=aws`, not yet implemented) |
| Object storage | filesystem, signed expiring URLs | S3, private, SSE-KMS |
| SMS | server log | Twilio (implemented, needs credentials) |
| Email | server log | Resend (implemented, needs credentials) |
