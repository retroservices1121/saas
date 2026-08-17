import { NextResponse, type NextRequest } from 'next/server';
import { getStorage, verifyStorageUrl } from '../../../lib/services/storage';

/**
 * Serves objects for the `local` storage provider.
 *
 * This is the development stand-in for an S3 presigned URL, and it enforces the
 * same two properties: the URL is signed, and it expires. Without both, the
 * filesystem provider would be a directory listing of voided checks reachable
 * by anyone who guessed a key.
 *
 * In production `STORAGE_PROVIDER=s3` issues real presigned URLs and this route
 * is never reached — it refuses to serve anything in that configuration rather
 * than quietly becoming a second, unsigned way in.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if ((process.env.STORAGE_PROVIDER ?? 'local') !== 'local') {
    return new NextResponse(null, { status: 404 });
  }

  const key = request.nextUrl.searchParams.get('key');
  const expires = Number(request.nextUrl.searchParams.get('expires'));
  const signature = request.nextUrl.searchParams.get('sig');
  const method = request.nextUrl.searchParams.get('method') === 'PUT' ? 'PUT' : 'GET';

  if (!key || !signature || method !== 'GET') return new NextResponse(null, { status: 404 });
  if (!verifyStorageUrl(key, expires, 'GET', signature)) {
    // Expired and forged are the same answer.
    return new NextResponse(null, { status: 404 });
  }

  try {
    const bytes = await getStorage().get(key);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        // Always as an attachment, and always octet-stream. Serving a
        // worker-uploaded file inline with a content type the uploader chose is
        // how a stored XSS reaches a firm admin's session.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
