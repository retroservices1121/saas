import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';

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

export default getRequestConfig(async () => {
  const h = await headers();
  const cookieLocale = h.get('x-locale');
  const locale = isLocale(cookieLocale)
    ? cookieLocale
    : negotiateLocale(h.get('accept-language'));

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
