import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import InviteWorkerForm from './invite-worker-form';
import { requireCompany } from '../../../../../lib/auth/current';

export const dynamic = 'force-dynamic';

export default async function InviteWorkerPage() {
  const [, t] = await Promise.all([requireCompany(), getTranslations()]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/company/workers" className="text-sm text-neutral-600 hover:underline">
          ← {t('company.workers.title', { count: '' })}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t('company.inviteWorker.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          {t('company.inviteWorker.intro')}
        </p>
      </div>

      <InviteWorkerForm />
    </div>
  );
}
