import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import LanguageSwitcher from './_components/language-switcher';
import { getCurrentStaff, homePathFor } from '../lib/auth/current';

/**
 * The public root.
 *
 * It says what the product is and offers a way in for staff, and nothing else.
 * Workers and owners never arrive here — they arrive at an invite link — so
 * there is deliberately no "find my form" affordance for someone who lost their
 * text message. The only correct answer to that is a new link from the company,
 * and a self-service path to a form that collects a tax ID is a path an
 * attacker uses too.
 */
export default async function Home() {
  const current = await getCurrentStaff();
  if (current) redirect(homePathFor(current.session));

  const t = await getTranslations('landing');

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="flex items-center justify-end px-4 py-3">
        <LanguageSwitcher />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 pb-20">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-base leading-relaxed text-neutral-600">{t('subtitle')}</p>
        </div>

        <Link
          href="/login"
          className="flex min-h-[44px] items-center justify-center rounded-lg bg-neutral-900 px-4 py-2.5 text-base font-medium text-white hover:bg-neutral-800"
        >
          {t('signIn')}
        </Link>
      </main>
    </div>
  );
}
