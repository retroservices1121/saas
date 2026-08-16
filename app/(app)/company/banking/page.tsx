import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import BankingForm from './banking-form';
import { requireCompanyAdmin } from '../../../../lib/auth/current';
import { withScope, schema } from '../../../../lib/db/scoped';

export const dynamic = 'force-dynamic';

export default async function CompanyBankingPage() {
  const [{ session }, t] = await Promise.all([requireCompanyAdmin(), getTranslations()]);

  const company = await withScope(session, async (db) => {
    const rows = await db
      .select({
        bankName: schema.companies.bankName,
        bankRoutingLast4: schema.companies.bankRoutingLast4,
        bankAccountLast4: schema.companies.bankAccountLast4,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!company) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('company.banking.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('company.banking.intro')}</p>
      </div>

      <BankingForm
        bankName={company.bankName ?? ''}
        routingLast4={company.bankRoutingLast4}
        accountLast4={company.bankAccountLast4}
      />
    </div>
  );
}
