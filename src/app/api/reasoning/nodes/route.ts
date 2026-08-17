import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';

// The node index behind the reasoning panel's search box. Without this the
// panel needs an exact id typed from memory ("APP:Pokemon GO"), which is
// unusable against 1026 nodes.
//
// bi_api.py's /reasoning/embeddings is the only listing endpoint it has, and
// it ships all 64 dims per node (~1MB). We fetch it once, strip the vectors,
// and cache the ids in module scope -- the graph is rebuilt by a batch job,
// not per request, so a process-lifetime cache is the right granularity.

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

type NodeRef = { id: string; type: string };
let cache: NodeRef[] | null = null;

async function loadNodes(): Promise<NodeRef[]> {
  if (cache) return cache;
  const upstream = await fetch(`${DINGIR_API_URL}/reasoning/embeddings?limit=100000`, {
    headers: { 'X-API-Key': DINGIR_API_KEY },
    signal: AbortSignal.timeout(330_000), // was 180s, shorter than a measured 238.1s cold retrain -- see reasoning/graph/route.ts
  });
  if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
  const body = await upstream.json();
  const nodes: NodeRef[] = (body?.nodes ?? []).map((n: { id: string; type: string }) => ({
    id: n.id,
    type: n.type,
  }));
  cache = nodes;
  return nodes;
}

export async function GET(req: Request) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();

  try {
    const nodes = await loadNodes();
    const matches = q ? nodes.filter(n => n.id.toLowerCase().includes(q)) : nodes;
    return NextResponse.json({
      total: nodes.length,
      matched: matches.length,
      nodes: matches.slice(0, 50),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `DINGIR reasoning API unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
