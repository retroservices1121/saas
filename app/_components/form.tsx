/**
 * Form primitives, shared by every screen in the application.
 *
 * They exist to make three things impossible to forget rather than to save
 * typing:
 *
 *   every input has a real <label> bound by id, so a screen reader announces
 *   it and a tap on the text focuses the field;
 *
 *   every error is announced (`role="alert"`) and referenced by
 *   `aria-describedby`, so a validation failure is not a silent red outline;
 *
 *   every control is at least 44px tall, which is the smallest target most
 *   people can hit reliably on a phone held one-handed.
 *
 * Labels arrive already translated. Nothing here embeds an English string.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm font-medium text-red-700">
      {message}
    </p>
  );
}

export function FieldWarning({ message }: { message?: string | undefined }) {
  if (!message) return null;
  // Warnings are not errors and must not look like them: the spec is explicit
  // that a tax-ID type mismatch asks a question rather than blocking.
  return (
    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function Field({ id, label, hint, error, ...input }: FieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-900">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-neutral-600">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        name={input.name ?? id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`min-h-[44px] rounded-lg border px-3 py-2 text-base outline-none ${
          error ? 'border-red-600 bg-red-50' : 'border-neutral-300 bg-white'
        }`}
        {...input}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

export function SelectField({
  id,
  label,
  hint,
  error,
  children,
  ...select
}: SelectFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-900">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-neutral-600">
          {hint}
        </p>
      ) : null}
      <select
        id={id}
        name={select.name ?? id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`min-h-[44px] rounded-lg border bg-white px-3 py-2 text-base ${
          error ? 'border-red-600' : 'border-neutral-300'
        }`}
        {...select}
      >
        {children}
      </select>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function SubmitButton({
  children,
  variant = 'primary',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-800',
    secondary: 'border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50',
    danger: 'bg-red-700 text-white hover:bg-red-800',
  }[variant];

  return (
    <button
      type="submit"
      className={`min-h-[44px] rounded-lg px-4 py-2.5 text-base font-medium transition disabled:opacity-50 ${styles}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function FormError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3">
      <p className="text-sm font-medium text-red-900">{message}</p>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white p-5 ${className}`}>
      {children}
    </div>
  );
}

/**
 * The status chip a company user sees instead of any actual data (spec section
 * 2). Deliberately the only worker- or owner-level detail a company list view
 * carries.
 */
export function StatusChip({ status, label }: { status: string; label: string }) {
  const tone =
    {
      INVITED: 'bg-neutral-100 text-neutral-700',
      IN_PROGRESS: 'bg-blue-50 text-blue-800',
      SUBMITTED: 'bg-green-50 text-green-800',
      COMPLETE: 'bg-green-50 text-green-800',
      NEEDS_ATTENTION: 'bg-amber-50 text-amber-900',
      ARCHIVED: 'bg-neutral-100 text-neutral-500',
      PENDING: 'bg-neutral-100 text-neutral-700',
      IN_REVIEW: 'bg-blue-50 text-blue-800',
    }[status] ?? 'bg-neutral-100 text-neutral-700';

  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}
