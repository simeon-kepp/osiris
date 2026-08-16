import { NextResponse } from 'next/server';
import { currentLogin } from '@/lib/dingirSessionServer';

// What the corpus actually records about one node: every edge, its provenance
// class, the rule behind it if it was derived, and the url, licence and sha256
// of the file it came from.
//
// This is the route that makes "whitebox" checkable rather than asserted.
// /reasoning/mycelium answers "what sits near this in the learned space", which
// is a property of the MODEL. This answers "what does the evidence say", which
// is a property of the CORPUS, and it consults no model at all -- everything it
// returns, a person could verify by opening the file it names.
//
// Gated like the rest of the reasoning surface: no session, 404 not 403.

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

export async function GET(req: Request) {
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  const node = (new URL(req.url).searchParams.get('node') || '').trim();
  if (!node) {
    return NextResponse.json({ error: 'Missing node parameter' }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      `${DINGIR_API_URL}/reasoning/evidence?node=${encodeURIComponent(node)}`,
      { headers: { 'X-API-Key': DINGIR_API_KEY }, signal: AbortSignal.timeout(180_000) }
    );
    // Passed through as text: this proxy adds nothing to the body, so it has no
    // reason to parse and re-serialize it.
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `DINGIR reasoning API unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
