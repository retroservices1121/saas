/**
 * SMS and email, behind interfaces (spec section 3: Twilio, Resend or SES).
 *
 * Both channels are unauthenticated and unencrypted in transit to the handset
 * or the inbox, and the spec treats them that way: reminder content "never
 * includes what data is missing beyond a generic prompt, since SMS is not a
 * secure channel" (section 11). That rule is enforced here rather than trusted
 * to every call site — `assertNoSensitiveContent` runs on every outbound
 * message, in both providers, including the console one.
 *
 * The `console` providers print to the server log, which the redaction filter
 * has already wrapped. That is what lets the whole invite flow be exercised
 * end to end without a Twilio account.
 */
import { redactString } from '../security/redaction';
import type { Locale } from '../../i18n/request';

export interface SmsMessage {
  to: string;
  body: string;
  locale: Locale;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. No HTML: a tracking pixel in an onboarding email is a disclosure. */
  text: string;
  locale: Locale;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<void>;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * A last check before anything leaves the process on an insecure channel.
 *
 * Nothing should be assembling a message containing a tax ID. This exists
 * because "nothing should" and "nothing does" are different claims, and an SMS
 * is delivered to a lock screen, a synced tablet, and a carrier's logs.
 *
 * Invite links are the deliberate exception: the token IS the message, and it
 * is single-use, time-limited, and gated on a date of birth the recipient's
 * employer does not hold.
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
        'account number. Outbound SMS and email carry a generic prompt only.',
    );
  }
}

class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  async send(message: SmsMessage): Promise<void> {
    assertNoSensitiveContent(message.body);
    console.info(`[sms:${message.locale}] to ${message.to}\n${redactString(message.body)}`);
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

class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  readonly #sid: string;
  readonly #token: string;
  readonly #from: string;

  constructor() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) {
      throw new Error(
        'SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and ' +
          'TWILIO_FROM_NUMBER.',
      );
    }
    this.#sid = sid;
    this.#token = token;
    this.#from = from;
  }

  async send(message: SmsMessage): Promise<void> {
    assertNoSensitiveContent(message.body);

    // Twilio's REST API over fetch, rather than the SDK: one form-encoded POST
    // does not justify a dependency, and the SDK's retry behaviour would need
    // configuring away regardless — a retried invite SMS is a second live link.
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.#sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.#sid}:${this.#token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to,
          From: this.#from,
          Body: message.body,
        }),
      },
    );

    if (!response.ok) {
      // The body can echo the message back. Report the status only.
      throw new Error(`Twilio rejected the message: ${response.status}`);
    }
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

let smsProvider: SmsProvider | undefined;
let emailProvider: EmailProvider | undefined;

export function getSms(): SmsProvider {
  if (smsProvider) return smsProvider;
  smsProvider =
    (process.env.SMS_PROVIDER ?? 'console') === 'twilio'
      ? new TwilioSmsProvider()
      : new ConsoleSmsProvider();
  return smsProvider;
}

export function getEmail(): EmailProvider {
  if (emailProvider) return emailProvider;
  emailProvider =
    (process.env.EMAIL_PROVIDER ?? 'console') === 'resend'
      ? new ResendEmailProvider()
      : new ConsoleEmailProvider();
  return emailProvider;
}

/** Test seams. */
export function __setSmsProvider(p: SmsProvider | undefined): void {
  smsProvider = p;
}
export function __setEmailProvider(p: EmailProvider | undefined): void {
  emailProvider = p;
}
