import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';

// The whole DINGIR network in one response: every node with its position in the
// learned embedding space, every edge with its provenance class. Proxies
// bi_api.py's /reasoning/graph (see kindom/execution/bi_api.py).
//
// /reasoning/mycelium answers "what is near this node" and caps at 500
// neighbours, so it can never show the network itself. This can.
//
// Gated identically to the other reasoning routes: no session means 404, not
// 403, because a 403 confirms the endpoint exists to anyone probing the public
// demo. bi_api.py binds 127.0.0.1 only, so this proxy is the second layer, not
// the only one.
//
// Cached in module scope: the payload is derived from a model that is trained
// by a batch job, not per request, so re-fetching it on every panel open would
// only add latency. A process restart is the invalidation, which matches how
// often the graph actually changes.

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

let cache: { body: unknown; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function GET(req: Request) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  const fresh = new URL(req.url).searchParams.get('fresh') === '1';
  if (!fresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  try {
    // Generous timeout: a cold bi_api trains the GCN on the first
    // /reasoning/* request before it can answer anything.
    const upstream = await fetch(`${DINGIR_API_URL}/reasoning/graph`, {
      headers: { 'X-API-Key': DINGIR_API_KEY },
      signal: AbortSignal.timeout(180_000),
    });
    const body = await upstream.json();
    if (upstream.ok) cache = { body, fetchedAt: Date.now() };
    return NextResponse.json(body, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: `DINGIR reasoning API unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
