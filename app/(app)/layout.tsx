import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import LanguageSwitcher from '../_components/language-switcher';
import { logoutAction } from '../_actions/auth';
import { requireStaff } from '../../lib/auth/current';

/**
 * The shell for every authenticated staff screen.
 *
 * The role is shown next to the name, not because anyone forgets their own job
 * but because the same person may hold a firm login and a company login and the
 * two see radically different things. Knowing which one you are looking at
 * before you wonder why a worker's name is missing saves a support ticket.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [{ user, session }, t] = await Promise.all([requireStaff(), getTranslations()]);

  const home =
    session.kind === 'firm' ? '/firm' : session.kind === 'company' ? '/company' : '/platform';

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href={home} className="text-sm font-semibold tracking-tight">
            {t('app.name')}
          </Link>

          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-neutral-600 sm:inline">
              {user.name} · {t(`roles.${user.role}`)}
            </span>
            <LanguageSwitcher />
            <form action={logoutAction}>
              <button
                type="submit"
                className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50"
              >
                {t('app.signOut')}
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
