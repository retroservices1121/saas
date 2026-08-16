import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../lib/auth/current';
import { listCompaniesForFirm } from '../../../lib/db/queries/firm';
import { StatusChip } from '../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * The firm's client list.
 *
 * Dense on purpose: this is the screen a firm admin lives in, and forty rows
 * they can scan beats eight they have to scroll past. The counts are what makes
 * it useful — "3 of 12 workers outstanding" is the question they open this page
 * to answer.
 */
export default async function FirmDashboard() {
  const [{ session }, t] = await Promise.all([requireFirm(), getTranslations()]);
  const companies = await listCompaniesForFirm(session);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('firm.companies.title')}</h1>
          <p className="mt-0.5 text-sm text-neutral-600">
            {t('firm.companies.count', { count: companies.length })}
          </p>
        </div>

        {session.role === 'FIRM_ADMIN' ? (
          <Link
            href="/firm/companies/new"
            className="flex min-h-[40px] items-center rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
          >
            {t('firm.companies.add')}
          </Link>
        ) : null}
      </div>

      {companies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-600">{t('firm.companies.empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('firm.companies.company')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.companies.status')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.companies.owners')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.companies.workers')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {companies.map((company) => (
                <tr key={company.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/firm/companies/${company.id}`}
                      className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {company.legalName}
                    </Link>
                    {company.dbaName ? (
                      <span className="block text-xs text-neutral-500">
                        {t('firm.companies.dba', { name: company.dbaName })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip
                      status={company.onboardingStatus}
                      label={t(`status.${company.onboardingStatus}`)}
                    />
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {company.pendingOwners > 0
                      ? t('firm.companies.outstanding', {
                          pending: company.pendingOwners,
                          total: company.ownerCount,
                        })
                      : t('firm.companies.allIn', { total: company.ownerCount })}
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {company.pendingWorkers > 0
                      ? t('firm.companies.outstanding', {
                          pending: company.pendingWorkers,
                          total: company.workerCount,
                        })
                      : t('firm.companies.allIn', { total: company.workerCount })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
