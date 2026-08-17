import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '../../../../lib/auth/current';
import { getCurrentSubject } from '../../../../lib/auth/invite-session';
import { readDocument } from '../../../../lib/documents';

/**
 * Opens one document.
 *
 * The bytes are streamed through the application, not redirected to a presigned
 * URL. They have to be — the stored object is encrypted with the owning
 * company's data key, so a presigned URL would hand out ciphertext. The
 * consequence is the one worth having anyway: every read is an authenticated
 * request that writes a DOCUMENT_VIEWED row, and revoking a session revokes the
 * read with it, which a bearer URL cannot do before it expires.
 *
 * Authorization is the row read inside `readDocument`, under the caller's own
 * scope. A FIRM_ONLY document does not exist for a company session, so it
 * returns null and this returns 404 — the same answer as a document that was
 * never there, which is the same answer it should be.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // Either a staff session or a live invite session. A worker looking at the
  // voided check they uploaded a moment ago is a legitimate reader of it.
  const staff = await getCurrentStaff();
  const session = staff?.session ?? (await getCurrentSubject())?.session;
  if (!session) return new NextResponse(null, { status: 404 });

  const document = await readDocument(session, id);
  if (!document) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(document.bytes), {
    headers: {
      // Always an attachment, and never the uploader's declared type as the
      // response type: serving a worker-uploaded file inline under a
      // content type they chose is how a stored XSS reaches a firm admin.
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${document.docType.toLowerCase()}-${id.slice(0, 8)}"`,
      'Content-Length': String(document.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}
