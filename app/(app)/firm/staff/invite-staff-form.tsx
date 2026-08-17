'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { inviteStaffAction, type ActionResult } from '../../../_actions/firm';
import { Field, FormError, SelectField, SubmitButton } from '../../../_components/form';

export default function InviteStaffForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    inviteStaffAction,
    {},
  );

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="name" label={t('firm.staff.name')} error={error('name')} required />
        <Field
          id="email"
          label={t('firm.staff.email')}
          error={error('email')}
          type="email"
          required
        />
        <SelectField
          id="role"
          label={t('firm.staff.role')}
          defaultValue="FIRM_STAFF"
          error={error('role')}
        >
          <option value="FIRM_STAFF">{t('roles.FIRM_STAFF')}</option>
          <option value="FIRM_ADMIN">{t('roles.FIRM_ADMIN')}</option>
        </SelectField>
      </div>

      <SubmitButton disabled={pending} variant="secondary">
        {pending ? t('app.working') : t('firm.staff.send')}
      </SubmitButton>
    </form>
  );
}
