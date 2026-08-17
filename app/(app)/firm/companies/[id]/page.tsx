import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../lib/auth/current';
import { getCompanyForFirm } from '../../../../../lib/db/queries/firm';
import { getOnboardingChecklist } from '../../../../../lib/db/queries/company-profile';
import { Card } from '../../../../_components/form';
import { maskAccount } from '../../../../../lib/forms/wizard';
import RevokeGrant from '../../_components/revoke-grant';

export const dynamic = 'force-dynamic';

export default async function CompanyOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);
  const isFirmAdmin = session.role === 'FIRM_ADMIN';

  const company = await getCompanyForFirm(session, id);
  if (!company) notFound();

  const checklist = await getOnboardingChecklist(session, id);

  const details: Array<[string, string]> = [
    [t('firm.overview.ein'), company.ein ?? t('app.notProvided')],
    [
      t('firm.overview.address'),
      [company.addressLine1, company.addressLine2, company.city, company.state, company.postalCode]
        .filter(Boolean)
        .join(', ') || t('app.notProvided'),
    ],
    [t('firm.overview.contact'), company.contactEmail ?? t('app.notProvided')],
    [t('firm.overview.phone'), company.contactPhone ?? t('app.notProvided')],
    [
      t('firm.overview.operatingStates'),
      company.operatingStates?.join(', ') || t('app.notProvided'),
    ],
    [t('firm.overview.wcStatus'), t(`wc.${company.wcStatus}`)],
    [t('firm.overview.wcPolicy'), company.wcPolicyNumber ?? t('app.notProvided')],
    [t('firm.overview.wcExpires'), company.wcExpiresOn ?? t('app.notProvided')],
    [t('firm.overview.bank'), company.bankName ?? t('app.notProvided')],
    [
      t('firm.overview.bankAccount'),
      company.bankAccountLast4 ? maskAccount(company.bankAccountLast4) : t('app.notProvided'),
    ],
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <Card>
        <h2 className="text-base font-semibold">{t('firm.overview.details')}</h2>
        <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
              <dd className="tabular mt-0.5 break-words text-sm text-neutral-900">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card>
        <h2 className="text-base font-semibold">{t('firm.overview.checklist')}</h2>
        <ul className="mt-4 flex flex-col gap-2.5">
          {(Object.keys(checklist) as Array<keyof typeof checklist>).map((key) => (
            <li key={key} className="flex items-start gap-2.5 text-sm">
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
                <span className="sr-only">
                  {checklist[key] ? t('checklist.done') : t('checklist.todo')}
                </span>
              </span>
            </li>
          ))}
        </ul>

        {/* Revoking is FIRM_ADMIN only, and it is the last thing on the page
            rather than a header button — nobody should reach for it by
            accident on the way to the workers tab. */}
        {isFirmAdmin ? (
          <div className="mt-6 border-t border-neutral-200 pt-4">
            <h3 className="text-sm font-semibold">{t('firm.revoke.title')}</h3>
            <p className="mb-3 mt-1 text-xs leading-relaxed text-neutral-600">
              {t('firm.revoke.hint')}
            </p>
            <RevokeGrant companyId={id} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
