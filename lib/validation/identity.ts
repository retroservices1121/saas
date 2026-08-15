/**
 * Field validation, spec section 10.
 *
 * Every rule here is shared verbatim between the client and the server. The
 * client copy exists to give the person filling in the form an answer before
 * they lose their place; the server copy is the one that decides. Neither is
 * allowed to drift, which is why there is one module and not two.
 *
 * Two kinds of outcome, and the difference is deliberate:
 *
 *   errors   block submission. A routing number that fails its checksum is
 *            wrong, and letting it through means a deposit bounces weeks later
 *            with no way to trace which digit was mistyped.
 *
 *   warnings do not. "This looks like an ITIN but you chose SSN" is a question,
 *            not a verdict — the person filling in the form knows which one
 *            they hold, and a hard block on a heuristic strands anyone whose
 *            situation the heuristic did not anticipate.
 *
 * The message keys are i18n keys, not English. Every tax-ID validation error
 * requires human translation (spec section 12), so none of them can be built
 * by string concatenation at the call site.
 */

export interface FieldIssue {
  /** i18n key under `validation.` in messages/*.json. */
  key: string;
  /** Interpolation values for the message, if it takes any. */
  values?: Record<string, string | number> | undefined;
}

export interface FieldResult {
  ok: boolean;
  errors: FieldIssue[];
  warnings: FieldIssue[];
  /** The value in canonical storage form — digits only, no separators. */
  normalized?: string | undefined;
}

const ok = (normalized?: string): FieldResult => ({
  ok: true,
  errors: [],
  warnings: [],
  normalized,
});

const fail = (key: string, values?: Record<string, string | number>): FieldResult => ({
  ok: false,
  errors: [{ key, values }],
  warnings: [],
});

/** Strips every non-digit. Separators are a display concern, never a stored one. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

/**
 * Two literal numbers are rejected by name in the spec, and both have a story.
 *
 * 078-05-1120 belonged to Hilda Schrader Whitcher, secretary to a wallet
 * manufacturer's vice-president, whose number was printed on a specimen card
 * tucked into every wallet the company sold in 1938. Around 40,000 people
 * subsequently filed it as their own.
 *
 * 219-09-9999 appeared in a 1962 pamphlet as an example and was likewise
 * adopted by readers who took the example literally.
 *
 * Both are permanently void, and both still turn up on forms.
 */
const VOID_SSNS = new Set(['078051120', '219099999']);

export function validateSsn(input: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length !== 9) return fail('ssn.length');

  const area = d.slice(0, 3);
  const group = d.slice(3, 5);
  const serial = d.slice(5);

  // 000 was never issued; 666 was skipped; 900-999 is the ITIN and ATIN range.
  if (area === '000' || area === '666' || Number(area) >= 900) return fail('ssn.area');
  if (group === '00') return fail('ssn.group');
  if (serial === '0000') return fail('ssn.serial');
  if (VOID_SSNS.has(d)) return fail('ssn.void');

  return ok(d);
}

// ---------------------------------------------------------------------------
// ITIN
// ---------------------------------------------------------------------------

/**
 * The IRS assigns ITINs from 9xx-GG-xxxx with GG drawn from a fixed set of
 * ranges. The gaps are not arbitrary — 93 and the 66-69 band are unassigned —
 * so a number landing in one is a typo or a fabrication, not an ITIN.
 */
const ITIN_GROUP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [50, 65],
  [70, 88],
  [90, 92],
  [94, 99],
];

function inItinGroupRange(group: number): boolean {
  return ITIN_GROUP_RANGES.some(([lo, hi]) => group >= lo && group <= hi);
}

export function validateItin(input: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length !== 9) return fail('itin.length');
  if (!d.startsWith('9')) return fail('itin.prefix');

  const group = Number(d.slice(3, 5));
  if (!inItinGroupRange(group)) return fail('itin.group');

  return ok(d);
}

// ---------------------------------------------------------------------------
// Tax ID, with the soft type-mismatch check
// ---------------------------------------------------------------------------

export type TinType = 'SSN' | 'ITIN';

/**
 * Validates against the declared type, then asks — without blocking — whether
 * the number looks like the other one.
 *
 * A number in the 9xx range with a valid ITIN group cannot be an SSN, so
 * declaring SSN is either a mis-tap on the previous screen or a
 * misunderstanding of which document they are holding. Both are worth a
 * question. Neither is worth refusing the form: the spec is explicit that this
 * is a soft warning, and someone who is certain should be able to proceed.
 */
export function validateTin(type: TinType, input: string): FieldResult {
  const result = type === 'SSN' ? validateSsn(input) : validateItin(input);
  if (!result.ok) return result;

  const d = result.normalized!;

  if (type === 'SSN' && d.startsWith('9') && inItinGroupRange(Number(d.slice(3, 5)))) {
    return { ...result, warnings: [{ key: 'tin.looksLikeItin' }] };
  }
  if (type === 'ITIN' && !d.startsWith('9')) {
    // Unreachable through validateItin, which already rejects this. Kept so the
    // check still holds if that function is ever relaxed.
    return { ...result, warnings: [{ key: 'tin.looksLikeSsn' }] };
  }

  return result;
}

// ---------------------------------------------------------------------------
// ABA routing number
// ---------------------------------------------------------------------------

/**
 * The ABA check digit, weights 3-7-1 repeating:
 *
 *   3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)
 *
 * Hard block on failure. This is the single highest-value validation in the
 * system: it catches most single-digit typos and every adjacent transposition
 * of unequal digits, and it catches them now rather than in three weeks when a
 * payroll deposit bounces and nobody can say which digit moved.
 */
export function validateRouting(input: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length !== 9) return fail('routing.length');

  const n = [...d].map(Number) as number[];
  const sum =
    3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!);

  if (sum % 10 !== 0) return fail('routing.checksum');
  // 000000000 passes the checksum arithmetic and is not a bank.
  if (d === '000000000') return fail('routing.checksum');

  return ok(d);
}

// ---------------------------------------------------------------------------
// Bank account
// ---------------------------------------------------------------------------

export function validateBankAccount(input: string, confirmation?: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length < 4 || d.length > 17) return fail('account.length');

  if (confirmation !== undefined && d !== digitsOnly(confirmation)) {
    return fail('account.mismatch');
  }

  return ok(d);
}

// ---------------------------------------------------------------------------
// EIN
// ---------------------------------------------------------------------------

/**
 * Returned in display form `00-0000000`, not digits-only, because that is what
 * the `companies_ein_ck` constraint requires and what every IRS document shows.
 * An EIN is a business identifier, not a secret, so unlike a TIN it is stored
 * exactly as it is read.
 */
export function validateEin(input: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length !== 9) return fail('ein.length');
  return ok(`${d.slice(0, 2)}-${d.slice(2)}`);
}

// ---------------------------------------------------------------------------
// Date of birth
// ---------------------------------------------------------------------------

const MIN_AGE = 14;
const MAX_AGE = 100;

/** Whole years elapsed, not a division — leap years make the division wrong. */
export function ageOn(dob: Date, on: Date): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = on.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * `input` is an ISO date, `YYYY-MM-DD`. The worker form collects it as three
 * numeric selects (spec section 8, screen 0) rather than a native date picker,
 * which on older Android reliably produces a date nobody intended.
 */
export function validateDob(input: string, now = new Date()): FieldResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return fail('dob.format');

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: Date.UTC rolls 2025-02-30 forward to March 2 rather than
  // rejecting it, so a plausible-looking impossible date would otherwise pass.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return fail('dob.format');
  }

  const age = ageOn(parsed, now);
  if (age < MIN_AGE) return fail('dob.tooYoung', { min: MIN_AGE });
  if (age > MAX_AGE) return fail('dob.tooOld', { max: MAX_AGE });

  return ok(`${y}-${m}-${d}`);
}

// ---------------------------------------------------------------------------
// Ownership percentages
// ---------------------------------------------------------------------------

/**
 * Warn, never block. Ownership that does not total 100 is usually an omitted
 * owner, but it is legitimately fractional in plenty of structures, and the
 * company admin is better placed to know which than this function is.
 */
export function checkOwnershipTotal(percents: Array<number | string | null>): FieldResult {
  const total = percents.reduce<number>((sum, p) => sum + (p == null ? 0 : Number(p)), 0);
  const rounded = Math.round(total * 100) / 100;

  if (rounded === 100) return ok();
  return {
    ok: true,
    errors: [],
    warnings: [{ key: 'ownership.totalNot100', values: { total: rounded } }],
  };
}

// ---------------------------------------------------------------------------
// Contact fields
// ---------------------------------------------------------------------------

/**
 * E.164, normalized from what a US mobile keypad produces. A bare 10-digit
 * entry is assumed to be +1: this platform is US-only (state tax and workers'
 * comp rules are the whole reason `operating_states` exists), and asking every
 * worker to type a country code costs more than it buys.
 */
export function validatePhone(input: string): FieldResult {
  const trimmed = input.trim();
  const d = digitsOnly(trimmed);

  if (trimmed.startsWith('+')) {
    if (d.length < 8 || d.length > 15) return fail('phone.format');
    return ok(`+${d}`);
  }
  if (d.length === 10) return ok(`+1${d}`);
  if (d.length === 11 && d.startsWith('1')) return ok(`+${d}`);

  return fail('phone.format');
}

export function validateEmail(input: string): FieldResult {
  const trimmed = input.trim();
  // Deliberately permissive. The authoritative test of an address is whether
  // mail to it arrives; a stricter pattern only rejects valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return fail('email.format');
  return ok(trimmed.toLowerCase());
}

export function validatePostalCode(input: string): FieldResult {
  const d = digitsOnly(input);
  if (d.length !== 5 && d.length !== 9) return fail('postalCode.format');
  return ok(d.length === 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`);
}

/** USPS two-letter codes, plus DC and the territories that file US payroll. */
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA', 'WV', 'WI', 'WY',
] as const;

export type UsState = (typeof US_STATES)[number];

export function isUsState(value: string): value is UsState {
  return (US_STATES as readonly string[]).includes(value);
}

export function validateState(input: string): FieldResult {
  const upper = input.trim().toUpperCase();
  if (!isUsState(upper)) return fail('state.unknown');
  return ok(upper);
}
