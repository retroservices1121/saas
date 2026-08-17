'use server';

/**
 * Platform administration actions.
 *
 * Creating a firm is the one operation with no tenant above it — there is no
 * firm session that could have performed it — which is exactly why the role
 * exists and why it holds nothing else.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requirePlatform } from '../../lib/auth/current';
import { createFirm, setFirmStatus } from '../../lib/db/queries/platform';
import { sendStaffSetupEmail } from '../../lib/notifications';
import { emailSchema } from '../../lib/validation/forms';

export interface PlatformState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const createFirmSchema = z.object({
  name: z.string().trim().min(1, { message: 'validation.firmName.required' }).max(200),
  contactEmail: emailSchema,
  adminName: z.string().trim().min(1, { message: 'validation.adminName.required' }).max(200),
  adminEmail: emailSchema,
});

export async function createFirmAction(
  _previous: PlatformState,
  formData: FormData,
): Promise<PlatformState> {
  const { session } = await requirePlatform();

  const parsed = createFirmSchema.safeParse({
    name: formData.get('name'),
    contactEmail: formData.get('contactEmail'),
    adminName: formData.get('adminName'),
    adminEmail: formData.get('adminEmail'),
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      if (!(key in errors)) errors[key] = issue.message;
    }
    return { fieldErrors: errors, error: 'platform.errors.check' };
  }

  const created = await createFirm(session, parsed.data);

  // After the commit. An email carrying a live setup link for a firm that
  // failed to create is worse than a firm with no email sent.
  await sendStaffSetupEmail({
    to: parsed.data.adminEmail,
    locale: 'en',
    name: parsed.data.adminName,
    companyName: parsed.data.name,
    url: `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/setup/${created.setupToken}`,
  });

  revalidatePath('/platform');
  redirect('/platform?created=1');
}

export async function setFirmStatusAction(
  firmId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  const { session } = await requirePlatform();
  await setFirmStatus(session, firmId, status);
  revalidatePath('/platform');
}
