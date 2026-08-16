import { getTranslations } from 'next-intl/server';
import { requireCompanyAdmin } from '../../../../lib/auth/current';
import { listDocumentsForCompany } from '../../../../lib/db/queries/company';
import UploadForm from './upload-form';
import { Card } from '../../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * The company's document list.
 *
 * Only COMPANY_VISIBLE rows appear, and that filtering is done by the RLS
 * policy rather than by this page. A voided check a worker uploaded does not
 * exist for this session — it cannot appear in the list, in a count, or in an
 * ordering, so there is no "3 documents" that mysteriously renders two rows.
 */
export default async function CompanyDocumentsPage() {
  const [{ session }, t] = await Promise.all([requireCompanyAdmin(), getTranslations()]);
  const documents = await listDocumentsForCompany(session);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('company.documents.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('company.documents.intro')}</p>
      </div>

      <UploadForm />

      <Card>
        <h2 className="text-base font-semibold">
          {t('company.documents.uploaded', { count: documents.length })}
        </h2>

        {documents.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-600">{t('company.documents.empty')}</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-neutral-100 text-sm">
            {documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="font-medium">{t(`docType.${document.docType}`)}</span>
                <span className="text-neutral-600">{document.label ?? '—'}</span>
                <span className="tabular ml-auto text-xs text-neutral-500">
                  {Math.round(document.sizeBytes / 1024)} KB ·{' '}
                  {document.createdAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
