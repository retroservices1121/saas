'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { correctWorkerAction, type CorrectionState } from '../../../../../../../_actions/correction';
import {
  Card,
  Field,
  FormError,
  SelectField,
  SubmitButton,
} from '../../../../../../../_components/form';
import { US_STATES } from '../../../../../../../../lib/validation/identity';

export interface CorrectionDefaults {
  legalFirstName: string;
  legalMiddleName: string;
  legalLastName: string;
  dateOfBirth: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  email: string;
  phoneE164: string;
  bankName: string;
  bankAccountType: string;
  /** Masked, for the placeholder. The plaintext never reaches the browser. */
  tinMasked: string;
  routingMasked: string;
  accountMasked: string;
  tinType: string;
}

export default function CorrectForm({
  companyId,
  workerId,
  defaults,
}: {
  companyId: string;
  workerId: string;
  defaults: CorrectionDefaults;
}) {
  const t = useTranslations();
  const action = correctWorkerAction.bind(null, companyId, workerId);
  const [state, formAction, pending] = useActionState<CorrectionState, FormData>(action, {});

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.correct.identity')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="legalFirstName"
            label={t('form.name.first')}
            defaultValue={defaults.legalFirstName}
            error={error('legalFirstName')}
            required
          />
          <Field
            id="legalMiddleName"
            label={t('form.name.middle')}
            defaultValue={defaults.legalMiddleName}
          />
          <Field
            id="legalLastName"
            label={t('form.name.last')}
            defaultValue={defaults.legalLastName}
            error={error('legalLastName')}
            required
          />
        </div>
        <Field
          id="dateOfBirth"
          label={t('firm.worker.dob')}
          defaultValue={defaults.dateOfBirth}
          error={error('dateOfBirth')}
          type="date"
          required
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.correct.contact')}</h2>
        <Field
          id="addressLine1"
          label={t('form.address.line1')}
          defaultValue={defaults.addressLine1}
          error={error('addressLine1')}
          required
        />
        <Field
          id="addressLine2"
          label={t('form.address.line2')}
          defaultValue={defaults.addressLine2}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="city"
            label={t('form.address.city')}
            defaultValue={defaults.city}
            error={error('city')}
            required
          />
          <SelectField
            id="state"
            label={t('form.address.state')}
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
            label={t('form.address.postalCode')}
            defaultValue={defaults.postalCode}
            error={error('postalCode')}
            inputMode="numeric"
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="phoneE164"
            label={t('form.contact.phone')}
            defaultValue={defaults.phoneE164}
            error={error('phoneE164')}
            inputMode="tel"
            required
          />
          <Field
            id="email"
            label={t('form.contact.email')}
            defaultValue={defaults.email}
            error={error('email')}
            type="email"
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.correct.sensitive')}</h2>
        {/*
          Blank means unchanged, and unchanged means the existing ciphertext is
          carried forward byte for byte — no decryption, no plaintext, no reveal
          row. The placeholder shows the masked current value so the person can
          confirm which record they are on without being shown the number.
        */}
        <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-700">
          {t('firm.correct.sensitiveHint')}
        </p>

        <Field
          id="tin"
          label={t(`firm.worker.tin.${defaults.tinType}`)}
          placeholder={defaults.tinMasked}
          error={error('tin')}
          inputMode="numeric"
          autoComplete="off"
          className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="routingNumber"
            label={t('firm.worker.routing')}
            placeholder={defaults.routingMasked || '—'}
            error={error('routingNumber')}
            inputMode="numeric"
            autoComplete="off"
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
          />
          <Field
            id="accountNumber"
            label={t('firm.worker.account')}
            placeholder={defaults.accountMasked || '—'}
            error={error('accountNumber')}
            inputMode="numeric"
            autoComplete="off"
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-base"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="bankName" label={t('firm.worker.bank')} defaultValue={defaults.bankName} />
          <SelectField
            id="bankAccountType"
            label={t('form.bank.type')}
            defaultValue={defaults.bankAccountType}
          >
            <option value="">—</option>
            <option value="CHECKING">{t('form.bank.checking')}</option>
            <option value="SAVINGS">{t('form.bank.savings')}</option>
          </SelectField>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <label htmlFor="reason" className="text-sm font-medium">
          {t('firm.correct.reason')}
        </label>
        <p className="text-xs text-neutral-600">{t('firm.correct.reasonHint')}</p>
        <textarea
          id="reason"
          name="reason"
          rows={3}
          minLength={10}
          maxLength={500}
          required
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
        />
        {error('reason') ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error('reason')}
          </p>
        ) : null}
      </Card>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('firm.correct.submit')}
      </SubmitButton>
    </form>
  );
}
