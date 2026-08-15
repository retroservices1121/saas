'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { loginAction, type ActionState } from '../../_actions/auth';
import { Field, FormError, SubmitButton } from '../../_components/form';

export default function LoginForm({ setupComplete }: { setupComplete: boolean }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {setupComplete ? (
        <p
          role="status"
          className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900"
        >
          {t('auth.setupComplete')}
        </p>
      ) : null}

      <FormError message={state.error ? t(state.error, state.values ?? {}) : undefined} />

      <Field
        id="email"
        name="email"
        type="email"
        label={t('auth.email')}
        autoComplete="username"
        inputMode="email"
        required
      />
      <Field
        id="password"
        name="password"
        type="password"
        label={t('auth.password')}
        autoComplete="current-password"
        required
      />

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('auth.signIn')}
      </SubmitButton>
    </form>
  );
}
