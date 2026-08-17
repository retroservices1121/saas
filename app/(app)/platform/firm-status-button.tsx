'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setFirmStatusAction } from '../../_actions/platform';

/**
 * Suspend or reactivate a firm.
 *
 * Suspension is confirmed inline rather than with a modal, because it logs out
 * every member of that firm on their next request — reversible, but disruptive
 * enough that an accidental click should take two.
 */
export default function FirmStatusButton({
  firmId,
  status,
}: {
  firmId: string;
  status: 'active' | 'suspended';
}) {
  const t = useTranslations();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const next = status === 'active' ? 'suspended' : 'active';

  const apply = () => {
    startTransition(async () => {
      await setFirmStatusAction(firmId, next);
      setConfirming(false);
    });
  };

  if (status === 'suspended') {
    return (
      <button
        type="button"
        onClick={apply}
        disabled={pending}
        className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? t('app.working') : t('platform.reactivate')}
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50"
      >
        {t('platform.suspend')}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-neutral-600">{t('platform.suspendConfirm')}</span>
      <button
        type="button"
        onClick={apply}
        disabled={pending}
        className="min-h-[36px] rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
      >
        {pending ? t('app.working') : t('platform.suspend')}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="min-h-[36px] rounded-md px-2 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
      >
        {t('app.cancel')}
      </button>
    </span>
  );
}
