import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireCompany } from '../../../lib/auth/current';
import { getOnboardingChecklist } from '../../../lib/db/queries/company-profile';
import {
  listOwnersForCompany,
  listWorkersForCompany,
} from '../../../lib/db/queries/company';
import { Card, StatusChip } from '../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * The company's own dashboard: a checklist and counts.
 *
 * There is deliberately nothing here about any individual person beyond a name
 * the company typed and a status chip. That is the whole product for this role.
 */
export default async function CompanyDashboard() {
  const [{ session }, t] = await Promise.all([requireCompany(), getTranslations()]);

  const [checklist, workers, owners] = await Promise.all([
    getOnboardingChecklist(session, session.companyId),
    listWorkersForCompany(session),
    listOwnersForCompany(session),
  ]);

  const links: Record<keyof typeof checklist, string> = {
    profileComplete: '/company/profile',
    bankingComplete: '/company/banking',
    ownersSubmitted: '/company/owners',
    articlesUploaded: '/company/documents',
    wcResolved: '/company/profile',
    certificationSigned: '/company/certify',
  };

  const outstanding = (Object.keys(checklist) as Array<keyof typeof checklist>).filter(
    (key) => !checklist[key],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('company.dashboard.title')}</h1>
        <p className="mt-0.5 text-sm text-neutral-600">
          {outstanding.length === 0
            ? t('company.dashboard.allDone')
            : t('company.dashboard.remaining', { count: outstanding.length })}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <h2 className="text-base font-semibold">{t('company.dashboard.checklist')}</h2>
          <ul className="mt-4 flex flex-col divide-y divide-neutral-100">
            {(Object.keys(checklist) as Array<keyof typeof checklist>).map((key) => (
              <li key={key} className="flex items-center justify-between gap-3 py-3">
                <span className="flex items-start gap-2.5 text-sm">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      checklist[key] ? 'bg-green-600 text-white' : 'border border-neutral-300'
                    }`}
                  >
                    {checklist[key] ? '✓' : ''}
                  </span>
                  <span className={checklist[key] ? 'text-neutral-500' : 'text-neutral-900'}>
                    {t(`checklist.${key}`)}
                  </span>
                </span>
                {!checklist[key] ? (
                  <Link
                    href={links[key]}
                    className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50"
                  >
                    {t('company.dashboard.go')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{t('company.dashboard.workers')}</h2>
              <Link href="/company/workers" className="text-sm text-blue-700 hover:underline">
                {t('company.dashboard.view')}
              </Link>
            </div>
            <p className="tabular mt-2 text-2xl font-semibold">{workers.length}</p>
            <p className="mt-1 text-sm text-neutral-600">
              {t('company.dashboard.workersSubmitted', {
                count: workers.filter((worker) => worker.status === 'SUBMITTED').length,
              })}
            </p>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{t('company.dashboard.owners')}</h2>
              <Link href="/company/owners" className="text-sm text-blue-700 hover:underline">
                {t('company.dashboard.view')}
              </Link>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {owners.map((owner) => (
                <StatusChip
                  key={owner.id}
                  status={owner.status}
                  label={`${owner.displayName} · ${t(`status.${owner.status}`)}`}
                />
              ))}
              {owners.length === 0 ? (
                <p className="text-sm text-neutral-600">{t('company.owners.empty')}</p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
