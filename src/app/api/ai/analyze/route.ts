/**
 * ═══════════════════════════════════════════════════════════════
 *  DINGIR — analysis endpoint
 *  POST /api/ai/analyze
 *
 *  Provider-agnostic: resolveProvider picks NVIDIA NIM, Gemini, or a
 *  key the operator pasted in, and this route never learns which.
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  resolveProvider,
  analyzeIntelligence,
  type IntelligenceContext,
} from '@/lib/ai-engine';
import { currentLogin } from '@/lib/dingirSessionServer';

export const dynamic = 'force-dynamic';

/* ─────────────────────────────────────────────────────────────
   Rate Limiter — 5 requests per minute per IP
   ───────────────────────────────────────────────────────────── */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetIn: entry.resetAt - now };
}

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}, 120_000);

/* ─────────────────────────────────────────────────────────────
   Request / Response types
   ───────────────────────────────────────────────────────────── */

interface AnalyzeRequestBody {
  query: string;
  context: IntelligenceContext;
}

interface AnalyzeResponse {
  analysis: string;
  model: string;
  timestamp: string;
}

interface ErrorResponse {
  error: string;
  code: string;
  retryAfter?: number;
}

/* ─────────────────────────────────────────────────────────────
   POST Handler
   ───────────────────────────────────────────────────────────── */

export async function POST(
  request: NextRequest
): Promise<NextResponse<AnalyzeResponse | ErrorResponse>> {
  // AiAnalyst.tsx, the only caller, is itself mounted only behind
  // dingirLogin in page.tsx -- but a hidden UI element does not stop a
  // direct POST to this route, and until this fix nothing here did either.
  // Every other DINGIR reasoning route (graph, mycelium, feed, evidence)
  // gates the same way: no session, 404, not 403, so a probe cannot even
  // confirm the endpoint exists. This route had none of that -- an
  // unauthenticated caller could burn the operator's configured LLM
  // quota (Gemini/NVIDIA) with only a 5-req/min-per-IP limit standing
  // between them and it, trivially defeated by rotating IPs. Found by
  // actually mining the original plan's Phase 5 checklist item ("confirm
  // the panel is unreachable signed out") instead of assuming a hidden
  // panel implies a protected backend.
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  // Extract client IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  // Rate limit check
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded. Maximum 5 requests per minute.',
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil(rateCheck.resetIn / 1000),
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rateCheck.resetIn / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rateCheck.resetIn / 1000)),
        },
      }
    );
  }

  // Which model answers. The header is named x-llm-key; x-gemini-key is still
  // read so a key already saved in someone's browser keeps working.
  const userKey = (request.headers.get('x-llm-key') || request.headers.get('x-gemini-key'))?.trim();
  const provider = resolveProvider(userKey);
  if (!provider) {
    return NextResponse.json(
      {
        error:
          'No language model configured. Set NVIDIA_API_KEY (free tier at build.nvidia.com) ' +
          'or GEMINI_API_KEY_1 in the environment, or paste a key into the settings panel.',
        code: 'NO_API_KEY',
      },
      { status: 503 }
    );
  }

  // Parse request body
  let body: AnalyzeRequestBody;
  try {
    body = (await request.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.', code: 'INVALID_BODY' },
      { status: 400 }
    );
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return NextResponse.json(
      { error: 'Query field is required and must be a non-empty string.', code: 'MISSING_QUERY' },
      { status: 400 }
    );
  }

  if (!body.context) {
    return NextResponse.json(
      { error: 'Intelligence context is required.', code: 'MISSING_CONTEXT' },
      { status: 400 }
    );
  }

  try {
    const analysis = await analyzeIntelligence(provider, body.context, body.query.trim());
    return NextResponse.json(
      { analysis, model: `${provider.label} / ${provider.model}`, timestamp: new Date().toISOString() },
      { headers: { 'X-RateLimit-Remaining': String(rateCheck.remaining) } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown provider error';

    // The provider's own status code is carried in the message by design (see
    // ai-engine), so the operator is told which model failed and how, rather
    // than a generic "analysis failed" that could mean anything.
    if (/\b401\b|API_KEY_INVALID|API key not valid|Unauthorized/i.test(message)) {
      return NextResponse.json(
        { error: `${provider.label} rejected the API key.`, code: 'INVALID_KEY' },
        { status: 401 }
      );
    }
    if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
      return NextResponse.json(
        { error: `${provider.label} quota exhausted. Try again later or use your own key.`, code: 'QUOTA_EXHAUSTED' },
        { status: 429 }
      );
    }
    if (/timed out|TimeoutError|aborted/i.test(message)) {
      return NextResponse.json(
        { error: `${provider.label} did not respond within 120s.`, code: 'TIMEOUT' },
        { status: 504 }
      );
    }
    if (/SAFETY/i.test(message)) {
      return NextResponse.json(
        { error: `${provider.label} blocked the response. Try rephrasing.`, code: 'SAFETY_BLOCKED' },
        { status: 422 }
      );
    }

    console.error('[DINGIR] analysis error:', message);
    return NextResponse.json(
      { error: `Analysis failed via ${provider.label}: ${message.slice(0, 200)}`, code: 'ANALYSIS_FAILED' },
      { status: 500 }
    );
  }
}
