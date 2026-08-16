// Server-side session read for DINGIR's gated surfaces. Split out from
// dingirAuth.ts so that file stays pure and unit-testable -- next/headers
// only works inside a request scope.

import { cookies } from 'next/headers';
import { SESSION_COOKIE, decodeSession, isAllowed, parseAllowlist } from './dingirAuth';

/** True only when GitHub OAuth is fully configured. Absent config => gate shut. */
export function authConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.DINGIR_AUTH_SECRET &&
    process.env.DINGIR_ALLOWED_LOGINS
  );
}

/**
 * The signed-in GitHub login, or null. Re-checks the allowlist on every call
 * rather than trusting the cookie alone, so removing someone from
 * DINGIR_ALLOWED_LOGINS locks them out immediately instead of at session expiry.
 */
export async function currentLogin(): Promise<string | null> {
  if (!authConfigured()) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const login = decodeSession(token, process.env.DINGIR_AUTH_SECRET!, Date.now());
  if (!login) return null;
  return isAllowed(login, parseAllowlist(process.env.DINGIR_ALLOWED_LOGINS)) ? login : null;
}
