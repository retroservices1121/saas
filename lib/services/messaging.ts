/**
 * Outbound email, behind an interface (spec section 3: Resend or SES).
 *
 * SMS used to live here too. It is gone: every notification is email now, which
 * removed A2P 10DLC carrier registration from the critical path and with it the
 * longest lead time before launch. What it cost is discussed in the README —
 * with a text message the employer types the number but does not receive on it,
 * and email has no such asymmetry, so `assertInvitableEmail` refuses an address
 * on the company's own domain.
 *
 * The channel is still unauthenticated and unencrypted at rest in somebody's
 * inbox, and the spec's rule applies unchanged: reminder content "never includes
 * what data is missing beyond a generic prompt" (section 11). That is enforced
 * here rather than trusted to every call site — `assertNoSensitiveContent` runs
 * on every outbound message, including in the console provider.
 *
 * The `console` provider prints to the server log, which the redaction filter
 * has already wrapped. That is what lets the whole invite flow be exercised end
 * to end without a Resend account.
 */
import { redactString } from '../security/redaction';
import type { Locale } from '../../i18n/request';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. No HTML: a tracking pixel in an onboarding email is a disclosure. */
  text: string;
  locale: Locale;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * A last check before anything leaves the process on an insecure channel.
 *
 * Nothing should be assembling a message containing a tax ID. This exists
 * because "nothing should" and "nothing does" are different claims, and an
 * email sits in an inbox indefinitely, is synced to every device the recipient
 * owns, and passes through servers nobody here controls.
 *
 * Invite links are the deliberate exception: the token IS the message, and it
 * is single-use, time-limited, and gated on a date of birth.
 */
export function assertNoSensitiveContent(body: string): void {
  const withoutUrls = body.replace(/https?:\/\/\S+/g, '');

  // Nine or more digits in a row: a tax ID, a routing number, or an account
  // number. Checked against the raw text rather than against a
  // separator-stripped copy — stripping turns "(555) 555-0100" into a ten-digit
  // run and blocks every message that carries a support number, which is how a
  // guard like this ends up disabled.
  const longRun = /\d{9,}/.test(withoutUrls);

  // A tax ID written the way it is printed. This is the case stripping was
  // reaching for, and it is expressible directly.
  const separatedTin = /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/.test(withoutUrls);

  if (longRun || separatedTin) {
    throw new Error(
      'Refusing to send a message containing what looks like a tax ID, routing, or ' +
        'account number. Outbound email carries a generic prompt only.',
    );
  }
}

class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(message: EmailMessage): Promise<void> {
    assertNoSensitiveContent(message.text);
    console.info(
      `[email:${message.locale}] to ${message.to}\nsubject: ${message.subject}\n${redactString(
        message.text,
      )}`,
    );
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  readonly #apiKey: string;
  readonly #from: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM.');
    }
    this.#apiKey = apiKey;
    this.#from = from;
  }

  async send(message: EmailMessage): Promise<void> {
    assertNoSensitiveContent(message.text);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.#from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend rejected the message: ${response.status}`);
    }
  }
}

let emailProvider: EmailProvider | undefined;

export function getEmail(): EmailProvider {
  if (emailProvider) return emailProvider;
  emailProvider =
    (process.env.EMAIL_PROVIDER ?? 'console') === 'resend'
      ? new ResendEmailProvider()
      : new ConsoleEmailProvider();
  return emailProvider;
}

/** Test seam. */
export function __setEmailProvider(p: EmailProvider | undefined): void {
  emailProvider = p;
}
