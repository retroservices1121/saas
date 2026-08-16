'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { createCompanyAction, type ActionResult } from '../../../../_actions/firm';
import { Card, Field, FormError, SelectField, SubmitButton } from '../../../../_components/form';
import { US_STATES } from '../../../../../lib/validation/identity';

export default function NewCompanyForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    createCompanyAction,
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
        <h2 className="text-base font-semibold">{t('firm.new.companySection')}</h2>

        <Field id="legalName" label={t('firm.new.legalName')} error={error('legalName')} required />
        <Field id="dbaName" label={t('firm.new.dbaName')} error={error('dbaName')} />
        <Field
          id="ein"
          label={t('firm.new.ein')}
          hint={t('firm.new.einHint')}
          error={error('ein')}
          inputMode="numeric"
          maxLength={10}
          className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
        />

        <Field id="addressLine1" label={t('firm.new.address')} error={error('addressLine1')} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="city" label={t('firm.new.city')} error={error('city')} />
          <SelectField id="state" label={t('firm.new.state')} defaultValue="" error={error('state')}>
            <option value="">—</option>
            {US_STATES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </SelectField>
          <Field
            id="postalCode"
            label={t('firm.new.postalCode')}
            error={error('postalCode')}
            inputMode="numeric"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="contactEmail"
            label={t('firm.new.contactEmail')}
            error={error('contactEmail')}
            type="email"
            required
          />
          <Field
            id="contactPhone"
            label={t('firm.new.contactPhone')}
            error={error('contactPhone')}
            inputMode="tel"
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.new.adminSection')}</h2>
        {/*
          The company admin is created pending and emailed a 24-hour setup link.
          They choose their own password and enrol their own authenticator; the
          firm never sets a credential on their behalf.
        */}
        <p className="text-sm text-neutral-600">{t('firm.new.adminHint')}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="adminName" label={t('firm.new.adminName')} error={error('adminName')} required />
          <Field
            id="adminEmail"
            label={t('firm.new.adminEmail')}
            error={error('adminEmail')}
            type="email"
            required
          />
        </div>
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('firm.new.submit')}
      </SubmitButton>
    </form>
  );
}
