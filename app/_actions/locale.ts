'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { LOCALE_COOKIE, isLocale } from '../../i18n/request';

/**
 * The language switcher, which the spec requires on every screen including the
 * invite verify gate (section 12).
 *
 * A cookie rather than a URL segment. The alternative — `/es/invite/...` — puts
 * the locale in the invite link, so a worker who switches language changes the
 * URL they were sent, and any link they forward or bookmark carries a choice
 * that was not theirs. It also doubles every route in the app for a two-locale
 * product.
 *
 * Not httpOnly: the choice is not a secret and a client component may want to
 * read it. It is SameSite=Lax and carries nothing but "en" or "es".
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const requested = String(formData.get('locale') ?? '');
  if (!isLocale(requested)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, requested, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === 'production',
  });

  revalidatePath('/', 'layout');
}
