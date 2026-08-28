/**
 * Outbound email, in the recipient's language (spec section 12).
 *
 * The message catalogue is imported directly rather than resolved through
 * next-intl, because most of these are sent from the reminder job, which has no
 * request and therefore no negotiated locale. The language comes from the
 * subject's stored `preferred_locale`, which is the correct source anyway — a
 * worker's language preference does not change because a cron process in a
 * different timezone woke up.
 *
 * Every message here is generic by design. Spec section 11: reminder content
 * "never includes what data is missing beyond a generic prompt". The link is
 * the exception, and it is single-use, time-limited, and gated.
 *
 * There is no SMS channel. See `assertInvitableEmail` at the foot of this file
 * for what email costs and what is done about it.
 */
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getEmail } from './services/messaging';
import type { Locale } from '../i18n/request';

const CATALOGUES: Record<Locale, unknown> = { en, es };

/** Dotted-path lookup with `{name}` interpolation. */
export function t(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const resolve = (catalogue: unknown): string | undefined => {
    let node: unknown = catalogue;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  };

  // Falling back to English is better than rendering a key at someone. A
  // missing Spanish string is a translation bug; a message reading
  // "notifications.workerInvite.body" is an incident.
  const template = resolve(CATALOGUES[locale]) ?? resolve(CATALOGUES.en);
  if (!template) throw new Error(`Missing message for key "${key}".`);

  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export interface InviteNotification {
  /** The company-supplied address, already checked by `assertInvitableEmail`. */
  email: string;
  locale: Locale;
  companyName: string;
  url: string;
}

export async function sendWorkerInvite(notification: InviteNotification): Promise<void> {
  await getEmail().send({
    to: notification.email,
    locale: notification.locale,
    subject: t(notification.locale, 'notifications.workerInvite.subject', {
      company: notification.companyName,
    }),
    text: t(notification.locale, 'notifications.workerInvite.body', {
      company: notification.companyName,
      url: notification.url,
    }),
  });
}

export async function sendOwnerInvite(notification: InviteNotification): Promise<void> {
  await getEmail().send({
    to: notification.email,
    locale: notification.locale,
    subject: t(notification.locale, 'notifications.ownerInvite.subject', {
      company: notification.companyName,
    }),
    text: t(notification.locale, 'notifications.ownerInvite.body', {
      company: notification.companyName,
      url: notification.url,
    }),
  });
}

export async function sendInviteReminder(
  notification: InviteNotification & { subjectType: 'WORKER' | 'OWNER' },
): Promise<void> {
  await getEmail().send({
    to: notification.email,
    locale: notification.locale,
    subject: t(notification.locale, 'notifications.reminder.subject', {
      company: notification.companyName,
    }),
    text: t(notification.locale, 'notifications.reminder.body', {
      company: notification.companyName,
      url: notification.url,
    }),
  });
}

export async function sendStaffSetupEmail(params: {
  to: string;
  locale: Locale;
  name: string;
  companyName?: string | undefined;
  url: string;
}): Promise<void> {
  await getEmail().send({
    to: params.to,
    locale: params.locale,
    subject: t(params.locale, 'notifications.staffSetup.subject'),
    text: t(params.locale, 'notifications.staffSetup.body', {
      name: params.name,
      url: params.url,
    }),
  });
}

/**
 * Tells a company admin that one of their workers needs chasing. Names the
 * worker's display name — which the company typed — and nothing else.
 */
export async function sendNeedsAttentionEmail(params: {
  to: string;
  locale: Locale;
  displayName: string;
  url: string;
}): Promise<void> {
  await getEmail().send({
    to: params.to,
    locale: params.locale,
    subject: t(params.locale, 'notifications.needsAttention.subject'),
    text: t(params.locale, 'notifications.needsAttention.body', {
      name: params.displayName,
      url: params.url,
    }),
  });
}

// ---------------------------------------------------------------------------
// Who an invite may be sent to
// ---------------------------------------------------------------------------

export class EmployerControlledMailboxError extends Error {
  constructor(readonly domain: string) {
    super(`Refusing to send an invite to an address on the company's own domain (${domain}).`);
    this.name = 'EmployerControlledMailboxError';
  }
}

function domainOf(email: string): string {
  // `split('@').pop()` on a string with no `@` returns the whole string, which
  // would make `nonsense` its own domain and compare equal to a company contact
  // stored the same way. An address without a separator has no domain.
  const parts = email.trim().toLowerCase().split('@');
  return parts.length > 1 ? (parts.pop() ?? '') : '';
}

/**
 * Refuses an invite address on the company's own email domain.
 *
 * This is the price of moving invites from SMS to email, paid back deliberately.
 *
 * With a text message the employer types the number but does not receive on it,
 * and that asymmetry is quietly load-bearing: it is why a link they cannot read
 * can be sent to somebody they employ. Email has no such asymmetry. If the
 * company supplies `worker@thecompany.com` — an account they created, on a
 * domain they administer, in a mailbox they can read — then the invite link
 * arrives in the hands of the exact party the whole system exists to exclude.
 * They would not need to attack anything: open the mail, follow the link, and
 * because a first invite's date-of-birth gate pins on first visit, set a date of
 * their choosing and fill in the form.
 *
 * A determined admin can still register a free mailbox elsewhere, and nothing
 * short of a real second factor stops that. This catches the case that would
 * otherwise happen by default, without anybody intending it — which is the case
 * that actually occurs.
 */
export function assertInvitableEmail(inviteEmail: string, companyContactEmail: string | null): void {
  const target = domainOf(inviteEmail);
  if (!target) throw new Error('An invite needs an email address.');

  const companyDomain = companyContactEmail ? domainOf(companyContactEmail) : '';
  if (companyDomain && target === companyDomain) {
    throw new EmployerControlledMailboxError(target);
  }
}
