'use client';

/**
 * Reveal one field of one record (spec section 7.6).
 *
 * The shape of this component is the control. A firm user clicks reveal on a
 * single field, re-enters a TOTP code, and types a reason of at least ten
 * characters. The audit row is written on the server before the plaintext is
 * produced. The value renders for thirty seconds and then re-masks itself.
 *
 * The countdown is deliberately visible and deliberately not pausable. It is
 * not a timeout error — it is the product saying that a tax ID on a screen is a
 * tax ID anyone walking past can read, and that thirty seconds is long enough
 * to write one down and short enough not to leave one up over lunch.
 *
 * The revealed value is never written to component state that outlives the
 * timer, never copied to the clipboard automatically, and never re-fetched
 * without another code and another reason.
 */
import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { revealAction, type RevealResult } from '../../../_actions/firm';
import { Field, FormError, SubmitButton } from '../../../_components/form';

const VISIBLE_MS = 30_000;

export type RevealField = 'tin' | 'routing' | 'account';
export type RevealRecordType = 'WORKER_RECORD' | 'OWNER' | 'COMPANY';

export default function Reveal({
  field,
  recordType,
  recordId,
  masked,
  label,
}: {
  field: RevealField;
  recordType: RevealRecordType;
  recordId: string;
  masked: string;
  label: string;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<RevealResult, FormData>(revealAction, {});
  const [remaining, setRemaining] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // A successful reveal starts the clock. The value lives in state only for as
  // long as it is on screen; when the timer ends it is replaced with null
  // rather than merely hidden with CSS.
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

  useEffect(() => {
    if (open) dialogRef.current?.querySelector('input')?.focus();
  }, [open]);

  if (shown) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="tabular rounded-md bg-amber-50 px-2 py-1 text-base font-semibold text-amber-950">
          {shown}
        </span>
        <span
          className="tabular text-xs font-medium text-amber-800"
          role="timer"
          aria-live="off"
        >
          {t('firm.reveal.hiding', { seconds: remaining })}
        </span>
        <button
          type="button"
          onClick={() => setShown(null)}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50"
        >
          {t('firm.reveal.hideNow')}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular text-neutral-900">{masked}</span>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-50"
      >
        {open ? t('app.cancel') : t('firm.reveal.button')}
      </button>

      {open ? (
        <div
          ref={dialogRef}
          role="group"
          aria-label={t('firm.reveal.title', { field: label })}
          className="mt-2 w-full max-w-sm rounded-xl border border-neutral-300 bg-white p-4 shadow-sm"
        >
          <form action={formAction} className="flex flex-col gap-3">
            <p className="text-sm font-medium">{t('firm.reveal.title', { field: label })}</p>

            <input type="hidden" name="field" value={field} />
            <input type="hidden" name="recordType" value={recordType} />
            <input type="hidden" name="recordId" value={recordId} />

            <FormError message={state.error ? t(state.error) : undefined} />

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`reason-${recordId}-${field}`} className="text-sm font-medium">
                {t('firm.reveal.reason')}
              </label>
              <p className="text-xs text-neutral-600">{t('firm.reveal.reasonHint')}</p>
              <textarea
                id={`reason-${recordId}-${field}`}
                name="reason"
                rows={2}
                minLength={10}
                maxLength={500}
                required
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              />
            </div>

            <Field
              id={`totp-${recordId}-${field}`}
              name="totpCode"
              label={t('firm.reveal.code')}
              hint={t('firm.reveal.codeHint')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className="tabular min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-lg tracking-widest"
            />

            <SubmitButton disabled={pending}>
              {pending ? t('app.working') : t('firm.reveal.confirm')}
            </SubmitButton>

            <p className="text-xs leading-relaxed text-neutral-500">{t('firm.reveal.notice')}</p>
          </form>
        </div>
      ) : null}
    </span>
  );
}
