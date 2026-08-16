import { getTranslations } from 'next-intl/server';

/**
 * Five consecutive wrong dates of birth (spec section 7.5).
 *
 * The screen does not say how many attempts remain or which part was wrong, and
 * the alert this triggered went to the accounting firm rather than to the
 * company — telling the company would tell the party most likely to be holding
 * a link that is not theirs that they have been noticed.
 */
export default async function LockedPage() {
  const t = await getTranslations('form.locked');

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-base leading-relaxed text-neutral-700">{t('body')}</p>
    </div>
  );
}
