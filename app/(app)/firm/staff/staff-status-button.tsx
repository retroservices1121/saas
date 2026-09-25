'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setStaffStatusAction } from '../../../_actions/firm';

/**
 * Suspend, or lift a suspension.
 *
 * Reactivation asks for `active` and lets the server decide what that means:
 * somebody suspended before they ever opened their setup link goes back to
 * `pending`, because a firm user cannot be `active` without an authenticator.
 * Deciding it here would mean trusting a status the browser sent back.
 */
export default function StaffStatusButton({
  userId,
  status,
}: {
  userId: string;
  status: 'pending' | 'active' | 'suspended';
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const next = status === 'suspended' ? 'active' : 'suspended';

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => setStaffStatusAction(userId, next))}
      className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
    >
      {pending
        ? t('app.working')
        : status === 'suspended'
          ? t('firm.staff.reactivate')
          : t('firm.staff.suspend')}
    </button>
  );
}
