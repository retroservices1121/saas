import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../lib/auth/current';
import { listAuditForCompany } from '../../../../../../lib/db/queries/firm';

export const dynamic = 'force-dynamic';

/**
 * The audit trail for one company.
 *
 * Every reveal appears here with the reason that was typed. That is what asking
 * for a reason buys: a single reveal is rarely interesting, and a pattern of
 * empty or copy-pasted reasons is very interesting — but only if someone can
 * see them side by side.
 */
export default async function ActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const events = await listAuditForCompany(session, id, 200);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">{t('firm.activity.title')}</h2>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-medium">{t('firm.activity.when')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.activity.action')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.activity.actor')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.activity.reason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {events.map((event) => (
              <tr key={event.id} className="hover:bg-neutral-50">
                <td className="tabular whitespace-nowrap px-4 py-2.5 text-neutral-600">
                  {event.createdAt.toISOString().replace('T', ' ').slice(0, 16)}
                </td>
                <td className="px-4 py-2.5 font-medium">{t(`audit.${event.action}`)}</td>
                <td className="px-4 py-2.5 text-neutral-700">{t(`roles.${event.actorRole}`)}</td>
                <td className="px-4 py-2.5 text-neutral-700">{event.reason ?? '—'}</td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-neutral-600">
                  {t('firm.activity.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
