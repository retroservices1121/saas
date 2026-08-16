'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveProfileAction, type ActionResult } from '../../../_actions/company';
import { Card, Field, FormError, SelectField, SubmitButton } from '../../../_components/form';
import { US_STATES } from '../../../../lib/validation/identity';

export interface ProfileDefaults {
  legalName: string;
  dbaName: string;
  ein: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  contactEmail: string;
  contactPhone: string;
  operatingStates: string[];
  wcStatus: 'POLICY' | 'EXEMPT' | 'PENDING';
  wcPolicyNumber: string;
  wcCarrier: string;
  wcExpiresOn: string;
  disabilityPolicyNumber: string;
  disabilityCarrier: string;
  disabilityExpiresOn: string;
}

export default function ProfileForm({ defaults }: { defaults: ProfileDefaults }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    saveProfileAction,
    {},
  );
  const [wcStatus, setWcStatus] = useState(defaults.wcStatus);

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      {state.ok ? (
        <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">
          {t('company.profile.saved')}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('company.profile.identity')}</h2>
        <Field
          id="legalName"
          label={t('company.profile.legalName')}
          defaultValue={defaults.legalName}
          error={error('legalName')}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="dbaName" label={t('company.profile.dbaName')} defaultValue={defaults.dbaName} />
          <Field
            id="ein"
            label={t('company.profile.ein')}
            defaultValue={defaults.ein}
            error={error('ein')}
            inputMode="numeric"
            maxLength={10}
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
          />
        </div>
        <Field
          id="addressLine1"
          label={t('company.profile.address')}
          defaultValue={defaults.addressLine1}
          error={error('addressLine1')}
          required
        />
        <Field
          id="addressLine2"
          label={t('company.profile.address2')}
          defaultValue={defaults.addressLine2}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="city"
            label={t('company.profile.city')}
            defaultValue={defaults.city}
            error={error('city')}
            required
          />
          <SelectField
            id="state"
            label={t('company.profile.state')}
            defaultValue={defaults.state}
            error={error('state')}
            required
          >
            <option value="">—</option>
            {US_STATES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </SelectField>
          <Field
            id="postalCode"
            label={t('company.profile.postalCode')}
            defaultValue={defaults.postalCode}
            error={error('postalCode')}
            inputMode="numeric"
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="contactEmail"
            label={t('company.profile.contactEmail')}
            defaultValue={defaults.contactEmail}
            error={error('contactEmail')}
            type="email"
            required
          />
          <Field
            id="contactPhone"
            label={t('company.profile.contactPhone')}
            defaultValue={defaults.contactPhone}
            error={error('contactPhone')}
            inputMode="tel"
            required
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('company.profile.operating')}</h2>
        {/*
          Multi-select rather than a single state: workers' compensation and
          state tax rules vary, and a company operating in three states has
          three sets of obligations. This is why operating_states is an array.
        */}
        <p className="text-sm text-neutral-600">{t('company.profile.operatingHint')}</p>
        <fieldset className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
          <legend className="sr-only">{t('company.profile.operating')}</legend>
          {US_STATES.map((code) => (
            <label
              key={code}
              className="flex min-h-[36px] cursor-pointer items-center justify-center gap-1 rounded-md border border-neutral-200 px-1 py-1 text-xs has-[:checked]:border-neutral-900 has-[:checked]:bg-neutral-900 has-[:checked]:text-white"
            >
              <input
                type="checkbox"
                name="operatingStates"
                value={code}
                defaultChecked={defaults.operatingStates.includes(code)}
                className="sr-only"
              />
              {code}
            </label>
          ))}
        </fieldset>
        {error('operatingStates') ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error('operatingStates')}
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('company.profile.insurance')}</h2>

        <SelectField
          id="wcStatus"
          label={t('company.profile.wcStatus')}
          value={wcStatus}
          onChange={(event) => setWcStatus(event.target.value as ProfileDefaults['wcStatus'])}
          error={error('wcStatus')}
        >
          <option value="PENDING">{t('wc.PENDING')}</option>
          <option value="POLICY">{t('wc.POLICY')}</option>
          <option value="EXEMPT">{t('wc.EXEMPT')}</option>
        </SelectField>

        {wcStatus === 'POLICY' ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="wcPolicyNumber"
              label={t('company.profile.wcPolicy')}
              defaultValue={defaults.wcPolicyNumber}
              error={error('wcPolicyNumber')}
            />
            <Field
              id="wcCarrier"
              label={t('company.profile.wcCarrier')}
              defaultValue={defaults.wcCarrier}
            />
            <Field
              id="wcExpiresOn"
              label={t('company.profile.wcExpires')}
              defaultValue={defaults.wcExpiresOn}
              error={error('wcExpiresOn')}
              type="date"
            />
          </div>
        ) : null}

        {wcStatus === 'EXEMPT' ? (
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
            {t('company.profile.exemptHint')}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="disabilityPolicyNumber"
            label={t('company.profile.disabilityPolicy')}
            defaultValue={defaults.disabilityPolicyNumber}
          />
          <Field
            id="disabilityCarrier"
            label={t('company.profile.disabilityCarrier')}
            defaultValue={defaults.disabilityCarrier}
          />
          <Field
            id="disabilityExpiresOn"
            label={t('company.profile.disabilityExpires')}
            defaultValue={defaults.disabilityExpiresOn}
            type="date"
          />
        </div>
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('app.save')}
      </SubmitButton>
    </form>
  );
}
