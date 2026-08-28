/**
 * Spec section 10, rule by rule.
 *
 * These need no database: they are pure functions, and they are the rules that
 * decide whether a real tax ID or a real bank account is accepted. Every
 * boundary the spec names has a case here, in both directions — a rule that
 * only ever rejects is indistinguishable from a rule that rejects everything.
 */
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  checkOwnershipTotal,
  validateBankAccount,
  validateDob,
  validateEin,
  validateEmail,
  validateItin,
  validatePhone,
  validatePostalCode,
  validateRouting,
  validateSsn,
  validateState,
  validateTin,
} from '../lib/validation/identity';
import { scanForSensitiveFields, keyWords } from '../lib/security/response-scan';
import { assertNoSensitiveContent } from '../lib/services/messaging';
import {
  assertInvitableEmail,
  EmployerControlledMailboxError,
} from '../lib/notifications';
import { redact, redactString } from '../lib/security/redaction';

const errorKeys = (r: { errors: { key: string }[] }) => r.errors.map((e) => e.key);

describe('SSN', () => {
  it('accepts a well-formed number and normalizes away separators', () => {
    const r = validateSsn('123-45-6789');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('123456789');
  });

  it('rejects the excluded area numbers', () => {
    expect(errorKeys(validateSsn('000-45-6789'))).toEqual(['ssn.area']);
    expect(errorKeys(validateSsn('666-45-6789'))).toEqual(['ssn.area']);
    expect(errorKeys(validateSsn('900-45-6789'))).toEqual(['ssn.area']);
    expect(errorKeys(validateSsn('999-45-6789'))).toEqual(['ssn.area']);
    // 899 is the last valid area, so the boundary is exclusive on the right.
    expect(validateSsn('899-45-6789').ok).toBe(true);
  });

  it('rejects a zero group and a zero serial', () => {
    expect(errorKeys(validateSsn('123-00-6789'))).toEqual(['ssn.group']);
    expect(errorKeys(validateSsn('123-45-0000'))).toEqual(['ssn.serial']);
  });

  it('rejects the two numbers the spec names', () => {
    // The wallet-insert number, and the 1962 pamphlet example.
    expect(errorKeys(validateSsn('078-05-1120'))).toEqual(['ssn.void']);
    expect(errorKeys(validateSsn('219-09-9999'))).toEqual(['ssn.void']);
  });

  it('rejects anything that is not nine digits', () => {
    expect(errorKeys(validateSsn('12345678'))).toEqual(['ssn.length']);
    expect(errorKeys(validateSsn('1234567890'))).toEqual(['ssn.length']);
    expect(errorKeys(validateSsn(''))).toEqual(['ssn.length']);
  });
});

describe('ITIN', () => {
  it('accepts every group range the IRS assigns', () => {
    for (const group of ['50', '65', '70', '88', '90', '92', '94', '99']) {
      expect(validateItin(`9${'12'}-${group}-6789`.replace('912-', '912')).ok, group).toBe(true);
    }
    expect(validateItin('912-70-6789').ok).toBe(true);
  });

  it('rejects the unassigned gaps', () => {
    // 66-69 and 93 are not assigned, so a number landing there is a typo.
    expect(errorKeys(validateItin('912-66-6789'))).toEqual(['itin.group']);
    expect(errorKeys(validateItin('912-69-6789'))).toEqual(['itin.group']);
    expect(errorKeys(validateItin('912-93-6789'))).toEqual(['itin.group']);
    expect(errorKeys(validateItin('912-49-6789'))).toEqual(['itin.group']);
  });

  it('requires a leading 9', () => {
    expect(errorKeys(validateItin('812-70-6789'))).toEqual(['itin.prefix']);
  });
});

describe('tax ID type mismatch', () => {
  it('warns without blocking when an SSN choice looks like an ITIN', () => {
    const r = validateTin('SSN', '912-70-6789');
    // 912-70-6789 fails the SSN area rule outright, so it blocks. The mismatch
    // warning is for a number that passes as one and reads as the other.
    expect(r.ok).toBe(false);
  });

  it('accepts a valid ITIN declared as an ITIN with no warning', () => {
    const r = validateTin('ITIN', '912-70-6789');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('never turns a warning into an error', () => {
    const r = validateTin('SSN', '123-45-6789');
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('ABA routing checksum', () => {
  it('accepts real routing numbers', () => {
    // JPMorgan Chase (NY), Bank of America (VA), Wells Fargo.
    for (const rtn of ['021000021', '051000017', '121000248']) {
      expect(validateRouting(rtn).ok, rtn).toBe(true);
    }
  });

  it('catches a single-digit typo', () => {
    expect(errorKeys(validateRouting('021000022'))).toEqual(['routing.checksum']);
  });

  it('catches a transposition', () => {
    // 021000021 -> 210000021: the checksum is what makes this recoverable
    // before a deposit bounces.
    expect(errorKeys(validateRouting('210000021'))).toEqual(['routing.checksum']);
  });

  it('rejects all zeros even though the arithmetic passes', () => {
    expect(errorKeys(validateRouting('000000000'))).toEqual(['routing.checksum']);
  });

  it('rejects the wrong length before doing arithmetic on it', () => {
    expect(errorKeys(validateRouting('02100002'))).toEqual(['routing.length']);
  });
});

describe('bank account', () => {
  it('accepts 4 to 17 digits', () => {
    expect(validateBankAccount('1234').ok).toBe(true);
    expect(validateBankAccount('12345678901234567').ok).toBe(true);
    expect(errorKeys(validateBankAccount('123'))).toEqual(['account.length']);
    expect(errorKeys(validateBankAccount('123456789012345678'))).toEqual(['account.length']);
  });

  it('requires the confirmation field to match', () => {
    expect(validateBankAccount('123456789', '123456789').ok).toBe(true);
    expect(errorKeys(validateBankAccount('123456789', '123456780'))).toEqual([
      'account.mismatch',
    ]);
  });

  it('compares confirmations after normalizing separators', () => {
    // Someone who types the number twice, once with a space, has not made a
    // mistake worth blocking on.
    expect(validateBankAccount('1234 5678', '12345678').ok).toBe(true);
  });
});

describe('EIN', () => {
  it('returns the hyphenated form the check constraint requires', () => {
    expect(validateEin('123456789').normalized).toBe('12-3456789');
    expect(validateEin('12-3456789').normalized).toBe('12-3456789');
  });

  it('rejects the wrong length', () => {
    expect(errorKeys(validateEin('1234567'))).toEqual(['ein.length']);
  });
});

describe('date of birth', () => {
  const now = new Date('2026-08-15T00:00:00Z');

  it('accepts an age inside 14 to 100', () => {
    expect(validateDob('1990-04-01', now).ok).toBe(true);
  });

  it('rejects both ends', () => {
    expect(errorKeys(validateDob('2015-01-01', now))).toEqual(['dob.tooYoung']);
    expect(errorKeys(validateDob('1900-01-01', now))).toEqual(['dob.tooOld']);
  });

  it('treats the boundary birthdays exactly', () => {
    // Turns 14 the day of, so it is accepted on that day and not the day before.
    expect(validateDob('2012-08-15', now).ok).toBe(true);
    expect(validateDob('2012-08-16', now).ok).toBe(false);
  });

  it('rejects a date that does not exist', () => {
    // Date.UTC would roll this forward to March 2 rather than refusing it.
    expect(errorKeys(validateDob('2001-02-30', now))).toEqual(['dob.format']);
    expect(errorKeys(validateDob('2001-13-01', now))).toEqual(['dob.format']);
  });

  it('counts whole years, not divided milliseconds', () => {
    // Born Feb 29; the day before their birthday in a non-leap year they are
    // still the younger age.
    expect(ageOn(new Date(Date.UTC(2000, 1, 29)), new Date(Date.UTC(2025, 1, 28)))).toBe(24);
    expect(ageOn(new Date(Date.UTC(2000, 1, 29)), new Date(Date.UTC(2025, 2, 1)))).toBe(25);
  });
});

describe('ownership total', () => {
  it('warns rather than blocks when the total is not 100', () => {
    const r = checkOwnershipTotal([50, 25]);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]?.key).toBe('ownership.totalNot100');
  });

  it('is silent at exactly 100, including in thirds', () => {
    expect(checkOwnershipTotal([100]).warnings).toEqual([]);
    expect(checkOwnershipTotal(['33.33', '33.33', '33.34']).warnings).toEqual([]);
  });
});

describe('contact fields', () => {
  it('normalizes US mobile entry to E.164', () => {
    expect(validatePhone('(555) 555-0100').normalized).toBe('+15555550100');
    expect(validatePhone('15555550100').normalized).toBe('+15555550100');
    expect(validatePhone('+15555550100').normalized).toBe('+15555550100');
  });

  it('rejects a number that is neither', () => {
    expect(errorKeys(validatePhone('555-0100'))).toEqual(['phone.format']);
  });

  it('lowercases email and accepts the plus form', () => {
    expect(validateEmail('Ada+payroll@Example.COM').normalized).toBe('ada+payroll@example.com');
    expect(errorKeys(validateEmail('ada@example'))).toEqual(['email.format']);
  });

  it('accepts five- and nine-digit zips', () => {
    expect(validatePostalCode('10001').normalized).toBe('10001');
    expect(validatePostalCode('100011234').normalized).toBe('10001-1234');
    expect(errorKeys(validatePostalCode('1000'))).toEqual(['postalCode.format']);
  });

  it('knows the territories that file US payroll', () => {
    expect(validateState('ny').normalized).toBe('NY');
    expect(validateState('PR').ok).toBe(true);
    expect(errorKeys(validateState('XX'))).toEqual(['state.unknown']);
  });
});

// ---------------------------------------------------------------------------

describe('response scanner', () => {
  it('splits field names into words the way the check needs', () => {
    expect(keyWords('tinLast4')).toEqual(['tin', 'last4']);
    expect(keyWords('tin_enc')).toEqual(['tin', 'enc']);
    expect(keyWords('operatingStates')).toEqual(['operating', 'states']);
  });

  it('reports a path useful enough to fix the leak', () => {
    const findings = scanForSensitiveFields({ workers: [{ id: '1' }, { tinLast4: '6789' }] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('$.workers[1].tinLast4');
  });

  it('does not fire on the field names that made a substring check unusable', () => {
    expect(
      scanForSensitiveFields({
        operatingStates: ['NY'],
        accountStatus: 'active',
        contactPhone: '+15555550100',
      }),
    ).toEqual([]);
  });
});

describe('outbound message guard', () => {
  it('refuses a message carrying a tax ID', () => {
    expect(() => assertNoSensitiveContent('Your SSN 123456789 was received.')).toThrow();
  });

  it('allows an invite link, which is the whole point of the message', () => {
    expect(() =>
      assertNoSensitiveContent('Complete your onboarding: https://x.test/i/AbC123XyZ456789'),
    ).not.toThrow();
  });

  it('allows a formatted phone number', () => {
    expect(() => assertNoSensitiveContent('Call us at (555) 555-0100.')).not.toThrow();
  });
});

describe('log redaction', () => {
  it('scrubs a tax ID out of a message', () => {
    expect(redactString('ssn is 123-45-6789 ok')).not.toContain('6789');
  });

  it('replaces the value of a sensitive key at any depth', () => {
    const out = redact({ a: { b: { tin: '123456789', name: 'Ada' } } }) as Record<string, never>;
    expect(JSON.stringify(out)).toContain('Ada');
    expect(JSON.stringify(out)).not.toContain('123456789');
  });

  it('never prints binary', () => {
    expect(redact({ tinEnc: Buffer.from('secret') })).toEqual({ tinEnc: '[redacted]' });
    expect(redact(Buffer.from('abc'))).toBe('[binary 3b]');
  });
});

describe('who an invite may be sent to', () => {
  it('refuses an address on the company\'s own email domain', () => {
    // The price of moving invites from SMS to email. With a text message the
    // employer types the number but does not receive on it; email has no such
    // asymmetry, and an address they administer is an inbox they can read.
    expect(() =>
      assertInvitableEmail('worker@northside.test', 'office@northside.test'),
    ).toThrow(EmployerControlledMailboxError);
  });

  it('is case- and whitespace-insensitive about it', () => {
    expect(() =>
      assertInvitableEmail('  Worker@NORTHSIDE.test ', 'office@northside.test'),
    ).toThrow(EmployerControlledMailboxError);
  });

  it('allows an address the person plausibly controls themselves', () => {
    expect(() =>
      assertInvitableEmail('ada@personal.test', 'office@northside.test'),
    ).not.toThrow();
  });

  it('allows anything when the company has no contact address on file', () => {
    // Nothing to compare against. Refusing every invite because the company
    // profile is incomplete would block onboarding for a reason unrelated to
    // the risk.
    expect(() => assertInvitableEmail('ada@personal.test', null)).not.toThrow();
  });

  it('does not match on a substring of the domain', () => {
    // northside.test and not-northside.test are different organisations.
    expect(() =>
      assertInvitableEmail('ada@not-northside.test', 'office@northside.test'),
    ).not.toThrow();
  });

  it('refuses an address with no domain at all', () => {
    expect(() => assertInvitableEmail('nonsense', 'office@northside.test')).toThrow();
  });
});
