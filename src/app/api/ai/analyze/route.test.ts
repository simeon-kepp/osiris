import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The gate is the security property this file exists to lock in -- found
// missing while mining the original merge plan's Phase 5 checklist item
// ("confirm the panel is unreachable signed out"). AiAnalyst.tsx, the only
// caller, is UI-hidden without a session, but that never stopped a direct
// POST to this route before this fix, and this route had real cost behind
// it: an unauthenticated caller could burn the operator's configured LLM
// quota with only a 5-req/min-per-IP limit in the way.
const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
}));

const resolveProvider = vi.fn();
const analyzeIntelligence = vi.fn();
vi.mock('@/lib/ai-engine', () => ({
  resolveProvider: (k?: string) => resolveProvider(k),
  analyzeIntelligence: (...args: unknown[]) => analyzeIntelligence(...args),
}));

const REQ = () =>
  new Request('http://localhost:3005/api/ai/analyze', {
    method: 'POST',
    body: JSON.stringify({ query: 'what changed today?', context: {} }),
  });

describe('POST /api/ai/analyze', () => {
  beforeEach(() => {
    currentLogin.mockReset();
    resolveProvider.mockReset();
    analyzeIntelligence.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('answers 404 when nobody is signed in, before touching a provider or the rate limiter', async () => {
    currentLogin.mockResolvedValue(null);
    const { POST } = await import('./route');
    const res = await POST(REQ() as never);
    expect(res.status).toBe(404);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(analyzeIntelligence).not.toHaveBeenCalled();
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
    analyzeIntelligence.mockResolvedValue('the analysis');
    const { POST } = await import('./route');
    const res = await POST(REQ() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis).toBe('the analysis');
    expect(analyzeIntelligence).toHaveBeenCalledTimes(1);
  });
});
