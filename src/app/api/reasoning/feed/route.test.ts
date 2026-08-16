import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The gate and the single-poller property are the two things this route
// exists for, so both get tested directly rather than assumed correct from
// reading the code. currentLogin() is the seam, same pattern as the other
// reasoning routes.
const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
}));

const REQ = 'http://localhost:3005/api/reasoning/feed';
const SNAPSHOT = { items: [], counts: {}, graph: { nodes: 1, edges: 1 } };

async function readOneStreamChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
}

describe('GET /api/reasoning/feed', () => {
  beforeEach(() => {
    currentLogin.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 404 when signed out, and never starts the poller', async () => {
    currentLogin.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the plan\'s own verification item: two concurrent connections share ONE upstream poll, not one each', async () => {
    // This is what the original merge plan's Phase 4 checklist asked to
    // confirm ("bi_api sees one poller, not one request per client") and
    // never had automated coverage for -- code-correct by inspection
    // (ensurePoller()'s `if (poller) return` guard), unverified until now.
    currentLogin.mockResolvedValue('simeon-kepp');
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    const { GET } = await import('./route');

    const res1 = await GET(new Request(REQ));
    const res2 = await GET(new Request(REQ));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // ensurePoller() calls pollOnce() synchronously (fire-and-forget) on the
    // FIRST GET only -- the second GET's ensurePoller() must short-circuit
    // on the already-set `poller` before ever calling fetch again. Awaiting
    // a microtask lets that first fire-and-forget pollOnce() settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledTimes(1);

    res1.body?.cancel();
    res2.body?.cancel();
  });

  it('a new connection gets the current snapshot immediately, not a blank first tick', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    const { GET } = await import('./route');

    const res = await GET(new Request(REQ));
    const chunk = await readOneStreamChunk(res);
    expect(chunk).toContain('event: status');

    res.body?.cancel();
  });

  it('?once=1 returns one JSON snapshot, still behind the gate, not an SSE stream', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    const { GET } = await import('./route');

    const res = await GET(new Request(REQ + '?once=1'));
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json();
    expect(body).toMatchObject(SNAPSHOT);
  });

  it('?once=1 answers 404 when signed out too, not just the stream path', async () => {
    currentLogin.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ + '?once=1'));
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
