'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { companyInviteWorkerAction, type ActionResult } from '../../../../_actions/company';
import { Card, Field, FormError, SelectField, SubmitButton } from '../../../../_components/form';
import { US_STATES } from '../../../../../lib/validation/identity';

export default function InviteWorkerForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    companyInviteWorkerAction,
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
        <h2 className="text-base font-semibold">{t('company.inviteWorker.person')}</h2>
        <p className="text-sm text-neutral-600">{t('company.inviteWorker.personHint')}</p>

        <Field
          id="displayName"
          label={t('company.inviteWorker.displayName')}
          hint={t('company.inviteWorker.displayNameHint')}
          error={error('displayName')}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="workerType"
            label={t('company.inviteWorker.type')}
            defaultValue="EMPLOYEE"
            error={error('workerType')}
          >
            <option value="EMPLOYEE">{t('workerType.EMPLOYEE')}</option>
            <option value="SUBCONTRACTOR">{t('workerType.SUBCONTRACTOR')}</option>
          </SelectField>
          <SelectField
            id="preferredLocale"
            label={t('company.inviteWorker.language')}
            hint={t('company.inviteWorker.languageHint')}
            defaultValue="en"
            error={error('preferredLocale')}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </SelectField>
        </div>
        <Field
          id="phoneE164"
          label={t('company.inviteWorker.phone')}
          hint={t('company.inviteWorker.phoneHint')}
          error={error('phoneE164')}
          inputMode="tel"
          required
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('company.inviteWorker.payroll')}</h2>
        {/*
          Pay rate is deliberately absent from this form and from the schema
          (spec section 15). Adding it converts this into a compensation system
          with a different disclosure profile.
        */}
        <p className="text-sm text-neutral-600">{t('company.inviteWorker.payrollHint')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="jobTitle" label={t('company.inviteWorker.jobTitle')} error={error('jobTitle')} />
          <Field
            id="startDate"
            label={t('company.inviteWorker.startDate')}
            type="date"
            error={error('startDate')}
          />
          <SelectField
            id="payType"
            label={t('company.inviteWorker.payType')}
            defaultValue=""
            error={error('payType')}
          >
            <option value="">—</option>
            <option value="HOURLY">{t('payType.HOURLY')}</option>
            <option value="SALARY">{t('payType.SALARY')}</option>
          </SelectField>
          <SelectField
            id="payFrequency"
            label={t('company.inviteWorker.payFrequency')}
            defaultValue=""
            error={error('payFrequency')}
          >
            <option value="">—</option>
            <option value="WEEKLY">{t('payFrequency.WEEKLY')}</option>
            <option value="BIWEEKLY">{t('payFrequency.BIWEEKLY')}</option>
            <option value="SEMIMONTHLY">{t('payFrequency.SEMIMONTHLY')}</option>
            <option value="MONTHLY">{t('payFrequency.MONTHLY')}</option>
          </SelectField>
          <SelectField
            id="workState"
            label={t('company.inviteWorker.workState')}
            defaultValue=""
            error={error('workState')}
          >
            <option value="">—</option>
            {US_STATES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </SelectField>
        </div>
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('company.inviteWorker.submit')}
      </SubmitButton>
    </form>
  );
}
