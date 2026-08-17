import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requirePlatform } from '../../../lib/auth/current';
import { auditSummary, listFirms } from '../../../lib/db/queries/platform';
import { Card, StatusChip } from '../../_components/form';
import FirmStatusButton from './firm-status-button';

export const dynamic = 'force-dynamic';

/**
 * The platform admin dashboard.
 *
 * Counts and shapes, never contents. This role can see that a firm has eleven
 * client companies and that thirty tax IDs were revealed last week; it cannot
 * see which companies, which workers, or why. Spec section 2: "Can create
 * firms, suspend accounts, read audit metadata. Cannot decrypt anything."
 */
export default async function PlatformDashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ session }, t, params] = await Promise.all([
    requirePlatform(),
    getTranslations(),
    searchParams,
  ]);

  const [firms, summary] = await Promise.all([listFirms(session), auditSummary(session)]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('platform.title')}</h1>
          <p className="mt-0.5 text-sm text-neutral-600">{t('platform.subtitle')}</p>
        </div>
        <Link
          href="/platform/firms/new"
          className="flex min-h-[40px] items-center rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
        >
          {t('platform.addFirm')}
        </Link>
      </div>

      {params.created ? (
        <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">
          {t('platform.firmCreated')}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-medium">{t('platform.firm')}</th>
              <th className="px-4 py-3 font-medium">{t('platform.status')}</th>
              <th className="px-4 py-3 font-medium">{t('platform.companies')}</th>
              <th className="px-4 py-3 font-medium">{t('platform.staff')}</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {firms.map((firm) => (
              <tr key={firm.id}>
                <td className="px-4 py-3">
                  <span className="font-medium">{firm.name}</span>
                  <span className="block text-xs text-neutral-500">{firm.contactEmail}</span>
                </td>
                <td className="px-4 py-3">
                  <StatusChip
                    status={firm.status === 'active' ? 'SUBMITTED' : 'NEEDS_ATTENTION'}
                    label={t(`platform.${firm.status}`)}
                  />
                </td>
                <td className="tabular px-4 py-3 text-neutral-700">{firm.companyCount}</td>
                <td className="tabular px-4 py-3 text-neutral-700">{firm.staffCount}</td>
                <td className="px-4 py-3 text-right">
                  <FirmStatusButton
                    firmId={firm.id}
                    status={firm.status === 'active' ? 'active' : 'suspended'}
                  />
                </td>
              </tr>
            ))}
            {firms.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-600">
                  {t('platform.noFirms')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Card>
        <h2 className="text-base font-semibold">{t('platform.activity')}</h2>
        <p className="mt-1 text-xs text-neutral-500">{t('platform.activityHint')}</p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-2 py-2 font-medium">{t('firm.activity.action')}</th>
                <th className="px-2 py-2 font-medium">{t('firm.activity.actor')}</th>
                <th className="px-2 py-2 font-medium">{t('platform.occurrences')}</th>
                <th className="px-2 py-2 font-medium">{t('platform.mostRecent')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {summary.map((row) => (
                <tr key={`${row.action}-${row.actorRole}`}>
                  <td className="px-2 py-2 font-medium">{t(`audit.${row.action}`)}</td>
                  <td className="px-2 py-2 text-neutral-700">{t(`roles.${row.actorRole}`)}</td>
                  <td className="tabular px-2 py-2 text-neutral-700">{row.occurrences}</td>
                  <td className="tabular px-2 py-2 text-neutral-600">
                    {new Date(row.mostRecent).toISOString().replace('T', ' ').slice(0, 16)}
                  </td>
                </tr>
              ))}
              {summary.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-2 py-6 text-center text-neutral-600">
                    {t('firm.activity.empty')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
