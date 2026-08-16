'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { verifyDobAction, type FormState } from '../../_actions/form';
import { FormError, SelectField, SubmitButton } from '../../_components/form';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * The date-of-birth gate.
 *
 * Three numeric selects rather than a native date picker (spec section 8,
 * screen 0). A native picker on older Android opens on the current year and
 * requires a scroll through several decades to reach a birth year, which
 * reliably produces a date nobody intended — and here a wrong date costs an
 * attempt out of five.
 */
export default function VerifyForm({ years }: { years: number[] }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FormState, FormData>(verifyDobAction, {});

  const remaining = state.fieldErrors?.remaining;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <FormError
        message={
          state.error
            ? remaining
              ? t('form.errors.dobWrongRemaining', { remaining })
              : t(state.error)
            : undefined
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <SelectField id="month" name="month" label={t('form.verify.month')} required defaultValue="">
          <option value="" disabled>
            —
          </option>
          {MONTHS.map((month) => (
            <option key={month} value={month}>
              {t(`form.months.${month}`)}
            </option>
          ))}
        </SelectField>

        <SelectField id="day" name="day" label={t('form.verify.day')} required defaultValue="">
          <option value="" disabled>
            —
          </option>
          {DAYS.map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </SelectField>

        <SelectField id="year" name="year" label={t('form.verify.year')} required defaultValue="">
          <option value="" disabled>
            —
          </option>
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </SelectField>
      </div>

      <SubmitButton disabled={pending}>
        {pending ? t('app.working') : t('app.continue')}
      </SubmitButton>
    </form>
  );
}
