/**
 * Global log redaction (spec section 6).
 *
 * Scrubs any 9-digit sequence, any field named tin / ssn / account / routing,
 * and any *_enc value, before the line leaves the process.
 *
 * This is a backstop, not a control. Nothing should be logging a tax ID in the
 * first place; this exists because "nothing should" and "nothing does" are
 * different claims, and the gap between them is where breaches live.
 */

const REDACTED = '[redacted]';

/** Field names whose values are replaced wholesale, at any depth. */
const SENSITIVE_KEY = /(^|[_.])(tin|ssn|itin|account|acct|routing|aba|dek|password|secret|token)([_.]|$)|_enc$|_enc[A-Z]/i;

/**
 * A bare 9-digit run, or an SSN written with separators. Deliberately broad:
 * a false positive costs a slightly less useful log line, a false negative
 * costs a tax ID in a log aggregator.
 */
const NINE_DIGITS = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b|\b\d{9,17}\b/g;

export function redactString(input: string): string {
  return input.replace(NINE_DIGITS, REDACTED);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';

  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();

  // Any binary is either ciphertext or key material. Never log its content.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.length}b]`;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  return '[unloggable]';
}

/**
 * Wraps console.{log,info,warn,error,debug} once, at process start. Call from
 * instrumentation.ts so it is in place before any request is served.
 */
export function installLogRedaction(): void {
  const target = globalThis as { __logRedactionInstalled?: boolean };
  if (target.__logRedactionInstalled) return;
  target.__logRedactionInstalled = true;

  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(...args.map((a) => redact(a)));
    };
  }
}
