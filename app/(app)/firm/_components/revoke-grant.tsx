'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { revokeGrantAction } from '../../../_actions/firm';

/**
 * Ends this firm's access to a company.
 *
 * Confirmed inline, and the confirmation says what actually happens: the
 * company disappears from every firm user's view on their next request, and the
 * grant row is kept and stamped rather than deleted, so "who had access, and
 * until when" still has an answer afterwards.
 */
export default function RevokeGrant({ companyId }: { companyId: string }) {
  const t = useTranslations();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-50"
      >
        {t('firm.revoke.button')}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50 p-3">
      <p className="text-sm leading-relaxed text-red-950">{t('firm.revoke.confirmBody')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => revokeGrantAction(companyId))}
          className="min-h-[36px] rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
        >
          {pending ? t('app.working') : t('firm.revoke.confirm')}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="min-h-[36px] rounded-md px-3 py-1.5 text-sm font-medium hover:bg-white"
        >
          {t('app.cancel')}
        </button>
      </div>
    </div>
  );
}
