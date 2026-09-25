'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { resendStaffSetupAction } from '../../../_actions/firm';

/**
 * A fresh setup link, for a link that expired or never arrived.
 *
 * The previous link stops working the moment this one is issued, so the button
 * says so rather than leaving someone to discover it — a staff member who
 * finds the old email first and gets nowhere will ask the person who sent it,
 * and that person is the one reading this screen.
 */
export default function ResendSetupButton({ userId }: { userId: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  if (sent) {
    return <span className="text-xs font-medium text-green-800">{t('firm.staff.resent')}</span>;
  }

  return (
    <button
      type="button"
      disabled={pending}
      title={t('firm.staff.resendHint')}
      onClick={() =>
        startTransition(async () => {
          await resendStaffSetupAction(userId);
          setSent(true);
        })
      }
      className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
    >
      {pending ? t('app.working') : t('firm.staff.resend')}
    </button>
  );
}
