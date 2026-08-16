import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STATE_COOKIE,
  encodeSession,
  isAllowed,
  parseAllowlist,
  verify,
} from '@/lib/dingirAuth';
import { authConfigured } from '@/lib/dingirSessionServer';

// Step 2: GitHub sends the browser back here with a short-lived code. We check
// the state matches the one we issued, trade the code for a token, read the
// login, and only then mint a session -- being a valid GitHub user is not
// enough, the login has to be on DINGIR_ALLOWED_LOGINS.

export const dynamic = 'force-dynamic';

function deny(origin: string, reason: string) {
  const url = new URL('/', origin);
  url.searchParams.set('dingir_auth', reason);
  const res = NextResponse.redirect(url.toString());
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: Request) {
  if (!authConfigured()) return new NextResponse(null, { status: 404 });

  const url = new URL(req.url);
  const origin = process.env.DINGIR_BASE_URL || url.origin;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const cookieState = req.headers
    .get('cookie')
    ?.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);

  if (!code || !state || !cookieState) return deny(origin, 'missing');

  // Both halves have to hold: the state must carry our signature, and it must
  // be the exact one this browser was handed.
  if (!verify(state, process.env.DINGIR_AUTH_SECRET!)) return deny(origin, 'state');
  const a = Buffer.from(state);
  const b = Buffer.from(cookieState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return deny(origin, 'state');

  let login: string | undefined;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${origin}/api/auth/callback/github`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const token = (await tokenRes.json())?.access_token;
    if (!token) return deny(origin, 'token');

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    login = (await userRes.json())?.login;
  } catch {
    return deny(origin, 'upstream');
  }

  if (!isAllowed(login, parseAllowlist(process.env.DINGIR_ALLOWED_LOGINS))) {
    return deny(origin, 'denied');
  }

  const res = NextResponse.redirect(new URL('/', origin).toString());
  res.cookies.set(SESSION_COOKIE, encodeSession(login!, process.env.DINGIR_AUTH_SECRET!, Date.now() + SESSION_TTL_MS), {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  res.cookies.delete(STATE_COOKIE);
  return res;
}
