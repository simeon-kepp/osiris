/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Intelligence Briefing Endpoint
 *  POST /api/ai/briefing
 *  Generates structured threat briefings via Gemini
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  resolveProvider,
  generateBriefing,
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

interface BriefingRequestBody {
  context: IntelligenceContext;
}

interface BriefingResponse {
  briefing: string;
  generatedAt: string;
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
): Promise<NextResponse<BriefingResponse | ErrorResponse>> {
  // Same gate as /api/ai/analyze -- see that route for the full reasoning.
  // AiAnalyst.tsx (the only caller) is UI-hidden without a session, but a
  // hidden panel does not stop a direct POST, and until this fix nothing
  // here did either.
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

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
        },
      }
    );
  }

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

  let body: BriefingRequestBody;
  try {
    body = (await request.json()) as BriefingRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.', code: 'INVALID_BODY' },
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
    const briefing = await generateBriefing(provider, body.context);
    return NextResponse.json(
      { briefing, model: `${provider.label} / ${provider.model}`, generatedAt: new Date().toISOString() },
      { headers: { 'X-RateLimit-Remaining': String(rateCheck.remaining) } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown provider error';
    if (/\b401\b|API_KEY_INVALID|API key not valid|Unauthorized/i.test(message)) {
      return NextResponse.json({ error: `${provider.label} rejected the API key.`, code: 'INVALID_KEY' }, { status: 401 });
    }
    if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
      return NextResponse.json({ error: `${provider.label} quota exhausted.`, code: 'QUOTA_EXHAUSTED' }, { status: 429 });
    }
    if (/timed out|TimeoutError|aborted/i.test(message)) {
      return NextResponse.json({ error: `${provider.label} did not respond within 120s.`, code: 'TIMEOUT' }, { status: 504 });
    }
    console.error('[DINGIR] briefing error:', message);
    return NextResponse.json(
      { error: `Briefing failed via ${provider.label}: ${message.slice(0, 200)}`, code: 'BRIEFING_FAILED' },
      { status: 500 }
    );
  }
}
