import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../lib/auth/current';
import { listDocuments } from '../../../../../../lib/documents';
import { StatusChip } from '../../../../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * Every document, including the ones the company cannot see.
 *
 * The sensitivity chip is shown to firm users on purpose. It is the only place
 * in the product where the FIRM_ONLY split is visible as a fact rather than as
 * an absence, and a firm user about to forward a file to a company needs to
 * know which side of the line it sits on before they do.
 */
export default async function FirmDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const documents = await listDocuments(session, id);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">
        {t('firm.documents.title', { count: documents.length })}
      </h2>

      {documents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('firm.documents.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('firm.documents.type')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.documents.label')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.documents.visibility')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.documents.uploadedBy')}</th>
                <th className="px-4 py-3 font-medium">{t('firm.documents.size')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {documents.map((document) => (
                <tr key={document.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    {/* A plain link, not a fetch. The route 302s to a
                        short-lived signed URL and writes DOCUMENT_VIEWED when it
                        issues one. */}
                    <a
                      href={`/api/documents/${document.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {t(`docType.${document.docType}`)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-neutral-700">{document.label ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusChip
                      status={
                        document.sensitivity === 'FIRM_ONLY' ? 'NEEDS_ATTENTION' : 'SUBMITTED'
                      }
                      label={t(`sensitivity.${document.sensitivity}`)}
                    />
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {t(`roles.${document.uploadedByRole}`)}
                  </td>
                  <td className="tabular px-4 py-3 text-neutral-700">
                    {Math.round(document.sizeBytes / 1024)} KB
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
