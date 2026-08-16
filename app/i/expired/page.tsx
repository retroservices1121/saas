import { getTranslations } from 'next-intl/server';

/**
 * Unknown, expired, and already-used links all land here.
 *
 * One screen for all three deliberately. Telling someone holding a stale link
 * whether it was ever real, or whether the person it was sent to has already
 * finished, answers a question they should not be able to ask.
 */
export default async function ExpiredPage() {
  const t = await getTranslations('form.expired');

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-base leading-relaxed text-neutral-700">{t('body')}</p>
      <p className="text-base leading-relaxed text-neutral-700">{t('next')}</p>
    </div>
  );
}
