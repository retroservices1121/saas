/**
 * Staff authentication, against the real database.
 *
 * The parts worth testing here are the ones where getting it wrong is silent:
 * a TOTP code that can be replayed, a lockout that does not lock, a session
 * that is usable before its second factor, and — the one that matters most —
 * whether the pre-authentication Postgres role can reach tenant data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearThrottle,
  closeAdmin,
  countAuditRows,
  destroyStaffFixture,
  readUserAuthState,
  seedPendingStaffUser,
  type StaffFixture,
} from './fixtures';
import {
  completeSetup,
  completeTotp,
  login,
  resolveStaffSession,
  revokeStaffSession,
  verifyStepUp,
} from '../lib/auth/staff-auth';
import { counterForTime, hotp, base32Decode, verifyTotp, generateTotpSecret } from '../lib/auth/totp';
import { hashPassword, verifyPassword } from '../lib/security/password';
import { withScope, schema, ScopeViolationError } from '../lib/db/scoped';
import { anonymousSession } from '../lib/auth/session';
import { evictPlatformDek } from '../lib/security/platform-encryption';

const PASSWORD = 'correct horse battery staple';

let fixture: StaffFixture;
let secret: string;

/** The code an authenticator would be showing right now. */
function currentCode(atMs = Date.now()): string {
  return hotp(base32Decode(secret), counterForTime(atMs));
}

/**
 * A code for a step this user has not spent yet.
 *
 * Every successful verification burns its time step, which is the property
 * under test — so a test that wants a working code cannot simply generate one
 * from the current time if an earlier test already consumed that step. The
 * accept window is one step either side of now, so when the spent counter has
 * run ahead of the clock the only correct thing to do is wait for it.
 *
 * That wait is bounded by the 30-second step and happens at most once per run.
 * The alternative — widening the window, or clearing the counter between tests
 * — would test a system that does not exist.
 */
async function unspentCode(userId: string): Promise<string> {
  for (;;) {
    const state = await readUserAuthState(userId);
    const last = state.totpLastCounter ?? -1;
    const now = counterForTime();
    const target = Math.max(last + 1, now);
    if (target <= now + 1) return hotp(base32Decode(secret), target);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

beforeAll(async () => {
  fixture = await seedPendingStaffUser('FIRM_ADMIN');
  secret = generateTotpSecret();
});

afterAll(async () => {
  evictPlatformDek();
  if (fixture) await destroyStaffFixture(fixture);
  await closeAdmin();
});

// ---------------------------------------------------------------------------

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', () => {
    const encoded = hashPassword(PASSWORD);
    expect(verifyPassword(PASSWORD, encoded).valid).toBe(true);
    expect(verifyPassword(`${PASSWORD} `, encoded).valid).toBe(false);
  });

  it('produces a different hash every time', () => {
    // A deterministic hash means an identical stored value reveals that two
    // users chose the same password.
    expect(hashPassword(PASSWORD)).not.toBe(hashPassword(PASSWORD));
  });

  it('is a standard PHC string carrying its own parameters', () => {
    // Parameters travel with the hash so raising them later does not invalidate
    // every existing password.
    expect(hashPassword(PASSWORD)).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
  });

  it('does not accept a corrupted or foreign hash', () => {
    expect(verifyPassword(PASSWORD, 'not-a-hash').valid).toBe(false);
    expect(verifyPassword(PASSWORD, null).valid).toBe(false);
  });
});

describe('TOTP', () => {
  it('matches the RFC 4226 test vectors', () => {
    // Secret "12345678901234567890", the vector from the appendix.
    const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
    expect(hotp(rfcSecret, 0)).toBe('755224');
    expect(hotp(rfcSecret, 1)).toBe('287082');
    expect(hotp(rfcSecret, 2)).toBe('359152');
    expect(hotp(rfcSecret, 9)).toBe('520489');
  });

  it('accepts the neighbouring time steps but not distant ones', () => {
    const now = Date.now();
    const step = 30_000;
    expect(verifyTotp(secret, currentCode(now), null, now).valid).toBe(true);
    expect(verifyTotp(secret, currentCode(now - step), null, now).valid).toBe(true);
    expect(verifyTotp(secret, currentCode(now + step), null, now).valid).toBe(true);
    expect(verifyTotp(secret, currentCode(now - 3 * step), null, now).valid).toBe(false);
  });

  it('refuses a code whose step has already been spent', () => {
    const now = Date.now();
    const first = verifyTotp(secret, currentCode(now), null, now);
    expect(first.valid).toBe(true);
    // The same code, once the counter is recorded. This is what makes a code
    // read over a shoulder useless a moment later.
    expect(verifyTotp(secret, currentCode(now), first.counter, now).valid).toBe(false);
  });

  it('round-trips base32 through the encoding authenticators expect', () => {
    const generated = generateTotpSecret();
    expect(base32Decode(generated)).toHaveLength(20);
    // Tolerates the spacing people produce when typing a secret by hand.
    expect(base32Decode(generated.replace(/(.{4})/g, '$1 '))).toEqual(base32Decode(generated));
  });
});

// ---------------------------------------------------------------------------

describe('setup link', () => {
  it('will not complete with a code the secret does not produce', async () => {
    const outcome = await completeSetup(fixture.setupToken, PASSWORD, secret, '000000');
    expect(outcome.status).toBe('bad_code');

    // And the user is untouched — a failed setup must not half-activate anyone.
    const state = await readUserAuthState(fixture.userId);
    expect(state.status).toBe('pending');
    expect(state.totpEnabledAt).toBeNull();
  });

  it('sets the password, enrolls the authenticator, and activates the user', async () => {
    // The step is captured before the call rather than read back after it: the
    // clock can cross a 30-second boundary mid-test, and asserting against
    // "the step now" would fail for a reason that has nothing to do with the
    // code under test.
    const at = Date.now();
    const outcome = await completeSetup(fixture.setupToken, PASSWORD, secret, currentCode(at));
    expect(outcome.status).toBe('ok');

    const state = await readUserAuthState(fixture.userId);
    expect(state.status).toBe('active');
    expect(state.totpEnabledAt).not.toBeNull();
    // The enrollment code is spent, so it cannot also be used to log in.
    expect(state.totpLastCounter).toBe(counterForTime(at));
  });

  it('is single-use', async () => {
    const again = await completeSetup(
      fixture.setupToken,
      PASSWORD,
      secret,
      await unspentCode(fixture.userId),
    );
    expect(again.status).toBe('invalid_token');
  });
});

describe('login', () => {
  it('refuses a wrong password and counts the failure', async () => {
    const before = await readUserAuthState(fixture.userId);
    const outcome = await login(fixture.email, 'wrong password entirely');
    expect(outcome.status).toBe('invalid');

    const after = await readUserAuthState(fixture.userId);
    expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
  });

  it('gives an unknown address the same answer as a wrong password', async () => {
    // Anything else turns the login form into an address-enumeration oracle.
    const outcome = await login(`nobody-${Date.now()}@example.test`, PASSWORD);
    expect(outcome.status).toBe('invalid');
  });

  it('accepts the password but issues nothing usable until TOTP', async () => {
    const outcome = await login(fixture.email, PASSWORD, { ip: '203.0.113.5' });
    expect(outcome.status).toBe('totp_required');

    if (outcome.status !== 'totp_required') throw new Error('unreachable');

    // The token exists, and resolves to nothing: the session is not a session
    // until the second factor lands.
    expect(await resolveStaffSession(outcome.token)).toBeNull();
  });

  it('promotes the session once a valid code arrives, and writes LOGIN_SUCCESS', async () => {
    const started = await login(fixture.email, PASSWORD);
    if (started.status !== 'totp_required') throw new Error('expected totp_required');

    const before = await countAuditRows(fixture.firmId, 'LOGIN_SUCCESS');

    const verified = await completeTotp(started.token, await unspentCode(fixture.userId));
    expect(verified.status).toBe('ok');
    if (verified.status !== 'ok') throw new Error('unreachable');

    // The token ROTATES at the privilege boundary. The pending one was a secret
    // worth almost nothing — a row that could only accept a code — and
    // promoting it in place would turn that same secret into a twelve-hour
    // session for anyone who had observed it meanwhile.
    expect(verified.token).not.toBe(started.token);
    expect(await resolveStaffSession(started.token)).toBeNull();

    const resolved = await resolveStaffSession(verified.token);
    expect(resolved?.userId).toBe(fixture.userId);
    expect(resolved?.role).toBe('FIRM_ADMIN');

    expect(await countAuditRows(fixture.firmId, 'LOGIN_SUCCESS')).toBeGreaterThan(before);

    // Revocation takes effect on the next request, not on the next expiry.
    await revokeStaffSession(verified.token);
    expect(await resolveStaffSession(verified.token)).toBeNull();
  });

  it('a wrong code spends the pending session, so it cannot be retried', async () => {
    const started = await login(fixture.email, PASSWORD);
    if (started.status !== 'totp_required') throw new Error('expected totp_required');

    expect((await completeTotp(started.token, '000000')).status).toBe('invalid');

    // Not merely rejected — the pending row is revoked, so a guessing run
    // cannot reuse one five-minute window. Each new window costs the password
    // again, and those are counted.
    expect((await completeTotp(started.token, '000000')).status).toBe('expired');
  });

  it('throttles second-factor attempts', async () => {
    // Nothing counted these before: the pending session was five minutes of
    // unlimited six-digit guesses, and a correct password reset the lockout, so
    // the windows were free to mint.
    let throttled = false;
    for (let attempt = 0; attempt < 8 && !throttled; attempt++) {
      const started = await login(fixture.email, PASSWORD);
      if (started.status === 'throttled') break;
      if (started.status !== 'totp_required') continue;
      const outcome = await completeTotp(started.token, '000000');
      throttled = outcome.status === 'throttled';
    }
    expect(throttled).toBe(true);
  });

  it('locks the account after five consecutive failures', async () => {
    for (let i = 0; i < 5; i++) {
      await login(fixture.email, 'still the wrong password');
    }
    const state = await readUserAuthState(fixture.userId);
    expect(state.lockedUntil).not.toBeNull();

    const outcome = await login(fixture.email, PASSWORD);
    expect(outcome.status).toBe('locked');
  });
});

describe('step-up re-authentication', () => {
  beforeEach(async () => {
    // The throttle above was deliberately exhausted, and it is shared with this
    // path on purpose — same secret, same counter.
    await clearThrottle(fixture.userId, fixture.email);
  });

  it('accepts a code from an unspent step, then refuses that same code', async () => {
    const code = await unspentCode(fixture.userId);

    expect(await verifyStepUp(fixture.userId, code)).toBe(true);

    // Spent. This is what stops a code captured by a phishing proxy from being
    // replayed against a reveal seconds later, and it is why two reveals inside
    // the same 30-second window need two different codes.
    expect(await verifyStepUp(fixture.userId, code)).toBe(false);
  });

  it('refuses anything that is not six digits', async () => {
    expect(await verifyStepUp(fixture.userId, 'abcdef')).toBe(false);
    expect(await verifyStepUp(fixture.userId, '12345')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the pre-authentication role cannot reach tenant data', () => {
  const session = anonymousSession();

  it('has no privilege on worker_records', async () => {
    await expect(
      withScope(session, async (db) => db.select().from(schema.workerRecords).limit(1)),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('has no privilege on companies, company_owners, or documents', async () => {
    for (const table of [schema.companies, schema.companyOwners, schema.documents]) {
      await expect(
        withScope(session, async (db) => db.select().from(table).limit(1)),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    }
  });

  it('can still do the one thing it exists for', async () => {
    const rows = await withScope(session, async (db) =>
      db.select({ id: schema.users.id }).from(schema.users).limit(1),
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it('cannot change a user\'s role or tenancy', async () => {
    // Column-level UPDATE: the login path may set a password hash and a lockout
    // and nothing else. A statement naming `role` fails before any policy runs.
    await expect(
      withScope(session, async (db) =>
        db.update(schema.users).set({ role: 'PLATFORM_ADMIN' }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolationError);

    await expect(
      withScope(session, async (db) => db.update(schema.users).set({ firmId: null })),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });
});
