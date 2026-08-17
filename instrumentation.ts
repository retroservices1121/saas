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

    // Refuses to start in production while the e-signature documents are still
    // the placeholder text. A launch checklist item that lives in a document
    // gets missed; one that stops the process from booting does not.
    const { assertDocumentsApproved } = await import('./lib/esign/documents');
    assertDocumentsApproved();
  }
}
