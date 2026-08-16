import { NextResponse } from 'next/server';
import { authConfigured, currentLogin } from '@/lib/dingirSessionServer';

// What the client asks to decide whether to render DINGIR's gated controls.
// Deliberately returns no error detail: on an unconfigured deploy this is
// indistinguishable from a logged-out one.

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ login: await currentLogin(), authAvailable: authConfigured() });
}
