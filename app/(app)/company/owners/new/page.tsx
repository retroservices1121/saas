import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import InviteOwnerForm from './invite-owner-form';
import { requireCompanyAdmin } from '../../../../../lib/auth/current';

export const dynamic = 'force-dynamic';

export default async function InviteOwnerPage() {
  const [, t] = await Promise.all([requireCompanyAdmin(), getTranslations()]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/company/owners" className="text-sm text-neutral-600 hover:underline">
          ← {t('company.owners.back')}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t('company.inviteOwner.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('company.inviteOwner.intro')}</p>
      </div>

      <InviteOwnerForm />
    </div>
  );
}
