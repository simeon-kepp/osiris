import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same gate, same finding as analyze/route.test.ts -- see that file for
// the full reasoning. This route had the identical gap.
const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
}));

const resolveProvider = vi.fn();
const generateBriefing = vi.fn();
vi.mock('@/lib/ai-engine', () => ({
  resolveProvider: (k?: string) => resolveProvider(k),
  generateBriefing: (...args: unknown[]) => generateBriefing(...args),
}));

const REQ = () =>
  new Request('http://localhost:3005/api/ai/briefing', {
    method: 'POST',
    body: JSON.stringify({ context: {} }),
  });

describe('POST /api/ai/briefing', () => {
  beforeEach(() => {
    currentLogin.mockReset();
    resolveProvider.mockReset();
    generateBriefing.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('answers 404 when nobody is signed in, before touching a provider or the rate limiter', async () => {
    currentLogin.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(REQ() as never);
    expect(res.status).toBe(404);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(generateBriefing).not.toHaveBeenCalled();
  });

  it('answers 404 rather than 403, so the endpoint is not confirmed to exist', async () => {
    currentLogin.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(REQ() as never);
    expect(res.status).not.toBe(403);
    expect(await res.text()).toBe('');
  });

  it('proceeds to the provider once a signed-in login is present', async () => {
    currentLogin.mockResolvedValue('simeon-kepp');
    resolveProvider.mockReturnValue({ label: 'Gemini', model: 'gemini-test' });
    generateBriefing.mockResolvedValue('the briefing');
    const { POST } = await import('./route');
    const res = await POST(REQ() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.briefing).toBe('the briefing');
    expect(generateBriefing).toHaveBeenCalledTimes(1);
  });
});
