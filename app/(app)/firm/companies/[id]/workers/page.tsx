import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../lib/auth/current';
import { listWorkersForFirm } from '../../../../../../lib/db/queries/firm';
import { StatusChip } from '../../../../../_components/form';
import { maskAccount, maskTin } from '../../../../../../lib/forms/wizard';
import ResendInvite from '../../../_components/resend-invite';

export const dynamic = 'force-dynamic';

/**
 * The firm's worker list.
 *
 * Last-4 is shown here and a reveal is not. A masked value tells a firm user
 * which record they are looking at without any of them being a disclosure; the
 * reveal lives one level down, on a single record, where the reason they type
 * can be about that person.
 */
export default async function FirmWorkersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const workers = await listWorkersForFirm(session, id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          {t('firm.workers.title', { count: workers.length })}
        </h2>
      </div>

      {workers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('firm.workers.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('firm.workers.name')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.workers.type')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.workers.status')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.workers.tin')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.workers.account')}</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {workers.map((worker) => (
                <tr key={worker.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/firm/companies/${id}/workers/${worker.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {worker.displayName}
                    </Link>
                    {worker.jobTitle ? (
                      <span className="block text-xs text-neutral-500">{worker.jobTitle}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {t(`workerType.${worker.workerType}`)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={worker.status} label={t(`status.${worker.status}`)} />
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {worker.tinLast4 ? maskTin(worker.tinLast4) : '—'}
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {worker.accountLast4 ? maskAccount(worker.accountLast4) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {/* Only for someone who has not finished. Re-inviting a
                        worker who has submitted is a correction, which is a
                        different action with a different audit row. */}
                    {worker.status === 'INVITED' ||
                    worker.status === 'IN_PROGRESS' ||
                    worker.status === 'NEEDS_ATTENTION' ? (
                      <ResendInvite
                        companyId={id}
                        subjectType="WORKER"
                        subjectId={worker.id}
                      />
                    ) : null}
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
