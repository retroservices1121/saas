/**
 * The spec's last isolation test (section 5):
 *
 *   "Every JSON response from every company-scoped endpoint is scanned for the
 *    substrings `_enc`, `tin`, `routing`, `account`. None present."
 *
 * Taken literally, as a substring match over the serialized body, that check
 * fires on `operatingStates` — o-p-e-r-a-`tin`-g — and on any future field
 * whose name happens to contain one of four short English fragments. A test
 * that fails on a correct response gets suppressed, and a suppressed test
 * protects nothing.
 *
 * So the check is implemented against the intent rather than the letter: walk
 * the structure, split every key into words, and match those words. A field
 * actually named `tin_last4`, `tinType`, `routingEnc`, or `accountNumber` is
 * caught; `operatingStates` is not. Values are checked too — any binary is
 * ciphertext by definition and has no business in a response at all.
 */

import { keyMentions, keyWords } from './field-names';

export { keyWords };

/** Key words that may never appear in a company-scoped response. */
const FORBIDDEN_WORDS = new Set([
  'tin',
  'ssn',
  'itin',
  'enc',
  'routing',
  'aba',
  'account',
  'dek',
  'ciphertext',
  'totp',
  'password',
  'secret',
]);

/**
 * `accountType` and `accountLast4` are both forbidden, so `account` is listed
 * as a whole word above. These are the exceptions where the word is part of a
 * name that carries nothing sensitive.
 */
const ALLOWED_KEYS = new Set(['accountStatus', 'account_status']);

export interface ScanFinding {
  /** Dotted path to the offending node, e.g. `workers[0].tinLast4`. */
  path: string;
  reason: string;
}

export function scanForSensitiveFields(value: unknown, path = '$'): ScanFinding[] {
  const findings: ScanFinding[] = [];
  walk(value, path, findings, 0);
  return findings;
}

function walk(value: unknown, path: string, out: ScanFinding[], depth: number): void {
  if (depth > 12 || value == null) return;

  // Ciphertext, or key material. Either way it is not a response field.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    out.push({ path, reason: 'binary value (ciphertext or key material) in a response' });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, out, depth + 1));
    return;
  }

  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;

    if (!ALLOWED_KEYS.has(key)) {
      const hit = keyMentions(key, FORBIDDEN_WORDS);
      if (hit) {
        out.push({ path: childPath, reason: `field name contains "${hit}"` });
      }
    }

    walk(child, childPath, out, depth + 1);
  }
}

/**
 * Throws on the first finding. Call at the serialization boundary of any
 * company-scoped handler; the cost is one structural walk of a payload that is
 * about to be walked by JSON.stringify anyway.
 */
export function assertNoSensitiveFields(value: unknown, label = 'response'): void {
  const findings = scanForSensitiveFields(value, label);
  if (findings.length > 0) {
    const first = findings[0]!;
    throw new Error(
      `Sensitive field leaked into a company-scoped ${label}: ${first.path} — ${first.reason}. ` +
        `${findings.length} finding(s) total.`,
    );
  }
}
