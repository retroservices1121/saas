/**
 * Runs once per server process, before any request is handled. Installing the
 * log redaction filter here — rather than at the first import that happens to
 * need it — is what makes "before the line leaves the process" true for
 * startup errors and framework logs as well as our own.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLogRedaction } = await import('./lib/security/redaction');
    installLogRedaction();
  }
}
