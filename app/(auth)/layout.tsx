import LanguageSwitcher from '../_components/language-switcher';

/**
 * The shell for every unauthenticated staff screen. Deliberately says nothing
 * about the platform beyond its name — a login page that names the accounting
 * firm and its client companies is a reconnaissance page.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <header className="flex items-center justify-end px-4 py-3">
        <LanguageSwitcher />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-16">
        {children}
      </main>
    </div>
  );
}
