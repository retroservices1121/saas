import { getLocale, getTranslations } from 'next-intl/server';
import { setLocaleAction } from '../_actions/locale';

/**
 * Present on every screen, including the invite verify gate (spec section 12).
 *
 * Two buttons rather than a <select>, because a select on a phone opens a
 * native picker that hides the page, and because with exactly two languages a
 * picker is one more interaction than the choice needs.
 *
 * It is a form, so it works before hydration. A worker on a slow connection
 * reading a screen in a language they do not speak should not have to wait for
 * JavaScript to change it.
 */
export default async function LanguageSwitcher({ className = '' }: { className?: string }) {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('app')]);

  const options = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Español' },
  ] as const;

  return (
    <form action={setLocaleAction} className={`flex items-center gap-1 ${className}`}>
      <span className="sr-only">{t('languageSwitcher')}</span>
      {options.map((option) => {
        const active = locale === option.code;
        return (
          <button
            key={option.code}
            type="submit"
            name="locale"
            value={option.code}
            aria-current={active ? 'true' : undefined}
            lang={option.code}
            className={`min-h-[36px] rounded-md px-2.5 py-1 text-sm font-medium transition ${
              active
                ? 'bg-neutral-900 text-white'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </form>
  );
}
