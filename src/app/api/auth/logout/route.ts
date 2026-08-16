import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/dingirAuth';

// Sessions are stateless signed cookies, so signing out is just dropping it.

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL('/', process.env.DINGIR_BASE_URL || new URL(req.url).origin).toString(), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
