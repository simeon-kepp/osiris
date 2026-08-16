// Auth for DINGIR's proprietary surfaces (the reasoning panel and everything
// under /api/reasoning). Deliberately hand-rolled rather than pulled from an
// auth library: one provider, one allowlist, no database, no user records --
// a dependency would be more code than this file, and every step here is
// inspectable, which is the point of a whitebox system.
//
// Deny-by-default is the load-bearing property. An unconfigured deploy (no
// DINGIR_ALLOWED_LOGINS, no GITHUB_CLIENT_ID) grants nobody access, so the
// public demo on fly.io is locked without needing anything configured there.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** GitHub logins allowed past the gate, from a comma-separated env var. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Exact, case-insensitive membership. Compares the GitHub *login* rather than
 * the email: emails can be changed and multiple addresses attached, the login
 * is the stable identifier for an account.
 */
export function isAllowed(login: string | undefined | null, allowlist: string[]): boolean {
  if (!login) return false;
  return allowlist.includes(login.trim().toLowerCase());
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * `base64url(value).signature`. The value is encoded rather than embedded raw
 * so that a value containing a dot can't be confused for the separator.
 */
export function sign(value: string, secret: string): string {
  const payload = b64url(Buffer.from(value, 'utf8'));
  return `${payload}.${hmac(payload, secret)}`;
}

/** Returns the original value, or null if the signature doesn't hold. */
export function verify(signed: string, secret: string): string | null {
  if (!signed) return null;
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expected = hmac(payload, secret);
  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Signed `{login, exp}`. Stateless, so signing out is just dropping the cookie. */
export function encodeSession(login: string, secret: string, expiresAt: number): string {
  return sign(JSON.stringify({ login, exp: expiresAt }), secret);
}

/** Returns the login, or null if the token is invalid, malformed or expired. */
export function decodeSession(token: string, secret: string, now: number): string | null {
  const raw = verify(token, secret);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { login, exp } = parsed as { login?: unknown; exp?: unknown };
  if (typeof login !== 'string' || !login) return null;
  if (typeof exp !== 'number' || exp <= now) return null;
  return login;
}

export const SESSION_COOKIE = 'dingir_session';
export const STATE_COOKIE = 'dingir_oauth_state';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
