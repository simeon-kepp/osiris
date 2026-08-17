import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';

// Proxies to bi_api.py's /reasoning/mycelium (DINGIR's trained GCN
// node-embedding PCA + cosine-kNN endpoint -- see kindom/execution/bi_api.py).
// Runs server-side so the demo API key never reaches the browser.
//
// Gated: this exposes the trained evidence-graph embedding space, which is
// proprietary. Without a session it answers 404 rather than 403 -- a 403 would
// confirm the endpoint exists to anyone poking at the public demo.
//
// bi_api.py itself binds 127.0.0.1 only, so it is unreachable from the network
// regardless of what this route does. This gate is the second layer, not the
// only one. DINGIR_API_URL points at it on the same machine as `next dev`.

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

export async function GET(req: Request) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  const { searchParams } = new URL(req.url);
  const node = (searchParams.get('node') || '').trim();
  const k = searchParams.get('k') || '40';
  if (!node) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${DINGIR_API_URL}/reasoning/mycelium?node=${encodeURIComponent(node)}&k=${encodeURIComponent(k)}`,
      { headers: { 'X-API-Key': DINGIR_API_KEY }, signal: AbortSignal.timeout(330_000) } // was 180s, shorter than a measured 238.1s cold retrain -- see reasoning/graph/route.ts
    );
    const body = await upstream.json();
    return NextResponse.json(body, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: `DINGIR reasoning API unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
