import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import CertifyForm from './certify-form';
import { requireCompanyAdmin } from '../../../../lib/auth/current';
import { withScope, schema } from '../../../../lib/db/scoped';
import { renderDocument } from '../../../../lib/esign/documents';
import { missingSignatures, REQUIRED_SIGNATURES } from '../../../../lib/esign/sign';
import type { Locale } from '../../../../i18n/request';

export const dynamic = 'force-dynamic';

/**
 * The company certification (spec section 7.2, last sentence).
 *
 * Same ESIGN machinery as the worker signatures: the full text on screen, an
 * unchecked consent box, a typed legal name, and a hash of exactly what was
 * rendered. The company admin certifies, among other things, that they have not
 * entered anyone else's tax ID on their behalf — which is a claim the system
 * makes impossible rather than merely asks about.
 */
export default async function CertifyPage() {
  const [{ session, user }, locale] = await Promise.all([requireCompanyAdmin(), getLocale()]);

  const company = await withScope(session, async (db) => {
    const rows = await db
      .select({ legalName: schema.companies.legalName })
      .from(schema.companies)
      .where(eq(schema.companies.id, session.companyId))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!company) notFound();

  const outstanding = await missingSignatures(
    session,
    { subjectType: 'COMPANY', subjectId: session.companyId },
    REQUIRED_SIGNATURES.COMPANY,
  );
  if (outstanding.length === 0) redirect('/company');

  const document = renderDocument('COMPANY_CERTIFICATION', locale as Locale, {
    companyName: company.legalName,
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{document.title}</h1>
        <p className="text-sm text-neutral-600">{company.legalName}</p>
      </div>

      <CertifyForm
        locale={document.locale}
        paragraphs={document.paragraphs.slice(1)}
        consentLabel={document.consentLabel}
        nameLabel={document.nameLabel}
        expectedName={user.name}
      />
    </div>
  );
}
