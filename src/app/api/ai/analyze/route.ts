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
  type ChatTurn,
  type IntelligenceContext,
} from '@/lib/ai-engine';
import { fetchLinkedPages, wantsWebSearch } from '@/lib/webContext';
import { currentLogin } from '@/lib/dingirSessionServer';
import { validId } from '@/lib/chat-store';
import { addFact, forgetFacts, parseMemoryCommand, recallMemory } from '@/lib/chat-memory';

export const dynamic = 'force-dynamic';

/* ─────────────────────────────────────────────────────────────
   Rate Limiter — 20 requests per minute per IP
   ───────────────────────────────────────────────────────────── */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
// Was 5. A real back-and-forth hits that in a minute; the route is behind the
// DINGIR login anyway, so this only guards against a runaway client.
const RATE_LIMIT_MAX = 20;
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
  /** Earlier turns, oldest first. Optional so an old cached client still works. */
  messages?: unknown;
  /** The globe toggle in the chat header. */
  webSearch?: boolean;
  /** Answer as a stream of JSON lines instead of one JSON body. */
  stream?: boolean;
  /** The open conversation, left out of the memory excerpts because it is already in `messages`. */
  chatId?: string;
}

const MAX_TURNS = 40;
const MAX_TURN_CHARS = 8_000;
const MAX_HISTORY_CHARS = 60_000;

/** Only well-formed turns, newest kept, each one capped. The client is ours but
 *  the body is still input: a role other than user/assistant never reaches the provider. */
function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  let total = 0;
  for (let i = raw.length - 1; i >= 0 && turns.length < MAX_TURNS; i--) {
    const { role, content: text } = (raw[i] ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || !text.trim()) continue;
    const content = text.slice(0, MAX_TURN_CHARS);
    if (total + content.length > MAX_HISTORY_CHARS) break;
    total += content.length;
    turns.unshift({ role, content });
  }
  return turns;
}

interface AnalyzeResponse {
  analysis: string;
  model: string;
  timestamp: string;
  /** What actually reached the model this turn, so the UI never claims a search that did not run. */
  web: { searched: boolean; pages: number };
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
): Promise<NextResponse> {
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
  const login = await currentLogin();
  if (!login) return new NextResponse(null, { status: 404 });

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
        error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} requests per minute.`,
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
  const provider = resolveProvider(userKey, request.headers.get('x-llm-model') || undefined);
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
    const query = body.query.trim();
    const pages = await fetchLinkedPages(query);
    const searched = Boolean(provider.supportsWebSearch && (body.webSearch === true || wantsWebSearch(query)));
    // Memory: an explicit "merk dir …" / "vergiss …" changes the store before the model answers,
    // and the model is told what happened so its reply matches the record.
    let memory = '';
    try {
      const cmd = parseMemoryCommand(query);
      let note = '';
      if (cmd?.kind === 'remember') {
        await addFact(cmd.text, login);
        note = `The operator just asked you to remember: "${cmd.text}". It is stored now and the whole team will see it. Confirm in one short sentence.`;
      } else if (cmd?.kind === 'forget') {
        const n = await forgetFacts(cmd.text);
        note = n ? `Removed ${n} stored fact(s) matching "${cmd.text}". Confirm briefly.` : `No stored fact matched "${cmd.text}". Say so.`;
      }
      memory = (await recallMemory(query, body.chatId && validId(body.chatId) ? body.chatId : undefined)) + (note ? `\n\n${note}` : '');
    } catch (e) {
      console.warn('[DINGIR] memory unavailable:', e instanceof Error ? e.message : e);
    }
    const options = { history: sanitizeHistory(body.messages), webSearch: searched, pages, memory };
    const web = { searched, pages: pages.length };

    if (body.stream === true) {
      // One JSON object per line: {"t": "…"} for text, then {"done": true, …} or {"error": …}.
      // no-transform keeps Next's gzip layer from buffering the tokens until the end.
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (o: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
          try {
            await analyzeIntelligence(provider, body.context, query, { ...options, onToken: t => send({ t }) });
            send({ done: true, model: `${provider.label} / ${provider.model}`, timestamp: new Date().toISOString(), web });
          } catch (err) {
            const m = mapProviderError(err, provider.label);
            send({ error: m.error, code: m.code });
          } finally {
            controller.close();
          }
        },
      });
      return new NextResponse(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const analysis = await analyzeIntelligence(provider, body.context, query, options);
    return NextResponse.json(
      {
        analysis,
        model: `${provider.label} / ${provider.model}`,
        timestamp: new Date().toISOString(),
        web,
      },
      { headers: { 'X-RateLimit-Remaining': String(rateCheck.remaining) } }
    );
  } catch (err: unknown) {
    const m = mapProviderError(err, provider.label);
    return NextResponse.json({ error: m.error, code: m.code }, { status: m.status });
  }
}

/** The provider's own status code is carried in the message by design (see ai-engine), so the
 *  operator is told which model failed and how, not a generic "analysis failed". */
function mapProviderError(err: unknown, label: string): { status: number; error: string; code: string } {
  const message = err instanceof Error ? err.message : 'Unknown provider error';
  if (/\b401\b|API_KEY_INVALID|API key not valid|Unauthorized/i.test(message)) {
    return { status: 401, error: `${label} rejected the API key.`, code: 'INVALID_KEY' };
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
    return { status: 429, error: `${label} quota exhausted. Try again later or use your own key.`, code: 'QUOTA_EXHAUSTED' };
  }
  if (/timed out|TimeoutError|aborted/i.test(message)) {
    return { status: 504, error: `${label} did not respond within 120s.`, code: 'TIMEOUT' };
  }
  if (/SAFETY/i.test(message)) {
    return { status: 422, error: `${label} blocked the response. Try rephrasing.`, code: 'SAFETY_BLOCKED' };
  }
  console.error('[DINGIR] analysis error:', message);
  return { status: 500, error: `Analysis failed via ${label}: ${message.slice(0, 200)}`, code: 'ANALYSIS_FAILED' };
}
