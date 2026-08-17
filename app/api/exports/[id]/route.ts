import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireFirmAdmin } from '../../../../lib/auth/current';
import { withScope, schema } from '../../../../lib/db/scoped';
import { audit } from '../../../../lib/audit';
import { getStorage } from '../../../../lib/services/storage';

/**
 * Downloads a finished export.
 *
 * The bytes are streamed through the application rather than by handing out a
 * presigned URL. A presigned URL for an archive of tax IDs is a bearer token
 * for that archive: it survives being pasted into a chat, it works without a
 * session, and it cannot be revoked before it expires. Serving it here means
 * every download is an authenticated request that writes an audit row, and
 * revoking the firm admin's session revokes the download with it.
 *
 * The archive is AES-256 encrypted with a password shown once at creation, so
 * even these bytes are not readable on their own.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const { session } = await requireFirmAdmin();

  const record = await withScope(session, async (db) => {
    const rows = await db
      .select({
        id: schema.dataExports.id,
        companyId: schema.dataExports.companyId,
        s3Key: schema.dataExports.s3Key,
        expiresAt: schema.dataExports.expiresAt,
        deletedAt: schema.dataExports.deletedAt,
        reason: schema.dataExports.reason,
      })
      .from(schema.dataExports)
      .where(eq(schema.dataExports.id, id))
      .limit(1);
    return rows[0] ?? null;
  });

  // Out of scope, already swept, or past its 24 hours — one answer for all
  // three, because they are the same answer to whoever is asking.
  if (!record?.s3Key || record.deletedAt || record.expiresAt <= new Date()) {
    return new NextResponse(null, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getStorage().get(record.s3Key);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  await withScope(session, async (db) => {
    await db
      .update(schema.dataExports)
      .set({ downloadedAt: new Date() })
      .where(eq(schema.dataExports.id, id));

    await audit(db, session, {
      action: 'EXPORT_DOWNLOADED',
      companyId: record.companyId,
      targetType: 'exports',
      targetId: id,
      reason: record.reason,
      metadata: { sizeBytes: bytes.length },
    });
  });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="export-${id.slice(0, 8)}.zip"`,
      'Content-Length': String(bytes.length),
      // Never cached by anything, anywhere.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}
