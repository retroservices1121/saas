import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import VerifyForm from './verify-form';
import { getSessionToken } from '../../../../lib/auth/current';

export default async function VerifyPage() {
  // The pending session token is the only thing that makes this page
  // meaningful. Without it there is nothing to verify against, and rendering
  // the form anyway would invite someone to type a colleague's code into it.
  const token = await getSessionToken();
  if (!token) redirect('/login');

  const t = await getTranslations('auth');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('verifyTitle')}</h1>
        <p className="text-sm text-neutral-600">{t('verifySubtitle')}</p>
      </div>
      <VerifyForm />
    </div>
  );
}
