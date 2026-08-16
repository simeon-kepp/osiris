import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The gate is the security property of this route, tested directly rather
// than only through its helpers, same pattern as mycelium/route.test.ts.
const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
  authConfigured: () => true,
}));

const REQ = 'http://localhost:3005/api/reasoning/graph';

describe('GET /api/reasoning/graph', () => {
  beforeEach(() => {
    currentLogin.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('answers 404 when nobody is signed in, and never calls upstream', async () => {
    currentLogin.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 404 rather than 403, so the endpoint is not confirmed to exist', async () => {
    currentLogin.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ));
    expect(res.status).not.toBe(403);
    expect(await res.text()).toBe('');
  });

  it('proxies upstream once a signed-in login is present, body untouched', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    const body = JSON.stringify({ nodes: [{ id: 'APP:x' }], node_count: 1, edge_count: 0 });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(200);
    // The route caches/returns the raw text rather than re-parsing it -- a
    // byte-for-byte match is the thing worth asserting, not a JSON.parse
    // round-trip that would pass even if re-serialization changed the bytes.
    expect(await res.text()).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/reasoning/graph');
  });

  it('caches a successful response and does not re-fetch within the TTL', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    const body = JSON.stringify({ node_count: 1 });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));
    const { GET } = await import('./route');
    await GET(new Request(REQ));
    const res2 = await GET(new Request(REQ));
    expect(await res2.text()).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('?fresh=1 bypasses the cache and re-fetches upstream', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    // Two real fetches happen in this test (cache is deliberately bypassed),
    // so each needs its own Response instance -- see the note in the
    // "failed cache entry" test above for why a shared one would throw.
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ node_count: 1 }), { status: 200 }));
    const { GET } = await import('./route');
    await GET(new Request(REQ));
    await GET(new Request(REQ + '?fresh=1'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed cache entry (non-ok upstream) is not cached, so the next call retries', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    // A fresh Response per call -- a Response body can only be read once,
    // and this route reads it via .text(), so reusing one mock instance
    // across two GET() calls throws on the second read and would show up
    // as this route's own catch-all 502, not the 503 under test.
    vi.mocked(fetch).mockImplementation(async () => new Response('service unavailable', { status: 503 }));
    const { GET } = await import('./route');
    const res1 = await GET(new Request(REQ));
    expect(res1.status).toBe(503);
    const res2 = await GET(new Request(REQ));
    expect(res2.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('upstream unreachable answers 502 with an error message, not a crash', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    vi.mocked(fetch).mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { GET } = await import('./route');
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain('ECONNREFUSED');
  });
});
