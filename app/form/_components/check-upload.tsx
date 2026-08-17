'use client';

import { useActionState, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { skipCheckAction, uploadVoidedCheckAction, type FormState } from '../../_actions/form';
import { FormError, SubmitButton } from '../../_components/form';

/** Spec section 8, screen 12: client-side downscale to 2000px. */
const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;

/**
 * Photographing a voided check.
 *
 * `capture="environment"` opens the rear camera directly on a phone rather than
 * the photo library, which is what someone holding a check in front of them
 * expects.
 *
 * The downscale happens here, before anything is sent. A current phone camera
 * produces four to six megabytes, and the person doing this is often on a
 * cellular connection in a truck. Re-encoding through a canvas also drops the
 * EXIF block — which on a phone photo carries GPS coordinates. A worker
 * photographing a check on their kitchen table should not be handing over their
 * home address as a side effect of doing what was asked.
 */
export default function CheckUpload() {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    uploadVoidedCheckAction,
    {},
  );
  const [, skipAction, skipping] = useActionState<FormState, FormData>(
    async () => skipCheckAction(),
    {},
  );

  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function downscale(file: File): Promise<File> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));

    // Already small enough. Re-encoding anyway would still strip EXIF, but it
    // would also degrade an image somebody may need to read digits off.
    if (scale === 1 && file.size < 1_500_000) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) return file;

    return new File([blob], 'voided-check.jpg', { type: 'image/jpeg' });
  }

  async function onSelect(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    setWorking(true);
    try {
      const resized = await downscale(file);
      setPreview(URL.createObjectURL(resized));

      // Replace the input's file list with the downscaled version, so the form
      // submits that and the original never leaves the device.
      const transfer = new DataTransfer();
      transfer.items.add(resized);
      if (inputRef.current) inputRef.current.files = transfer.files;
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form ref={formRef} action={formAction} className="flex flex-col gap-4">
        <FormError message={state.error ? t(state.error) : undefined} />

        <label
          htmlFor="file"
          className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 px-4 py-6 text-center hover:border-neutral-400"
        >
          <span className="text-base font-medium">{t('form.check.take')}</span>
          <span className="text-sm text-neutral-600">{t('form.check.takeHint')}</span>
        </label>

        <input
          ref={inputRef}
          id="file"
          name="file"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onSelect}
          className="sr-only"
        />

        {preview ? (
          <div className="flex flex-col gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt={t('form.check.preview')}
              className="max-h-64 w-full rounded-lg border border-neutral-200 object-contain"
            />
            <SubmitButton disabled={pending || working} className="w-full">
              {pending ? t('app.working') : t('form.check.use')}
            </SubmitButton>
          </div>
        ) : null}

        {working ? <p className="text-sm text-neutral-600">{t('app.working')}</p> : null}
      </form>

      <form action={skipAction}>
        <SubmitButton variant="secondary" disabled={skipping} className="w-full">
          {skipping ? t('app.working') : t('form.check.skip')}
        </SubmitButton>
      </form>
    </div>
  );
}
