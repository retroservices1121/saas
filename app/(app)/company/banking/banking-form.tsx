'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  revealCompanyBankAction,
  saveBankingAction,
  type ActionResult,
  type CompanyRevealResult,
} from '../../../_actions/company';
import { Card, Field, FormError, SubmitButton } from '../../../_components/form';
import { maskAccount } from '../../../../lib/forms/wizard';

const VISIBLE_MS = 30_000;

/**
 * The company's own bank account.
 *
 * Masked in the company's own UI with a reveal available to COMPANY_ADMIN only
 * (spec section 4). This account is not covered by the employer-cannot-see rule
 * — the company owns it — but it is stored encrypted like everything else and
 * revealing it still costs a typed reason and still writes a REVEAL_BANK row.
 */
export default function BankingForm({
  bankName,
  routingLast4,
  accountLast4,
}: {
  bankName: string;
  routingLast4: string | null;
  accountLast4: string | null;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    saveBankingAction,
    {},
  );

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  const onFile = Boolean(routingLast4 && accountLast4);

  return (
    <div className="flex flex-col gap-5">
      {onFile ? (
        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">{t('company.banking.onFile')}</h2>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('company.banking.bankName')}
              </dt>
              <dd className="mt-0.5 text-sm">{bankName || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('company.banking.routing')}
              </dt>
              <dd className="mt-1">
                <BankReveal field="routing" masked={maskAccount(routingLast4!)} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('company.banking.account')}
              </dt>
              <dd className="mt-1">
                <BankReveal field="account" masked={maskAccount(accountLast4!)} />
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

        <Card className="flex flex-col gap-4">
          <h2 className="text-base font-semibold">
            {onFile ? t('company.banking.replace') : t('company.banking.add')}
          </h2>
          <p className="text-sm text-neutral-600">{t('company.banking.hint')}</p>

          <Field
            id="bankName"
            label={t('company.banking.bankName')}
            defaultValue={bankName}
            error={error('bankName')}
            required
          />
          <Field
            id="routingNumber"
            label={t('company.banking.routing')}
            hint={t('company.banking.routingHint')}
            error={error('routingNumber')}
            inputMode="numeric"
            maxLength={9}
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-lg tracking-wider"
            required
          />
          <Field
            id="accountNumber"
            label={t('company.banking.account')}
            error={error('accountNumber')}
            inputMode="numeric"
            maxLength={17}
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-lg tracking-wider"
            required
          />
          <Field
            id="accountNumberConfirm"
            label={t('company.banking.accountConfirm')}
            error={error('accountNumberConfirm')}
            inputMode="numeric"
            maxLength={17}
            className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-lg tracking-wider"
            required
          />
        </Card>

        <SubmitButton disabled={pending}>
          {pending ? t('app.working') : t('app.save')}
        </SubmitButton>
      </form>
    </div>
  );
}

function BankReveal({ field, masked }: { field: 'routing' | 'account'; masked: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<CompanyRevealResult, FormData>(
    revealCompanyBankAction,
    {},
  );
  const [shown, setShown] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!state.value) return;
    setShown(state.value);
    setOpen(false);
    setRemaining(VISIBLE_MS / 1000);

    const interval = setInterval(() => {
      setRemaining((seconds) => {
        if (seconds <= 1) {
          clearInterval(interval);
          setShown(null);
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [state.value]);

  if (shown) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="tabular rounded-md bg-amber-50 px-2 py-1 text-base font-semibold text-amber-950">
          {shown}
        </span>
        <span className="tabular text-xs font-medium text-amber-800" role="timer">
          {t('firm.reveal.hiding', { seconds: remaining })}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular text-sm">{masked}</span>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50"
      >
        {open ? t('app.cancel') : t('firm.reveal.button')}
      </button>

      {open ? (
        <form action={formAction} className="mt-2 flex w-full max-w-sm flex-col gap-2">
          <input type="hidden" name="field" value={field} />
          <FormError message={state.error ? t(state.error) : undefined} />
          <label htmlFor={`reason-${field}`} className="text-xs font-medium">
            {t('firm.reveal.reason')}
          </label>
          <textarea
            id={`reason-${field}`}
            name="reason"
            rows={2}
            minLength={10}
            required
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
          <SubmitButton disabled={pending} variant="secondary">
            {pending ? t('app.working') : t('firm.reveal.confirm')}
          </SubmitButton>
        </form>
      ) : null}
    </span>
  );
}
