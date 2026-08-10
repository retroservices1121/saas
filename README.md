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

Step 1 of the spec's build order is complete: schema, RLS, grants, and the five
isolation tests. The spec gates everything else on those tests passing, so no
feature work has started.

| Step | Status |
|---|---|
| 1. Schema, RLS, grants, five isolation tests | Written; **tests unrun — needs a database** |
| 2. Field encryption, KMS wiring, ESLint restriction, log redaction | Done (KMS behind a provider interface; `local` implemented, `aws` stubbed) |
| 3. Audit log | Table + append-only enforcement done; action coverage grows with each feature |
| 4–17 | Not started |

---

## Getting a database

The isolation tests cannot be stubbed — Row Level Security is the thing under
test, and a mocked database would pass every assertion while proving nothing.

1. Add a Postgres service to the Railway project.
2. Copy its connection string into `.env` as `ADMIN_DATABASE_URL`.
3. Generate an app password and a local KMS master key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # APP_DB_PASSWORD
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # LOCAL_KMS_MASTER_KEY
   ```

4. Bootstrap, then point `DATABASE_URL` at the role it creates:

   ```bash
   pnpm install
   pnpm db:bootstrap        # migrate, then create app_user
   # set DATABASE_URL=postgresql://app_user:<APP_DB_PASSWORD>@<host>:<port>/railway
   pnpm test
   ```

### Why two connection strings

Railway hands you a superuser. **A superuser bypasses Row Level Security
unconditionally** — `FORCE ROW LEVEL SECURITY` does not apply to it. Running the
application on that credential would silently disable layer 1 while every policy
still looked correct in the schema, and every isolation test would pass for the
wrong reason.

So `ADMIN_DATABASE_URL` owns the tables and runs migrations, and `DATABASE_URL`
points at `app_user`, which holds **no table privileges of its own**
(`NOINHERIT`). It acquires them for the duration of a single transaction by
switching into one of four group roles. `lib/db/scoped.ts` is the only code that
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
firm role or the data subject inside a live invite session. A `COMPANY_ADMIN`
session reaching it throws and writes a `SECURITY_VIOLATION` row rather than
returning empty — an empty return looks like missing data and gets triaged as a
data-quality ticket instead of a security defect.

### The part RLS cannot do

Row Level Security has no column dimension, and the spec requires that a company
user never see a worker's or owner's sensitive fields **"not even last-4."** So
`app_company` holds column-level `SELECT` on `company_owners` covering the
company-entered columns only. `tin_last4` is not nameable by that role — a
hand-written query selecting it fails with `insufficient_privilege`, which the
DAL converts into not-found plus an audit row.

On `worker_records`, `app_company` holds **nothing at all**. Not a column-limited
select, not a count.

---

## Layout

```
app/                     Next.js App Router
i18n/, messages/         next-intl; en and es, no hardcoded strings
lib/
  auth/session.ts        session shapes; scope is derived server-side, never trusted
  db/
    client.ts            the ONLY place a connection is opened — import-banned
    scoped.ts            the ONLY entry point for queries
    schema/              Drizzle table definitions
    queries/             explicit column projections; no `select *` anywhere
  security/
    aes.ts               AES-256-GCM primitives, import-restricted
    kms.ts               envelope encryption behind a provider interface
    field-encryption.ts  encryptField / decryptField + the decrypt guard
    redaction.ts         global log scrubbing
drizzle/
  prelude/               app schema, uuid v7
  generated/             produced by `pnpm db:generate` — never hand-edited
  post/                  RLS, roles, grants, triggers, constraints
tests/isolation.test.ts  the five tests from spec section 5
scripts/                 migrate, setup-roles
```

## Commands

```bash
pnpm dev            # development server
pnpm typecheck      # tsc --noEmit
pnpm lint           # includes the Layer 2 import ban
pnpm test           # isolation tests (needs a database)
pnpm db:generate    # regenerate table DDL from lib/db/schema
pnpm db:bootstrap   # migrate + create app_user
```

## External services

All behind interfaces, with local implementations so the build runs without
credentials. Swapping to the real service is an environment change, not a
refactor.

| Service | `local` / `console` | Production |
|---|---|---|
| Key management | master key in env, same AES-256-GCM envelope | AWS KMS (`KMS_PROVIDER=aws`, not yet implemented) |
| Object storage | filesystem | S3, private, SSE-KMS |
| SMS | server log | Twilio |
| Email | server log | Resend or SES |

## Open items from the client

Spec section 16 lists five. Two block launch and should be requested now: the
consent, direct deposit authorization, and data accuracy text from counsel in
English with a human Spanish translation (machine translation is not acceptable
for those two documents), and a data processing agreement — the platform is a
processor, the firm and companies are controllers — which should exist before
the first real SSN enters the system.
