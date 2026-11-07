import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';
import { summary } from '@/lib/market-forecast';

export const dynamic = 'force-dynamic';

// Same gate as the rest of the forecast surface: no session, 404.
export async function GET() {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });
  try {
    return NextResponse.json(await summary());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
