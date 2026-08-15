import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import LoginForm from './login-form';
import { getCurrentStaff, homePathFor } from '../../../lib/auth/current';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await getCurrentStaff();
  if (current) redirect(homePathFor(current.session));

  const [t, params] = await Promise.all([getTranslations('auth'), searchParams]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('signInTitle')}</h1>
        <p className="text-sm text-neutral-600">{t('signInSubtitle')}</p>
      </div>
      <LoginForm setupComplete={params.setup === 'complete'} />
    </div>
  );
}
