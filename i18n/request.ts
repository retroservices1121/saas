import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'en' || value === 'es';
}

/**
 * Locale resolution order (spec section 12): Accept-Language first, then
 * overridden by the subject's stored preferred_locale once a session exists.
 * The override happens at the layout that owns the session, not here — this
 * function only sees the request.
 */
export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split('=')[1]) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag.startsWith('es')) return 'es';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

/** Set by the header switcher, which is present on every screen (spec section 12). */
export const LOCALE_COOKIE = 'onb_locale';

/**
 * Resolution order (spec section 12): the explicit choice, then
 * Accept-Language, then English.
 *
 * A subject's stored `preferred_locale` overrides both, but not here — that
 * override belongs to the layout that owns the invite session, because this
 * function has only the request and does not know who is on the other end of
 * it yet.
 */
export default getRequestConfig(async () => {
  const [h, c] = await Promise.all([headers(), cookies()]);

  const chosen = c.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(chosen) ? chosen : negotiateLocale(h.get('accept-language'));

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
