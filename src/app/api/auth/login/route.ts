import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { STATE_COOKIE, sign } from '@/lib/dingirAuth';
import { authConfigured } from '@/lib/dingirSessionServer';

// Step 1 of the GitHub OAuth flow: bounce the browser to GitHub with a signed
// one-time state value. The state is what stops a third party from feeding us
// a callback we never initiated (CSRF on the login endpoint).

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!authConfigured()) {
    // Nothing to log into on an unconfigured deploy -- don't advertise the flow.
    return new NextResponse(null, { status: 404 });
  }

  const nonce = randomBytes(16).toString('base64url');
  const state = sign(nonce, process.env.DINGIR_AUTH_SECRET!);
  const origin = process.env.DINGIR_BASE_URL || new URL(req.url).origin;

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set('redirect_uri', `${origin}/api/auth/callback/github`);
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: 600,
  });
  return res;
}
