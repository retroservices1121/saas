import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireCompany } from '../../../../lib/auth/current';
import { listWorkersForCompany } from '../../../../lib/db/queries/company';
import { StatusChip } from '../../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * The company's worker list.
 *
 * Payroll fields the company entered itself, plus a status chip. No legal name,
 * no date of birth, no last-4 of anything (spec section 2: "not even last-4").
 *
 * The explanatory note is not decoration. A company admin who opens this
 * expecting to see a tax ID and finds a status chip will conclude the product
 * is broken and open a ticket; one who reads a sentence explaining that this is
 * how it works will not. The absence has to be legible as a design decision.
 */
export default async function CompanyWorkersPage() {
  const [{ session }, t] = await Promise.all([requireCompany(), getTranslations()]);
  const workers = await listWorkersForCompany(session);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          {t('company.workers.title', { count: workers.length })}
        </h1>
        <Link
          href="/company/workers/new"
          className="flex min-h-[40px] items-center rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
        >
          {t('company.workers.invite')}
        </Link>
      </div>

      <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-relaxed text-blue-900">
        {t('company.workers.privacyNote')}
      </p>

      {workers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('company.workers.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('company.workers.name')}</th>
                <th className="px-4 py-3 font-medium">{t('company.workers.jobTitle')}</th>
                <th className="px-4 py-3 font-medium">{t('company.workers.type')}</th>
                <th className="px-4 py-3 font-medium">{t('company.workers.startDate')}</th>
                <th className="px-4 py-3 font-medium">{t('company.workers.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {workers.map((worker) => (
                <tr key={worker.id}>
                  <td className="px-4 py-3 font-medium">{worker.displayName}</td>
                  <td className="px-4 py-3 text-neutral-700">{worker.jobTitle ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-700">
                    {t(`workerType.${worker.workerType}`)}
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">{worker.startDate ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusChip status={worker.status} label={t(`status.${worker.status}`)} />
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
