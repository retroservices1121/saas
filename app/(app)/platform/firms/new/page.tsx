import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import NewFirmForm from './new-firm-form';
import { requirePlatform } from '../../../../../lib/auth/current';

export const dynamic = 'force-dynamic';

export default async function NewFirmPage() {
  const [, t] = await Promise.all([requirePlatform(), getTranslations()]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/platform" className="text-sm text-neutral-600 hover:underline">
          ← {t('platform.title')}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t('platform.newFirm.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('platform.newFirm.intro')}</p>
      </div>

      <NewFirmForm />
    </div>
  );
}
