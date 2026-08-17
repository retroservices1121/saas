import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import CorrectForm from './correct-form';
import { requireFirm } from '../../../../../../../../lib/auth/current';
import { getWorkerRecordForFirm } from '../../../../../../../../lib/db/queries/firm';
import { maskAccount, maskTin } from '../../../../../../../../lib/forms/wizard';

export const dynamic = 'force-dynamic';

/**
 * The corrections form (spec section 7.8).
 *
 * A worker cannot log back in, so when a value is wrong the firm either creates
 * a correction here — which writes a new version and preserves the old one —
 * or re-issues an invite and lets the worker submit a fresh version themselves.
 * Both paths exist; this is the first.
 *
 * Nothing sensitive is sent to the browser. The three encrypted fields are
 * rendered as masked placeholders, and leaving one blank carries its ciphertext
 * forward untouched.
 */
export default async function CorrectWorkerPage({
  params,
}: {
  params: Promise<{ id: string; workerId: string }>;
}) {
  const [{ id, workerId }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const record = await getWorkerRecordForFirm(session, workerId);
  if (!record?.tinLast4) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={`/firm/companies/${id}/workers/${workerId}`}
          className="text-sm text-neutral-600 hover:underline"
        >
          ← {t('firm.correct.back')}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{t('firm.correct.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">
          {t('firm.correct.intro', { version: record.version })}
        </p>
      </div>

      <CorrectForm
        companyId={id}
        workerId={workerId}
        defaults={{
          legalFirstName: record.legalFirstName,
          legalMiddleName: record.legalMiddleName ?? '',
          legalLastName: record.legalLastName,
          dateOfBirth: record.dateOfBirth,
          addressLine1: record.addressLine1 ?? '',
          addressLine2: record.addressLine2 ?? '',
          city: record.city ?? '',
          state: record.state ?? '',
          postalCode: record.postalCode ?? '',
          email: record.email ?? '',
          phoneE164: record.phoneE164 ?? '',
          bankName: record.bankName ?? '',
          bankAccountType: record.bankAccountType ?? '',
          tinType: record.tinType,
          tinMasked: maskTin(record.tinLast4),
          routingMasked: record.routingLast4 ? maskAccount(record.routingLast4) : '',
          accountMasked: record.accountLast4 ? maskAccount(record.accountLast4) : '',
        }}
      />
    </div>
  );
}
