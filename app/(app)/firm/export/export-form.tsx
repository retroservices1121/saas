'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createExportAction, type ExportState } from '../../../_actions/export';
import { Card, Field, FormError, SubmitButton } from '../../../_components/form';

export default function ExportForm({
  companies,
}: {
  companies: Array<{ id: string; legalName: string }>;
}) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ExportState, FormData>(
    createExportAction,
    {},
  );
  const [includeSensitive, setIncludeSensitive] = useState(false);

  const error = (name: string) => {
    const key = state.fieldErrors?.[name];
    return key ? t(key) : undefined;
  };

  // The password is shown once. After this render it exists nowhere — not in
  // the database, not in the audit log, and not in any message the platform
  // sends (spec section 7.7).
  if (state.result) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="border-green-300 bg-green-50">
          <h2 className="text-base font-semibold text-green-950">{t('firm.export.readyTitle')}</h2>
          <p className="mt-1 text-sm text-green-900">
            {t('firm.export.readyBody', {
              workers: state.result.workerCount,
              owners: state.result.ownerCount,
              documents: state.result.documentCount,
            })}
          </p>
        </Card>

        <Card className="border-amber-300 bg-amber-50">
          <h2 className="text-base font-semibold text-amber-950">
            {t('firm.export.passwordTitle')}
          </h2>
          <p className="mt-1 text-sm text-amber-900">{t('firm.export.passwordBody')}</p>
          <p className="tabular mt-3 select-all break-all rounded-lg bg-white px-4 py-3 text-xl font-semibold">
            {state.result.password}
          </p>
          <p className="mt-2 text-xs text-amber-900">{t('firm.export.passwordWarning')}</p>
        </Card>

        <Card>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('firm.export.file')}
              </dt>
              <dd className="tabular mt-0.5">{state.result.filename}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('firm.export.size')}
              </dt>
              <dd className="tabular mt-0.5">
                {Math.max(1, Math.round(state.result.sizeBytes / 1024))} KB
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                {t('firm.export.expires')}
              </dt>
              <dd className="tabular mt-0.5">
                {state.result.expiresAt.replace('T', ' ').slice(0, 16)}
              </dd>
            </div>
          </dl>
          <a
            href={`/api/exports/${state.result.exportId}`}
            className="mt-4 flex min-h-[44px] w-full items-center justify-center rounded-lg bg-neutral-900 px-4 text-base font-medium text-white hover:bg-neutral-800"
          >
            {t('firm.export.download')}
          </a>
        </Card>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormError message={state.error && !state.fieldErrors ? t(state.error) : undefined} />

      <Card className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t('firm.export.companies')}</h2>
        {error('companyIds') ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {error('companyIds')}
          </p>
        ) : null}
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('firm.export.companies')}</legend>
          {companies.map((company) => (
            <label key={company.id} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                name="companyIds"
                value={company.id}
                className="h-4 w-4 rounded border-neutral-400"
              />
              {company.legalName}
            </label>
          ))}
        </fieldset>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.export.range')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="from" label={t('firm.export.from')} type="date" />
          <Field id="to" label={t('firm.export.to')} type="date" />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('firm.export.sensitive')}</h2>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="includeSensitive"
            checked={includeSensitive}
            onChange={(event) => setIncludeSensitive(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-400"
          />
          <span className="text-sm leading-relaxed">{t('firm.export.sensitiveLabel')}</span>
        </label>

        {/*
          An honest warning, shown only when it applies. Every value in the
          archive is decrypted individually and each decryption writes its own
          audit row against this person and this reason.
        */}
        {includeSensitive ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950">
            {t('firm.export.sensitiveWarning')}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="reason" className="text-sm font-medium">
            {t('firm.export.reason')}
          </label>
          <p className="text-xs text-neutral-600">{t('firm.export.reasonHint')}</p>
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
        </div>
      </Card>

      <SubmitButton disabled={pending} variant={includeSensitive ? 'danger' : 'primary'}>
        {pending ? t('firm.export.building') : t('firm.export.create')}
      </SubmitButton>
    </form>
  );
}
