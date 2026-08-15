'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { completeSetupAction, type ActionState } from '../../../_actions/auth';
import { Field, FormError, SubmitButton } from '../../../_components/form';

export default function SetupForm({
  token,
  secret,
  formattedSecret,
  qrSvg,
}: {
  token: string;
  secret: string;
  formattedSecret: string;
  qrSvg: string;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    completeSetupAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <FormError message={state.error ? t(state.error, state.values ?? {}) : undefined} />

      {/*
        The secret travels back with the form rather than being written to the
        user row up front. A secret persisted before anyone proves they can
        produce a code from it leaves accounts holding an authenticator nobody
        scanned, discovered at the next login.
      */}
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="secret" value={secret} />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('auth.setupStep1')}</h2>
        <Field
          id="password"
          name="password"
          type="password"
          label={t('auth.newPassword')}
          hint={t('auth.passwordHint')}
          autoComplete="new-password"
          required
        />
        <Field
          id="passwordConfirm"
          name="passwordConfirm"
          type="password"
          label={t('auth.confirmPassword')}
          autoComplete="new-password"
          required
        />
      </section>

      <section className="flex flex-col gap-4 border-t border-neutral-200 pt-6">
        <h2 className="text-base font-semibold">{t('auth.setupStep2')}</h2>
        <p className="text-sm text-neutral-600">{t('auth.totpEnrollHint')}</p>

        <div
          className="mx-auto w-44 rounded-lg border border-neutral-200 bg-white p-3"
          // Server-rendered SVG from the qrcode package. The only variable in it
          // is a base32 secret this request just generated.
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />

        <div className="rounded-lg bg-neutral-100 p-3">
          <p className="text-xs text-neutral-600">{t('auth.manualEntry')}</p>
          <p className="tabular mt-1 break-all text-sm font-medium">{formattedSecret}</p>
        </div>

        <Field
          id="code"
          name="code"
          label={t('auth.totpCode')}
          hint={t('auth.totpConfirmHint')}
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-2xl tracking-[0.3em]"
        />
      </section>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('auth.finishSetup')}
      </SubmitButton>
    </form>
  );
}
