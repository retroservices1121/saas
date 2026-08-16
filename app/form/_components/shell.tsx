import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import LanguageSwitcher from '../../_components/language-switcher';
import { previousStep, progressFor, type StepId, type SubjectKind } from '../../../lib/forms/wizard';

/**
 * The frame every form screen sits in.
 *
 * Three things are on it because the spec asks for them on every screen: a back
 * button, a language switcher, and an honest progress indicator. The back
 * button is a link rather than `history.back()` so it works on the first paint
 * and after a redirect, both of which happen constantly in a server-driven
 * flow.
 */
export default async function StepShell({
  kind,
  step,
  title,
  hint,
  children,
}: {
  kind: SubjectKind;
  step: StepId;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations();
  const progress = progressFor(kind, step);
  const back = previousStep(kind, step);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-2 px-4 py-2.5">
          {back && step !== 'done' ? (
            <Link
              href={`/form/${back}`}
              className="-ml-2 flex min-h-[44px] items-center rounded-md px-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
            >
              ← {t('app.back')}
            </Link>
          ) : (
            <span />
          )}
          <LanguageSwitcher />
        </div>

        {progress.total > 0 && step !== 'done' ? (
          <div className="mx-auto w-full max-w-md px-4 pb-2.5">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200"
              role="progressbar"
              aria-valuenow={progress.current}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-label={t('app.step', {
                current: progress.current,
                total: progress.total,
              })}
            >
              <div
                className="h-full rounded-full bg-neutral-900 transition-all"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs text-neutral-500">
              {t('app.step', { current: progress.current, total: progress.total })}
            </p>
          </div>
        ) : null}
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-7">
        <div className="flex flex-col gap-2">
          {/* Large, because this is the one question on the screen. */}
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
          {hint ? (
            <p className="text-base leading-relaxed text-neutral-600">{hint}</p>
          ) : null}
        </div>
        {children}
      </main>
    </div>
  );
}
