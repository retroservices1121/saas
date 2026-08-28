'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { companyInviteOwnerAction, type ActionResult } from '../../../../_actions/company';
import { Card, Field, FormError, SelectField, SubmitButton } from '../../../../_components/form';

/**
 * Four fields, and no place to type a Social Security number.
 *
 * That absence is the feature. Spec section 7.3: for each owner the admin
 * enters only a display name, a percentage, a mobile number and a language; the
 * owner supplies everything else through their own link, including when the
 * company is a single-member entity and the admin is the owner.
 */
export default function InviteOwnerForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    companyInviteOwnerAction,
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
        <Field
          id="displayName"
          label={t('company.inviteOwner.displayName')}
          hint={t('company.inviteOwner.displayNameHint')}
          error={error('displayName')}
          required
        />
        <Field
          id="ownershipPercent"
          label={t('company.inviteOwner.percent')}
          hint={t('company.inviteOwner.percentHint')}
          error={error('ownershipPercent')}
          inputMode="decimal"
          className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
        />
        <Field
          id="inviteEmail"
          label={t('company.inviteOwner.email')}
          hint={t('company.inviteOwner.emailHint')}
          error={error('inviteEmail')}
          type="email"
          inputMode="email"
          autoCapitalize="off"
          required
        />
        <Field
          id="phoneE164"
          label={t('company.inviteOwner.phone')}
          hint={t('company.inviteOwner.phoneHint')}
          error={error('phoneE164')}
          inputMode="tel"
        />
        <SelectField
          id="preferredLocale"
          label={t('company.inviteOwner.language')}
          defaultValue="en"
          error={error('preferredLocale')}
        >
          <option value="en">English</option>
          <option value="es">Español</option>
        </SelectField>
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('company.inviteOwner.submit')}
      </SubmitButton>
    </form>
  );
}
