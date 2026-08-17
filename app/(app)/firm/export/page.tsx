import { getTranslations } from 'next-intl/server';
import ExportForm from './export-form';
import { requireFirmAdmin } from '../../../../lib/auth/current';
import { listCompaniesForFirm } from '../../../../lib/db/queries/firm';

export const dynamic = 'force-dynamic';

export default async function ExportPage() {
  const [{ session }, t] = await Promise.all([requireFirmAdmin(), getTranslations()]);
  const companies = await listCompaniesForFirm(session);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('firm.export.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('firm.export.intro')}</p>
      </div>

      <ExportForm
        companies={companies.map((company) => ({
          id: company.id,
          legalName: company.legalName,
        }))}
      />
    </div>
  );
}
