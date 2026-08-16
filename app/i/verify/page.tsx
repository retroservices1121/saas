import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import VerifyForm from './verify-form';
import { getInviteToken } from '../../../lib/auth/invite-session';
import { openInvite } from '../../../lib/invites';
import { requestContext } from '../../../lib/auth/current';

export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  const token = await getInviteToken();
  if (!token) redirect('/i/expired');

  const state = await openInvite(token, await requestContext());
  if (state.status === 'unusable') redirect('/i/expired');
  if (state.status === 'locked') redirect('/i/locked');
  if (state.status === 'verified') redirect(`/form/${state.invite.draftStep ?? 'welcome'}`);

  const t = await getTranslations('form.verify');

  // Ages 14 to 100 (spec section 10), newest first — most people are closer to
  // 14 than to 100 and should not scroll eighty years to reach their year.
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 87 }, (_, i) => thisYear - 14 - i);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-base leading-relaxed text-neutral-700">
          {t('body', { company: state.invite.companyName })}
        </p>
      </div>

      <VerifyForm years={years} />

      <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">
        {t('why')}
      </p>
    </div>
  );
}
