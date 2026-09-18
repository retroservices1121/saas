import { NextResponse, type NextRequest } from 'next/server';
import { openInvite, INVITE_COOKIE } from '../../../lib/invites';
import { LOCALE_COOKIE } from '../../../i18n/request';

/**
 * The link itself.
 *
 * A route handler rather than a page, because its whole job is to set a cookie
 * and redirect — and a server component may not write cookies. That constraint
 * happens to produce the right shape: the token is moved out of the URL in a
 * single hop, before anything renders, so it never reaches a page that could
 * leak it through a Referer header, a browser history entry, or a screenshot.
 *
 * After this, the URL bar reads `/form/name`. That matters on a shared or
 * borrowed phone, which is the device a good number of these forms are filled
 * in on.
 */
export const dynamic = 'force-dynamic';

function clientContext(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    ip: forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  const state = await openInvite(token, clientContext(request));

  // Behind Railway's proxy, request.nextUrl.origin is the container's own
  // listener — https://localhost:8080 — not the host the worker typed. APP_URL
  // is what every other link in the system is built from, so it is what the
  // redirect is built from too; nextUrl is only the fallback for local dev.
  const origin = (process.env.APP_URL ?? request.nextUrl.origin).replace(/\/$/, '');
  const to = (path: string) => new URL(path, origin);

  if (state.status === 'unusable') return NextResponse.redirect(to('/i/expired'));
  if (state.status === 'locked') return NextResponse.redirect(to('/i/locked'));

  const destination =
    state.status === 'unverified'
      ? to('/i/verify')
      : to(`/form/${state.invite.draftStep ?? 'welcome'}`);

  const response = NextResponse.redirect(destination);

  response.cookies.set(INVITE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });

  // The subject's stored language wins over Accept-Language (spec section 12),
  // and this is the first moment the server knows whose request this is. An
  // explicit choice already made in this browser is left alone.
  if (!request.cookies.get(LOCALE_COOKIE)) {
    response.cookies.set(LOCALE_COOKIE, state.invite.preferredLocale, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    });
  }

  return response;
}
