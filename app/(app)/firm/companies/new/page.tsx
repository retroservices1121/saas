import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import NewCompanyForm from './new-company-form';
import { requireFirmAdmin } from '../../../../../lib/auth/current';

export const dynamic = 'force-dynamic';

export default async function NewCompanyPage() {
  const [, t] = await Promise.all([requireFirmAdmin(), getTranslations()]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/firm" className="text-sm text-neutral-600 hover:underline">
          ← {t('firm.companies.title')}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t('firm.new.title')}</h1>
      </div>

      <NewCompanyForm />
    </div>
  );
}
