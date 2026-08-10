import { getTranslations } from 'next-intl/server';

export default async function Home() {
  const t = await getTranslations('landing');

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-neutral-600">{t('subtitle')}</p>
      <p className="rounded-md bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
        {t('status')}
      </p>
    </main>
  );
}
