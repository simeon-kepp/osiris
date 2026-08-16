import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The gate is the security property of this route, so it gets tested directly
// rather than only through its helpers. currentLogin() is the seam.
const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
  authConfigured: () => true,
}));

import { GET } from './route';

const REQ = 'http://localhost:3005/api/reasoning/mycelium?node=APP:Pokemon%20GO&k=5';

describe('GET /api/reasoning/mycelium', () => {
  beforeEach(() => {
    currentLogin.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('answers 404 when nobody is signed in, and never calls upstream', async () => {
    currentLogin.mockResolvedValue(null);
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 404 rather than 403, so the endpoint is not confirmed to exist', async () => {
    currentLogin.mockResolvedValue(null);
    const res = await GET(new Request(REQ));
    expect(res.status).not.toBe(403);
    expect(await res.text()).toBe('');
  });

  it('proxies upstream once a signed-in login is present', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ word: 'APP:Pokemon GO', neighbors: [] }), { status: 200 })
    );
    const res = await GET(new Request(REQ));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ word: 'APP:Pokemon GO' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing node parameter after the gate, not before', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    const res = await GET(new Request('http://localhost:3005/api/reasoning/mycelium'));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
