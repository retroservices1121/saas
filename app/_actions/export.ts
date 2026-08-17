'use server';

/**
 * Export (spec section 7.7). FIRM_ADMIN only, enforced here and again by the
 * RLS policy on `exports`.
 */
import { requireFirmAdmin } from '../../lib/auth/current';
import { createExport } from '../../lib/export';
import { exportSchema } from '../../lib/validation/forms';

export interface ExportState {
  error?: string;
  fieldErrors?: Record<string, string>;
  result?: {
    exportId: string;
    /**
     * Shown once and never again. It is returned to the browser, rendered, and
     * not persisted anywhere — not in the exports row, not in the audit log,
     * and deliberately not in an email or an SMS.
     */
    password: string;
    filename: string;
    sizeBytes: number;
    expiresAt: string;
    workerCount: number;
    ownerCount: number;
    documentCount: number;
  };
}

export async function createExportAction(
  _previous: ExportState,
  formData: FormData,
): Promise<ExportState> {
  const { session } = await requireFirmAdmin();

  const parsed = exportSchema.safeParse({
    companyIds: formData.getAll('companyIds').map(String),
    from: formData.get('from') || null,
    to: formData.get('to') || null,
    includeSensitive: formData.get('includeSensitive') === 'on',
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_');
      if (!(key in errors)) errors[key] = issue.message;
    }
    return { fieldErrors: errors, error: 'firm.errors.check' };
  }

  try {
    const result = await createExport(session, parsed.data);
    return {
      result: {
        exportId: result.exportId,
        password: result.password,
        filename: result.filename,
        sizeBytes: result.sizeBytes,
        expiresAt: result.expiresAt.toISOString(),
        workerCount: result.workerCount,
        ownerCount: result.ownerCount,
        documentCount: result.documentCount,
      },
    };
  } catch (err) {
    console.error('[export] failed', err);
    return { error: 'firm.export.failed' };
  }
}
