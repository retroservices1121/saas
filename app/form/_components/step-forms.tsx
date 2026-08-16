'use client';

/**
 * Every form screen's interactive part, in one client module.
 *
 * They live together because they are the same component with a different
 * question in it: a form bound to a server action, a submit button, and the
 * error state. Splitting them into seventeen files would separate things that
 * change together and hide how similar they are.
 *
 * None of them holds an answer in client state between screens. The server has
 * it after every submit, which is what makes the flow resumable.
 */
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, FormError, SelectField, SubmitButton } from '../../_components/form';
import type { FormState } from '../../_actions/form';
import { US_STATES } from '../../../lib/validation/identity';

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

function useStep(action: Action) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const fieldError = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };
  return { t, state, formAction, pending, fieldError };
}

function Continue({ pending }: { pending: boolean }) {
  const t = useTranslations();
  return (
    <SubmitButton disabled={pending} className="w-full">
      {pending ? t('app.working') : t('app.continue')}
    </SubmitButton>
  );
}

// ---------------------------------------------------------------------------

export function NameStep({ action, defaults }: { action: Action; defaults: Record<string, string> }) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="legalFirstName"
        label={t('form.name.first')}
        defaultValue={defaults.legalFirstName ?? ''}
        error={fieldError('legalFirstName')}
        autoComplete="given-name"
        autoCapitalize="words"
        required
      />
      <Field
        id="legalMiddleName"
        label={t('form.name.middle')}
        hint={t('form.name.middleHint')}
        defaultValue={defaults.legalMiddleName ?? ''}
        autoComplete="additional-name"
        autoCapitalize="words"
      />
      <Field
        id="legalLastName"
        label={t('form.name.last')}
        defaultValue={defaults.legalLastName ?? ''}
        error={fieldError('legalLastName')}
        autoComplete="family-name"
        autoCapitalize="words"
        required
      />
      <Continue pending={pending} />
    </form>
  );
}

export function DobConfirmStep({
  action,
  dateOfBirth,
  formatted,
}: {
  action: () => Promise<FormState>;
  dateOfBirth: string;
  formatted: string;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async () => action(),
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormError message={state.error ? t(state.error) : undefined} />
      {/*
        Read-only, prefilled from the verification gate (spec section 8, screen
        3). Asking for it twice would be asking someone to re-type the one value
        that locks them out after five wrong answers.
      */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3.5">
        <p className="text-sm text-neutral-600">{t('form.dob.label')}</p>
        <p className="tabular mt-1 text-lg font-medium">{formatted}</p>
      </div>
      <input type="hidden" name="dateOfBirth" value={dateOfBirth} />
      <Continue pending={pending} />
    </form>
  );
}

export function AddressStep({
  action,
  defaults,
}: {
  action: Action;
  defaults: Record<string, string>;
}) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="addressLine1"
        label={t('form.address.line1')}
        defaultValue={defaults.addressLine1 ?? ''}
        error={fieldError('addressLine1')}
        autoComplete="address-line1"
        required
      />
      <Field
        id="addressLine2"
        label={t('form.address.line2')}
        defaultValue={defaults.addressLine2 ?? ''}
        autoComplete="address-line2"
      />
      <Field
        id="city"
        label={t('form.address.city')}
        defaultValue={defaults.city ?? ''}
        error={fieldError('city')}
        autoComplete="address-level2"
        required
      />
      <SelectField
        id="state"
        label={t('form.address.state')}
        defaultValue={defaults.state ?? ''}
        error={fieldError('state')}
        autoComplete="address-level1"
        required
      >
        <option value="" disabled>
          —
        </option>
        {US_STATES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </SelectField>
      <Field
        id="postalCode"
        label={t('form.address.postalCode')}
        defaultValue={defaults.postalCode ?? ''}
        error={fieldError('postalCode')}
        // Numeric keypad, but type="text": type="number" strips leading zeros,
        // and 01002 is a real ZIP code.
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={10}
        required
      />
      <Continue pending={pending} />
    </form>
  );
}

export function ContactStep({
  action,
  defaults,
}: {
  action: Action;
  defaults: Record<string, string>;
}) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="phoneE164"
        label={t('form.contact.phone')}
        hint={t('form.contact.phoneHint')}
        defaultValue={defaults.phoneE164 ?? ''}
        error={fieldError('phoneE164')}
        inputMode="tel"
        autoComplete="tel"
        required
      />
      <Field
        id="email"
        label={t('form.contact.email')}
        hint={t('form.contact.emailHint')}
        defaultValue={defaults.email ?? ''}
        error={fieldError('email')}
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="off"
      />
      <Continue pending={pending} />
    </form>
  );
}

export function EmergencyStep({
  action,
  defaults,
}: {
  action: Action;
  defaults: Record<string, string>;
}) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="emergencyContactName"
        label={t('form.emergency.name')}
        defaultValue={defaults.emergencyContactName ?? ''}
        autoCapitalize="words"
      />
      <Field
        id="emergencyContactPhone"
        label={t('form.emergency.phone')}
        defaultValue={defaults.emergencyContactPhone ?? ''}
        error={fieldError('emergencyContactPhone')}
        inputMode="tel"
      />
      <Field
        id="emergencyContactRelationship"
        label={t('form.emergency.relationship')}
        defaultValue={defaults.emergencyContactRelationship ?? ''}
      />
      <Continue pending={pending} />
    </form>
  );
}

/**
 * Two large buttons, not a dropdown (spec section 8, screen 7).
 *
 * Each carries a plain-language explanation, because the difference between the
 * two is exactly the thing someone in this position is most likely to be unsure
 * about, and picking wrong costs them a screen and a warning.
 */
export function TinTypeStep({ action, current }: { action: Action; current?: string }) {
  const { t, state, formAction, pending } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      {(['SSN', 'ITIN'] as const).map((type) => (
        <button
          key={type}
          type="submit"
          name="tinType"
          value={type}
          disabled={pending}
          aria-pressed={current === type}
          className={`flex min-h-[88px] flex-col gap-1.5 rounded-xl border-2 px-5 py-4 text-left transition disabled:opacity-50 ${
            current === type
              ? 'border-neutral-900 bg-neutral-50'
              : 'border-neutral-300 hover:border-neutral-400'
          }`}
        >
          <span className="text-lg font-semibold">{t(`form.tinType.${type}.title`)}</span>
          <span className="text-sm leading-relaxed text-neutral-600">
            {t(`form.tinType.${type}.body`)}
          </span>
        </button>
      ))}
    </form>
  );
}

/**
 * The tax ID.
 *
 * Masked as typed and formatted as `123-45-6789` while the digits go in. The
 * mask is cosmetic — the value is validated and sealed on the server, and the
 * displayed grouping is what lets someone check they typed nine digits without
 * counting them.
 */
export function TinStep({ action, tinType }: { action: Action; tinType: 'SSN' | 'ITIN' }) {
  const { t, state, formAction, pending, fieldError } = useStep(action);
  const [value, setValue] = useState('');

  const format = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 9);
    if (digits.length <= 3) return digits;
    if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  };

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="tin"
        label={t(`form.tin.label.${tinType}`)}
        hint={t('form.tin.hint')}
        value={value}
        onChange={(event) => setValue(format(event.target.value))}
        error={fieldError('tin')}
        inputMode="numeric"
        autoComplete="off"
        // Off, deliberately: a browser or password manager that remembers a tax
        // ID has stored it somewhere this system cannot reach or erase.
        autoCorrect="off"
        spellCheck={false}
        maxLength={11}
        className="tabular min-h-[52px] rounded-lg border border-neutral-300 px-3 py-2 text-2xl tracking-wider"
        required
      />
      <Continue pending={pending} />
    </form>
  );
}

export function BankStep({
  action,
  defaults,
}: {
  action: Action;
  defaults: Record<string, string>;
}) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="bankName"
        label={t('form.bank.name')}
        defaultValue={defaults.bankName ?? ''}
        error={fieldError('bankName')}
        autoCapitalize="words"
        required
      />
      <SelectField
        id="bankAccountType"
        label={t('form.bank.type')}
        defaultValue={defaults.bankAccountType ?? 'CHECKING'}
        error={fieldError('bankAccountType')}
        required
      >
        <option value="CHECKING">{t('form.bank.checking')}</option>
        <option value="SAVINGS">{t('form.bank.savings')}</option>
      </SelectField>
      <Continue pending={pending} />
    </form>
  );
}

export function RoutingStep({ action }: { action: Action }) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="routingNumber"
        label={t('form.routing.label')}
        hint={t('form.routing.hint')}
        error={fieldError('routingNumber')}
        inputMode="numeric"
        autoComplete="off"
        maxLength={9}
        className="tabular min-h-[52px] rounded-lg border border-neutral-300 px-3 py-2 text-2xl tracking-wider"
        required
      />
      <Continue pending={pending} />
    </form>
  );
}

/**
 * The account number, twice.
 *
 * The confirmation field is not belt-and-braces: an account number has no
 * checksum, so a typo in it is undetectable until a deposit fails weeks later
 * and nobody can say which digit moved. Typing it twice is the only check
 * available.
 *
 * Paste is not blocked. Blocking paste is a common instinct here and it makes
 * password managers useless while stopping nobody.
 */
export function AccountStep({ action }: { action: Action }) {
  const { t, state, formAction, pending, fieldError } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />
      <Field
        id="accountNumber"
        label={t('form.account.label')}
        hint={t('form.account.hint')}
        error={fieldError('accountNumber')}
        inputMode="numeric"
        autoComplete="off"
        maxLength={17}
        className="tabular min-h-[52px] rounded-lg border border-neutral-300 px-3 py-2 text-xl tracking-wider"
        required
      />
      <Field
        id="accountNumberConfirm"
        label={t('form.account.confirm')}
        error={fieldError('accountNumberConfirm')}
        inputMode="numeric"
        autoComplete="off"
        maxLength={17}
        className="tabular min-h-[52px] rounded-lg border border-neutral-300 px-3 py-2 text-xl tracking-wider"
        required
      />
      <Continue pending={pending} />
    </form>
  );
}

export function NotesStep({ action, defaultValue }: { action: Action; defaultValue?: string }) {
  const { t, state, formAction, pending } = useStep(action);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="body" className="text-sm font-medium text-neutral-900">
          {t('form.notes.label')}
        </label>
        <textarea
          id="body"
          name="body"
          rows={5}
          defaultValue={defaultValue ?? ''}
          maxLength={4000}
          className="rounded-lg border border-neutral-300 px-3 py-2 text-base"
        />
      </div>

      {/*
        Said on the screen, not just enforced in a trigger. The case this exists
        for is a worker writing "my ITIN application is still pending", and
        somebody who does not know it is private will not write it.
      */}
      <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm leading-relaxed text-blue-900">
        {t('form.notes.privacy')}
      </p>

      <Continue pending={pending} />
    </form>
  );
}

/**
 * ESIGN capture (spec section 9).
 *
 * The full text is on screen, not behind an accordion and not scrollable past —
 * the consent checkbox and the name field are below it, so reaching them means
 * moving through it. The checkbox is unchecked and the button is disabled until
 * both are satisfied, which is what makes the consent affirmative rather than
 * assumed.
 */
export function SignStep({
  action,
  documentType,
  documentVersion,
  documentLocale,
  paragraphs,
  consentLabel,
  nameLabel,
  expectedName,
}: {
  action: Action;
  documentType: string;
  documentVersion: string;
  documentLocale: string;
  paragraphs: string[];
  consentLabel: string;
  nameLabel: string;
  expectedName: string;
}) {
  const { t, state, formAction, pending, fieldError } = useStep(action);
  const [consented, setConsented] = useState(false);
  const [typedName, setTypedName] = useState('');

  const normalize = (value: string) =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  const mismatch =
    typedName.trim().length > 0 && normalize(typedName) !== normalize(expectedName);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <input type="hidden" name="documentType" value={documentType} />
      <input type="hidden" name="documentVersion" value={documentVersion} />
      <input type="hidden" name="documentLocale" value={documentLocale} />

      <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="text-sm leading-relaxed text-neutral-800">
            {paragraph}
          </p>
        ))}
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-neutral-300 p-4">
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

      <Field
        id="typedName"
        label={nameLabel}
        value={typedName}
        onChange={(event) => setTypedName(event.target.value)}
        error={fieldError('typedName')}
        autoComplete="off"
        autoCapitalize="words"
        required
      />

      {/*
        A warning, never a block (spec section 9, step 3). Someone whose legal
        name carries a character their keyboard cannot produce has still signed.
      */}
      {mismatch ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t('form.sign.nameMismatch', { expected: expectedName })}
        </p>
      ) : null}

      <SubmitButton disabled={pending || !consented || !typedName.trim()} className="w-full">
        {pending ? t('app.working') : t('form.sign.submit')}
      </SubmitButton>
    </form>
  );
}

/** A plain "continue" for screens that only need acknowledgement. */
export function AcknowledgeStep({
  action,
  label,
}: {
  action: () => Promise<FormState>;
  label?: string;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async () => action(),
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormError message={state.error ? t(state.error) : undefined} />
      <SubmitButton disabled={pending} className="w-full">
        {pending ? t('app.working') : (label ?? t('app.continue'))}
      </SubmitButton>
    </form>
  );
}
