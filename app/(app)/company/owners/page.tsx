import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireCompany } from '../../../../lib/auth/current';
import { listOwnersForCompany } from '../../../../lib/db/queries/company';
import { checkOwnershipTotal } from '../../../../lib/validation/identity';
import { StatusChip } from '../../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * Owners, as the company sees them.
 *
 * The name the admin typed, the percentage they entered, and whether that
 * person has submitted. Not the legal name, not the date of birth, and not
 * tin_last4 — the column grant makes that last one unreadable to this role, so
 * it is not merely omitted from this query, it is unnameable.
 *
 * Spec section 16 item 1 flags the friction: a company admin cannot type in a
 * co-owner's Social Security number, even their own business partner's. That is
 * the same rule the client wrote for employees, applied consistently.
 */
export default async function CompanyOwnersPage() {
  const [{ session }, t] = await Promise.all([requireCompany(), getTranslations()]);
  const owners = await listOwnersForCompany(session);
  const ownership = checkOwnershipTotal(owners.map((owner) => owner.ownershipPercent));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">
          {t('company.owners.title', { count: owners.length })}
        </h1>
        {session.role === 'COMPANY_ADMIN' ? (
          <Link
            href="/company/owners/new"
            className="flex min-h-[40px] items-center rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
          >
            {t('company.owners.invite')}
          </Link>
        ) : null}
      </div>

      <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-relaxed text-blue-900">
        {t('company.owners.privacyNote')}
      </p>

      {ownership.warnings.length > 0 ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {t(`validation.${ownership.warnings[0]!.key}`, ownership.warnings[0]!.values ?? {})}
        </p>
      ) : null}

      {owners.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('company.owners.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('company.owners.name')}</th>
                <th className="px-4 py-3 font-medium">{t('company.owners.percent')}</th>
                <th className="px-4 py-3 font-medium">{t('company.owners.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {owners.map((owner) => (
                <tr key={owner.id}>
                  <td className="px-4 py-3 font-medium">{owner.displayName}</td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {owner.ownershipPercent ? `${owner.ownershipPercent}%` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={owner.status} label={t(`status.${owner.status}`)} />
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
