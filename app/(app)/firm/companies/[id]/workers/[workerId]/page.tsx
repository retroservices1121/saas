import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../../lib/auth/current';
import {
  getWorkerRecordForFirm,
  listWorkerRecordVersions,
  listWorkersForFirm,
  maskWorkerRecord,
} from '../../../../../../../lib/db/queries/firm';
import { listDocuments } from '../../../../../../../lib/documents';
import { Card, StatusChip } from '../../../../../../_components/form';
import Reveal from '../../../../_components/reveal';
import ResendInvite from '../../../../_components/resend-invite';
import { maskAccount, maskTin } from '../../../../../../../lib/forms/wizard';

export const dynamic = 'force-dynamic';

/**
 * One worker, as a firm sees them.
 *
 * Non-sensitive fields in plaintext, sensitive ones masked with a per-field
 * reveal (spec section 7.6). The version history is below: a correction writes
 * a new row and preserves the old one, so "what did the record say when we
 * filed" has an answer.
 */
export default async function WorkerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; workerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id, workerId }, { session }, t, query] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
    searchParams,
  ]);

  const workers = await listWorkersForFirm(session, id);
  const worker = workers.find((row) => row.id === workerId);
  if (!worker) notFound();

  const [record, versions, documents] = await Promise.all([
    getWorkerRecordForFirm(session, workerId),
    listWorkerRecordVersions(session, workerId),
    listDocuments(session, id, { subjectType: 'WORKER', subjectId: workerId }),
  ]);

  // Stripped before anything reaches the response. The reveal fetches the
  // ciphertext again, server-side, when someone asks for it with a reason.
  const masked = maskWorkerRecord(record);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/firm/companies/${id}/workers`}
            className="text-sm text-neutral-600 hover:underline"
          >
            ← {t('firm.tabs.workers')}
          </Link>
          <h2 className="text-lg font-semibold">{worker.displayName}</h2>
          <StatusChip status={worker.status} label={t(`status.${worker.status}`)} />
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Two ways to fix a wrong value (spec section 7.8): the firm writes
              a new version here, or re-issues a link and the worker submits a
              fresh one themselves. */}
          {record ? (
            <Link
              href={`/firm/companies/${id}/workers/${workerId}/correct`}
              className="flex min-h-[36px] items-center rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-50"
            >
              {t('firm.correct.button')}
            </Link>
          ) : null}
          <ResendInvite companyId={id} subjectType="WORKER" subjectId={workerId} />
        </div>
      </div>

      {query.corrected ? (
        <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">
          {t('firm.correct.done')}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h3 className="text-base font-semibold">{t('firm.worker.payroll')}</h3>
          <p className="mt-1 text-xs text-neutral-500">{t('firm.worker.payrollHint')}</p>
          <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label={t('firm.worker.jobTitle')} value={worker.jobTitle} />
            <Detail label={t('firm.worker.startDate')} value={worker.startDate} />
            <Detail label={t('firm.worker.workState')} value={worker.workState} />
            <Detail
              label={t('firm.worker.type')}
              value={t(`workerType.${worker.workerType}`)}
            />
          </dl>
        </Card>

        <Card>
          <h3 className="text-base font-semibold">{t('firm.worker.personal')}</h3>
          <p className="mt-1 text-xs text-neutral-500">{t('firm.worker.personalHint')}</p>

          {!masked ? (
            <p className="mt-4 text-sm text-neutral-600">{t('firm.worker.notSubmitted')}</p>
          ) : (
            <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Detail
                label={t('firm.worker.legalName')}
                value={[masked.legalFirstName, masked.legalMiddleName, masked.legalLastName]
                  .filter(Boolean)
                  .join(' ')}
              />
              <Detail label={t('firm.worker.dob')} value={masked.dateOfBirth} />
              <Detail
                label={t('firm.worker.address')}
                value={[
                  masked.addressLine1,
                  masked.addressLine2,
                  masked.city,
                  masked.state,
                  masked.postalCode,
                ]
                  .filter(Boolean)
                  .join(', ')}
              />
              <Detail label={t('firm.worker.email')} value={masked.email} />
              <Detail label={t('firm.worker.phone')} value={masked.phoneE164} />
              <Detail label={t('firm.worker.bank')} value={masked.bankName} />

              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-neutral-500">
                  {t(`firm.worker.tin.${masked.tinType}`)}
                </dt>
                <dd className="mt-1">
                  {/*
                    Absent means purged: the retention job nulls the sensitive
                    columns four years on and keeps the row, so an old record
                    still appears in the version history with nothing left to
                    reveal (spec section 13).
                  */}
                  {masked.tinLast4 ? (
                    <Reveal
                      field="tin"
                      recordType="WORKER_RECORD"
                      recordId={masked.id}
                      masked={maskTin(masked.tinLast4)}
                      label={t(`firm.worker.tin.${masked.tinType}`)}
                    />
                  ) : (
                    <span className="text-sm text-neutral-500">{t('firm.worker.purged')}</span>
                  )}
                </dd>
              </div>

              {masked.routingLast4 ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    {t('firm.worker.routing')}
                  </dt>
                  <dd className="mt-1">
                    <Reveal
                      field="routing"
                      recordType="WORKER_RECORD"
                      recordId={masked.id}
                      masked={maskAccount(masked.routingLast4)}
                      label={t('firm.worker.routing')}
                    />
                  </dd>
                </div>
              ) : null}

              {masked.accountLast4 ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    {t('firm.worker.account')}
                  </dt>
                  <dd className="mt-1">
                    <Reveal
                      field="account"
                      recordType="WORKER_RECORD"
                      recordId={masked.id}
                      masked={maskAccount(masked.accountLast4)}
                      label={t('firm.worker.account')}
                    />
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </Card>
      </div>

      <Card>
        <h3 className="text-base font-semibold">{t('firm.worker.history')}</h3>
        <p className="mt-1 text-xs text-neutral-500">{t('firm.worker.historyHint')}</p>
        <ul className="mt-3 flex flex-col divide-y divide-neutral-100 text-sm">
          {versions.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="tabular font-medium">v{version.version}</span>
              <span className="text-neutral-600">
                {t(`submittedVia.${version.submittedVia}`)}
              </span>
              <span className="tabular text-neutral-500">
                {version.effectiveFrom.toISOString().slice(0, 10)}
              </span>
              {version.isCurrent ? (
                <StatusChip status="SUBMITTED" label={t('firm.worker.current')} />
              ) : null}
            </li>
          ))}
          {versions.length === 0 ? (
            <li className="py-2 text-neutral-600">{t('firm.worker.noVersions')}</li>
          ) : null}
        </ul>
      </Card>

      <Card>
        <h3 className="text-base font-semibold">{t('firm.worker.documents')}</h3>
        <ul className="mt-3 flex flex-col divide-y divide-neutral-100 text-sm">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-3 py-2">
              <a
                href={`/api/documents/${document.id}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline-offset-2 hover:underline"
              >
                {t(`docType.${document.docType}`)}
              </a>
              <span className="text-neutral-600">{document.label}</span>
              <span className="tabular text-xs text-neutral-500">
                {Math.round(document.sizeBytes / 1024)} KB
              </span>
            </li>
          ))}
          {documents.length === 0 ? (
            <li className="py-2 text-neutral-600">{t('firm.worker.noDocuments')}</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="tabular mt-0.5 break-words text-sm text-neutral-900">{value || '—'}</dd>
    </div>
  );
}
