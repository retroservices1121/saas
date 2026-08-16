import LanguageSwitcher from '../_components/language-switcher';

/**
 * The shell for the invite entry screens.
 *
 * The language switcher is present here, on the verification gate, before
 * anything else is shown — spec section 12 requires it on every screen
 * "including the verify gate", and that is the screen where it matters most: a
 * worker who cannot read the question cannot answer it.
 */
export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="flex items-center justify-end border-b border-neutral-200 px-4 py-3">
        <LanguageSwitcher />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-8">{children}</main>
    </div>
  );
}
