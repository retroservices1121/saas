import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import ProfileForm from './profile-form';
import { requireCompanyAdmin } from '../../../../lib/auth/current';
import { withScope, schema } from '../../../../lib/db/scoped';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function CompanyProfilePage() {
  const [{ session }, t] = await Promise.all([requireCompanyAdmin(), getTranslations()]);

  const company = await withScope(session, async (db) => {
    const rows = await db
      .select({
        legalName: schema.companies.legalName,
        dbaName: schema.companies.dbaName,
        ein: schema.companies.ein,
        addressLine1: schema.companies.addressLine1,
        addressLine2: schema.companies.addressLine2,
        city: schema.companies.city,
        state: schema.companies.state,
        postalCode: schema.companies.postalCode,
        contactEmail: schema.companies.contactEmail,
        contactPhone: schema.companies.contactPhone,
        operatingStates: schema.companies.operatingStates,
        wcStatus: schema.companies.wcStatus,
        wcPolicyNumber: schema.companies.wcPolicyNumber,
        wcCarrier: schema.companies.wcCarrier,
        wcExpiresOn: schema.companies.wcExpiresOn,
        disabilityPolicyNumber: schema.companies.disabilityPolicyNumber,
        disabilityCarrier: schema.companies.disabilityCarrier,
        disabilityExpiresOn: schema.companies.disabilityExpiresOn,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!company) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">{t('company.profile.title')}</h1>

      <ProfileForm
        defaults={{
          legalName: company.legalName,
          dbaName: company.dbaName ?? '',
          ein: company.ein ?? '',
          addressLine1: company.addressLine1 ?? '',
          addressLine2: company.addressLine2 ?? '',
          city: company.city ?? '',
          state: company.state ?? '',
          postalCode: company.postalCode ?? '',
          contactEmail: company.contactEmail ?? '',
          contactPhone: company.contactPhone ?? '',
          operatingStates: company.operatingStates ?? [],
          wcStatus: company.wcStatus,
          wcPolicyNumber: company.wcPolicyNumber ?? '',
          wcCarrier: company.wcCarrier ?? '',
          wcExpiresOn: company.wcExpiresOn ?? '',
          disabilityPolicyNumber: company.disabilityPolicyNumber ?? '',
          disabilityCarrier: company.disabilityCarrier ?? '',
          disabilityExpiresOn: company.disabilityExpiresOn ?? '',
        }}
      />
    </div>
  );
}
