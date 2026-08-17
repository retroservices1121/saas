'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setStaffStatusAction } from '../../../_actions/firm';

export default function StaffStatusButton({
  userId,
  status,
}: {
  userId: string;
  status: 'active' | 'suspended';
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const next = status === 'active' ? 'suspended' : 'active';

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => setStaffStatusAction(userId, next))}
      className="min-h-[36px] rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
    >
      {pending
        ? t('app.working')
        : status === 'active'
          ? t('firm.staff.suspend')
          : t('firm.staff.reactivate')}
    </button>
  );
}
