import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../lib/auth/current';
import { listOwnersForFirm } from '../../../../../../lib/db/queries/firm';
import { checkOwnershipTotal } from '../../../../../../lib/validation/identity';
import { StatusChip } from '../../../../../_components/form';
import Reveal from '../../../_components/reveal';
import { maskTin } from '../../../../../../lib/forms/wizard';

export const dynamic = 'force-dynamic';

export default async function FirmOwnersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const owners = await listOwnersForFirm(session, id);
  const ownership = checkOwnershipTotal(owners.map((owner) => owner.ownershipPercent));

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">
        {t('firm.owners.title', { count: owners.length })}
      </h2>

      {/* A warning, not a block (spec section 10). Fractional ownership is
          legitimate in plenty of structures and the firm knows which. */}
      {ownership.warnings.length > 0 ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t(`validation.${ownership.warnings[0]!.key}`, ownership.warnings[0]!.values ?? {})}
        </p>
      ) : null}

      {owners.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('firm.owners.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('firm.owners.name')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.owners.percent')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.owners.status')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.owners.tin')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {owners.map((owner) => (
                <tr key={owner.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium">
                      {[owner.legalFirstName, owner.legalLastName].filter(Boolean).join(' ') ||
                        owner.displayName}
                    </span>
                    <span className="block text-xs text-neutral-500">{owner.displayName}</span>
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {owner.ownershipPercent ? `${owner.ownershipPercent}%` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={owner.status} label={t(`status.${owner.status}`)} />
                  </td>
                  <td className="px-4 py-3">
                    {owner.tinLast4 ? (
                      <Reveal
                        field="tin"
                        recordType="OWNER"
                        recordId={owner.id}
                        masked={maskTin(owner.tinLast4)}
                        label={t(`firm.worker.tin.${owner.tinType ?? 'SSN'}`)}
                      />
                    ) : (
                      <span className="text-neutral-500">{t('firm.owners.notYet')}</span>
                    )}
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
