'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { uploadCompanyDocumentAction, type ActionResult } from '../../../_actions/company';
import { Card, Field, FormError, SelectField, SubmitButton } from '../../../_components/form';

/**
 * Company document upload.
 *
 * The type list is deliberately short. A company uploads its articles of
 * incorporation, its workers' comp policy or exemption, and its disability
 * policy. Everything else in the doc_type enum — voided checks, ID documents,
 * W-4s — is FIRM_ONLY by rule and by trigger, so offering it here would create
 * a control that appears to work and then hides the file from the person who
 * just uploaded it.
 */
const COMPANY_DOC_TYPES = [
  'ARTICLES_OF_INCORPORATION',
  'WC_POLICY',
  'WC_EXEMPTION',
  'DISABILITY_POLICY',
  'OTHER',
] as const;

export default function UploadForm() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    uploadCompanyDocumentAction,
    {},
  );

  return (
    <Card>
      <form action={formAction} className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('company.documents.upload')}</h2>

        <FormError message={state.error ? t(state.error) : undefined} />
        {state.ok ? (
          <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">
            {t('company.documents.uploadedOk')}
          </p>
        ) : null}

        <SelectField id="docType" label={t('company.documents.type')} defaultValue="ARTICLES_OF_INCORPORATION">
          {COMPANY_DOC_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`docType.${type}`)}
            </option>
          ))}
        </SelectField>

        <Field id="label" label={t('company.documents.label')} hint={t('company.documents.labelHint')} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="file" className="text-sm font-medium text-neutral-900">
            {t('company.documents.file')}
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
            required
            className="min-h-[44px] rounded-lg border border-neutral-300 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="text-xs text-neutral-500">{t('company.documents.fileHint')}</p>
        </div>

        <SubmitButton disabled={pending} variant="secondary">
          {pending ? t('app.working') : t('company.documents.uploadSubmit')}
        </SubmitButton>
      </form>
    </Card>
  );
}
