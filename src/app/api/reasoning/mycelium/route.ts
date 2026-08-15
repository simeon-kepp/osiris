import { NextResponse } from 'next/server';

// Proxies to bi_api.py's /reasoning/mycelium (DINGIR's trained GCN
// node-embedding PCA + cosine-kNN endpoint -- see kindom/execution/bi_api.py).
// Runs server-side so the demo API key never reaches the browser. Defaults
// to localhost for local dev; DINGIR_API_URL should point at the deployed
// bi_api.py instance once that's live (see the "Deploy bi_api.py on Fly"
// task -- not done yet, so this only works when bi_api.py is running
// locally on the same machine as `next dev`).

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const node = (searchParams.get('node') || '').trim();
  const k = searchParams.get('k') || '40';
  if (!node) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${DINGIR_API_URL}/reasoning/mycelium?node=${encodeURIComponent(node)}&k=${encodeURIComponent(k)}`,
      { headers: { 'X-API-Key': DINGIR_API_KEY }, signal: AbortSignal.timeout(180_000) }
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
