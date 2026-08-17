import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentStaff } from '../../../../lib/auth/current';
import { getCurrentSubject } from '../../../../lib/auth/invite-session';
import { getDocumentUrl } from '../../../../lib/documents';

/**
 * Opens one document.
 *
 * The authorization is the read itself. `getDocumentUrl` fetches the row under
 * the caller's own scope, so a FIRM_ONLY document simply does not exist for a
 * company session — RLS removes it before any code here could check a
 * `sensitivity` column, which is the right order: checking a value you could
 * only have obtained by being allowed to see it proves nothing.
 *
 * A 302 to a short-lived signed URL rather than streaming the bytes. Unlike the
 * export, these are individual files whose disclosure is already recorded by
 * the DOCUMENT_VIEWED row written when the URL is issued, and redirecting keeps
 * large photos off the application's event loop.
 */
export const dynamic = 'force-dynamic';

const URL_TTL_SECONDS = 120;

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

  const document = await getDocumentUrl(session, id, URL_TTL_SECONDS);

  // Out of scope, deleted, and never existed are one answer.
  if (!document) return new NextResponse(null, { status: 404 });

  return NextResponse.redirect(document.url, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' },
  });
}
