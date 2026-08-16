'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { signCompanyCertificationAction, type ActionResult } from '../../../_actions/company';
import { Card, Field, FormError, SubmitButton } from '../../../_components/form';
import type { Locale } from '../../../../i18n/request';

export default function CertifyForm({
  locale,
  paragraphs,
  consentLabel,
  nameLabel,
  expectedName,
}: {
  locale: Locale;
  paragraphs: string[];
  consentLabel: string;
  nameLabel: string;
  expectedName: string;
}) {
  const t = useTranslations();
  const action = signCompanyCertificationAction.bind(null, locale);
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(action, {});
  const [consented, setConsented] = useState(false);
  const [typedName, setTypedName] = useState('');

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <Card className="flex flex-col gap-4 bg-neutral-50">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="text-sm leading-relaxed text-neutral-800">
            {paragraph}
          </p>
        ))}
      </Card>

      <label className="flex items-start gap-3 rounded-lg border border-neutral-300 bg-white p-4">
        <input
          type="checkbox"
          name="consentToElectronic"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-400"
          required
        />
        <span className="text-sm leading-relaxed">{consentLabel}</span>
      </label>
      {error('consentToElectronic') ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error('consentToElectronic')}
        </p>
      ) : null}

      <Field
        id="typedName"
        label={nameLabel}
        hint={t('company.certify.nameHint', { expected: expectedName })}
        value={typedName}
        onChange={(event) => setTypedName(event.target.value)}
        error={error('typedName')}
        autoComplete="off"
        required
      />

      <SubmitButton disabled={pending || !consented || !typedName.trim()}>
        {pending ? t('app.working') : t('form.sign.submit')}
      </SubmitButton>
    </form>
  );
}
