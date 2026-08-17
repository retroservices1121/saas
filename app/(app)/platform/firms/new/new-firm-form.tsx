'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createFirmAction, type PlatformState } from '../../../../_actions/platform';
import { Card, Field, FormError, SubmitButton } from '../../../../_components/form';

export default function NewFirmForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<PlatformState, FormData>(
    createFirmAction,
    {},
  );

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('platform.newFirm.firmSection')}</h2>
        <Field id="name" label={t('platform.newFirm.name')} error={error('name')} required />
        <Field
          id="contactEmail"
          label={t('platform.newFirm.contactEmail')}
          error={error('contactEmail')}
          type="email"
          required
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('platform.newFirm.adminSection')}</h2>
        {/*
          The first firm admin is the one account nobody else can create: there
          is no firm session that could have made it. Everything after this the
          firm does for itself.
        */}
        <p className="text-sm text-neutral-600">{t('platform.newFirm.adminHint')}</p>
        <Field
          id="adminName"
          label={t('platform.newFirm.adminName')}
          error={error('adminName')}
          required
        />
        <Field
          id="adminEmail"
          label={t('platform.newFirm.adminEmail')}
          error={error('adminEmail')}
          type="email"
          required
        />
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('platform.newFirm.submit')}
      </SubmitButton>
    </form>
  );
}
