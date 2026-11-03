import { NextResponse } from 'next/server';

// Can THIS server process reach GitHub? The OAuth callback trades its code at
// github.com from inside the Next process, so a shell curl on the same host is
// not proof. Observed 2026-10-31: next-server had run for 5 days, every outbound
// fetch timed out, the host itself was online, and sign-in redirected to
// /?dingir_auth=upstream. The launcher watchdog polls this route and restarts
// web when it fails while the host still gets through.
// Any HTTP answer counts as reachable; only a network error or timeout is 503.

export const dynamic = 'force-dynamic';

export async function GET() {
  const t0 = Date.now();
  try {
    const r = await fetch('https://github.com/', {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    return NextResponse.json({ ok: true, status: r.status, ms: Date.now() - t0 });
  } catch (e) {
    const err = e as { cause?: { code?: string }; message?: string };
    return NextResponse.json(
      { ok: false, error: err.cause?.code || err.message || String(e), ms: Date.now() - t0 },
      { status: 503 },
    );
  }
}
