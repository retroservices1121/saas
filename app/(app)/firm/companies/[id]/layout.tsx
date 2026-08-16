import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../lib/auth/current';
import { getCompanyForFirm } from '../../../../../lib/db/queries/firm';
import { StatusChip } from '../../../../_components/form';

/**
 * The company detail shell: header plus tabs (spec section 14).
 *
 * `notFound()` rather than a "no access" page. A company id outside this firm's
 * grants is genuinely indistinguishable from one that does not exist, and
 * saying "forbidden" would confirm the id is real to anyone enumerating.
 */
export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const company = await getCompanyForFirm(session, id);
  if (!company) notFound();

  const tabs = [
    { href: '', label: t('firm.tabs.overview') },
    { href: '/owners', label: t('firm.tabs.owners') },
    { href: '/workers', label: t('firm.tabs.workers') },
    { href: '/documents', label: t('firm.tabs.documents') },
    { href: '/notes', label: t('firm.tabs.notes') },
    { href: '/activity', label: t('firm.tabs.activity') },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/firm" className="text-sm text-neutral-600 hover:underline">
          ← {t('firm.companies.title')}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{company.legalName}</h1>
          <StatusChip
            status={company.onboardingStatus}
            label={t(`status.${company.onboardingStatus}`)}
          />
        </div>
      </div>

      <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-neutral-200">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={`/firm/companies/${id}${tab.href}`}
            className="whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
