/**
 * Outbound SMS and email, in the recipient's language (spec section 12).
 *
 * The message catalogue is imported directly rather than resolved through
 * next-intl, because most of these are sent from the reminder job, which has no
 * request and therefore no negotiated locale. The language comes from the
 * subject's stored `preferred_locale`, which is the correct source anyway — a
 * worker's language preference does not change because a cron process in a
 * different timezone woke up.
 *
 * Every message here is generic by design. Spec section 11: reminder content
 * "never includes what data is missing beyond a generic prompt, since SMS is
 * not a secure channel." The link is the exception, and it is single-use,
 * time-limited, and gated.
 */
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getEmail, getSms } from './services/messaging';
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
  // "notifications.workerInvite.sms" is an incident.
  const template = resolve(CATALOGUES[locale]) ?? resolve(CATALOGUES.en);
  if (!template) throw new Error(`Missing message for key "${key}".`);

  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

export interface InviteNotification {
  phoneE164: string;
  locale: Locale;
  companyName: string;
  url: string;
}

export async function sendWorkerInvite(notification: InviteNotification): Promise<void> {
  await getSms().send({
    to: notification.phoneE164,
    locale: notification.locale,
    body: t(notification.locale, 'notifications.workerInvite.sms', {
      company: notification.companyName,
      url: notification.url,
    }),
  });
}

export async function sendOwnerInvite(notification: InviteNotification): Promise<void> {
  await getSms().send({
    to: notification.phoneE164,
    locale: notification.locale,
    body: t(notification.locale, 'notifications.ownerInvite.sms', {
      company: notification.companyName,
      url: notification.url,
    }),
  });
}

export async function sendInviteReminder(
  notification: InviteNotification & { subjectType: 'WORKER' | 'OWNER' },
): Promise<void> {
  await getSms().send({
    to: notification.phoneE164,
    locale: notification.locale,
    body: t(notification.locale, 'notifications.reminder.sms', {
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
