import { NextResponse } from 'next/server';

/**
 * The health check Railway polls.
 *
 * Deliberately not `/`, which redirects a signed-in user and would report a
 * broken database as healthy — it renders without touching one. This does the
 * cheapest query that proves the whole chain: the pool is up, `app_user` can
 * authenticate, and RLS is on. If any of that is wrong the deploy should not
 * take traffic.
 *
 * The body says nothing beyond ok or not. A health endpoint that reports a
 * version, a hostname, or a database error message is reconnaissance served
 * without authentication.
 */
import { anonymousSession } from '../../../lib/auth/session';
import { withScope } from '../../../lib/db/scoped';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await withScope(anonymousSession(), async (db) => db.execute('select 1'));
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[health] database check failed', err);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
