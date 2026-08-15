'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { verifyTotpAction, type ActionState } from '../../../_actions/auth';
import { Field, FormError, SubmitButton } from '../../../_components/form';

export default function VerifyForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    verifyTotpAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error ? t(state.error, state.values ?? {}) : undefined} />

      <Field
        id="code"
        name="code"
        label={t('auth.totpCode')}
        hint={t('auth.totpHint')}
        // one-time-code lets the OS offer the code from the notification, and
        // numeric keeps the keypad on a phone. maxLength stops a paste of the
        // whole "123 456" display from arriving with a space.
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoFocus
        required
        className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-2xl tracking-[0.3em]"
      />

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('auth.verify')}
      </SubmitButton>
    </form>
  );
}
