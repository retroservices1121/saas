/**
 * Firm staff administration, against the real database.
 *
 * The constraint under test is `users_totp_ck`: a FIRM_ADMIN or FIRM_STAFF row
 * cannot be `active` without an enrolled authenticator. Every assertion here
 * exists because reactivating somebody who had never finished their setup
 * violated it — Postgres rejected the UPDATE, the server action threw, and the
 * firm admin saw "Application error: a server-side exception has occurred".
 *
 * Which is a bug the type system cannot see: `status` is 'active' | 'suspended'
 * at every layer, and every one of those layers is right. The invariant lives
 * in the database, so the test has to as well.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAdmin,
  destroyFirm,
  readRow,
  readUserAuthState,
  seedFirm,
  type FirmFixture,
} from './fixtures';
import {
  inviteFirmStaff,
  listFirmStaff,
  resendStaffSetup,
  setStaffStatus,
} from '../lib/db/queries/firm';
import { inspectSetupToken } from '../lib/auth/staff-auth';
import type { FirmSession } from '../lib/auth/session';

let firm: FirmFixture;
let session: FirmSession;

/** A fresh invitee, so each test starts from an account nobody has finished. */
async function invite(): Promise<{ userId: string; setupToken: string }> {
  const invited = await inviteFirmStaff(session, {
    name: 'New Colleague',
    email: `staff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    role: 'FIRM_STAFF',
  });
  return invited;
}

// Nothing here sends mail: `inviteFirmStaff` and `resendStaffSetup` return the
// raw token and leave delivery to the action, so that a failed send cannot roll
// back the row the link points at.
beforeAll(async () => {
  firm = await seedFirm();
  session = {
    kind: 'firm',
    role: 'FIRM_ADMIN',
    userId: firm.firmAdminUserId,
    firmId: firm.firmId,
    companyIds: [],
    ip: '203.0.113.60',
    userAgent: 'vitest',
  };
});

afterAll(async () => {
  await destroyFirm(firm.firmId);
  await closeAdmin();
});

describe('suspending and reactivating staff', () => {
  it('returns a colleague who had finished setup to active', async () => {
    // seedFirm's staff user is enrolled, which is the ordinary case.
    expect(await setStaffStatus(session, firm.firmStaffUserId, 'suspended')).toBe('suspended');
    expect((await readUserAuthState(firm.firmStaffUserId)).status).toBe('suspended');

    expect(await setStaffStatus(session, firm.firmStaffUserId, 'active')).toBe('active');
    expect((await readUserAuthState(firm.firmStaffUserId)).status).toBe('active');
  });

  it('returns an invitee who never finished setup to pending, not active', async () => {
    const invited = await invite();

    expect(await setStaffStatus(session, invited.userId, 'suspended')).toBe('suspended');

    // The line that used to throw. `active` is not a state this row may hold:
    // there is no authenticator behind it, so `pending` is both what the
    // constraint permits and what the account actually is.
    expect(await setStaffStatus(session, invited.userId, 'active')).toBe('pending');

    const state = await readUserAuthState(invited.userId);
    expect(state.status).toBe('pending');
    expect(state.totpEnabledAt).toBeNull();
  });

  it('makes the invitee’s setup link work again once they are reactivated', async () => {
    const invited = await invite();

    // Suspension also shuts the setup link, since completeSetup only finishes
    // an account that is still pending. Being able to undo that is the whole
    // point of reactivating them.
    await setStaffStatus(session, invited.userId, 'suspended');
    await setStaffStatus(session, invited.userId, 'active');

    expect(await inspectSetupToken(invited.setupToken)).not.toBeNull();
  });

  it('could not have been fixed anywhere but here', async () => {
    const invited = await invite();

    // The constraint, stated directly, past RLS and past the query layer. This
    // is what the old `set({ status })` ran into, and it is why reactivation
    // cannot simply write what it was asked for: `active` is not a state this
    // row is allowed to hold, by anyone, through any code path.
    await expect(
      readRow('update users set status = $1 where id = $2 returning id', 'active', invited.userId),
    ).rejects.toThrow(/users_totp_ck/);
  });

  it('refuses to change your own status', async () => {
    await expect(setStaffStatus(session, firm.firmAdminUserId, 'suspended')).rejects.toThrow();
  });

  it('will not touch a user in another firm', async () => {
    const other = await seedFirm();
    try {
      expect(await setStaffStatus(session, other.firmStaffUserId, 'suspended')).toBeNull();
      expect((await readUserAuthState(other.firmStaffUserId)).status).toBe('active');
    } finally {
      await destroyFirm(other.firmId);
    }
  });

  it('is refused to a FIRM_STAFF session', async () => {
    const staffSession: FirmSession = { ...session, role: 'FIRM_STAFF' };
    const invited = await invite();
    await expect(setStaffStatus(staffSession, invited.userId, 'suspended')).rejects.toThrow();
  });
});

describe('resending a setup link', () => {
  it('issues a working link and kills the one it replaces', async () => {
    const invited = await invite();

    const link = await resendStaffSetup(session, invited.userId);
    expect(link).not.toBeNull();

    // One live link per person. Anyone still holding the first email finds it
    // dead, which is the correct outcome for a setup link that has been
    // sitting in an inbox.
    expect(await inspectSetupToken(invited.setupToken)).toBeNull();
    expect(await inspectSetupToken(link!.setupToken)).not.toBeNull();
  });

  it('does not re-invite somebody who already has an account', async () => {
    // An active user needs a password reset, not a fresh password-and-
    // authenticator link sent to their inbox.
    expect(await resendStaffSetup(session, firm.firmStaffUserId)).toBeNull();
  });

  it('does not re-invite somebody who is suspended', async () => {
    const invited = await invite();
    await setStaffStatus(session, invited.userId, 'suspended');

    expect(await resendStaffSetup(session, invited.userId)).toBeNull();
    // ...until the suspension is lifted, which returns them to pending.
    await setStaffStatus(session, invited.userId, 'active');
    expect(await resendStaffSetup(session, invited.userId)).not.toBeNull();
  });

  it('will not re-invite a user in another firm', async () => {
    const other = await seedFirm();
    try {
      expect(await resendStaffSetup(session, other.firmStaffUserId)).toBeNull();
    } finally {
      await destroyFirm(other.firmId);
    }
  });

  it('is refused to a FIRM_STAFF session', async () => {
    const staffSession: FirmSession = { ...session, role: 'FIRM_STAFF' };
    const invited = await invite();
    await expect(resendStaffSetup(staffSession, invited.userId)).rejects.toThrow();
  });
});

describe('the staff list', () => {
  it('shows an invitee as pending, which is what puts a resend button on the row', async () => {
    const invited = await invite();
    const row = (await listFirmStaff(session)).find((m) => m.id === invited.userId);

    expect(row?.status).toBe('pending');
    expect(row?.totpEnabledAt).toBeNull();
  });
});
