'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { resendInviteAction } from '../../../_actions/firm';

/**
 * Issues a fresh link for someone who has not finished.
 *
 * It is a resend in the user's language only — the old token was never stored
 * in recoverable form, so this supersedes it with a new one. Anyone still
 * holding the previous link finds it dead, which is the correct outcome for a
 * link that has been sitting in a text message for a fortnight.
 */
export default function ResendInvite({
  companyId,
  subjectType,
  subjectId,
}: {
  companyId: string;
  subjectType: 'WORKER' | 'OWNER';
  subjectId: string;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  if (sent) {
    return <span className="text-xs font-medium text-green-800">{t('firm.resend.sent')}</span>;
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await resendInviteAction({ companyId, subjectType, subjectId });
          setSent(true);
        })
      }
      className="min-h-[32px] rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
    >
      {pending ? t('app.working') : t('firm.resend.button')}
    </button>
  );
}
