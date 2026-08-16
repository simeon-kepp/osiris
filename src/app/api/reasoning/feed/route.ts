import { currentLogin } from '@/lib/dingirSessionServer';

// DINGIR's reasoning feed as Server-Sent Events.
//
// THE POINT OF THE SERVER-SIDE POLLER. bi_api enforces 100 requests per hour
// per token. A client polling every 30 seconds is 120/hour on its own, so two
// open browser tabs would lock everybody out of the whole API for an hour. One
// poller lives here, in this process, and every connected client is fanned out
// from the same snapshot -- so ten readers cost exactly what one costs.
//
// Gated like the other reasoning routes: no session, 404, not 403.

export const dynamic = 'force-dynamic';

const DINGIR_API_URL = process.env.DINGIR_API_URL || 'http://127.0.0.1:8080';
const DINGIR_API_KEY = process.env.DINGIR_API_KEY || 'rfi-demo-2026';

const POLL_MS = 60_000;      // 60/hour, comfortably inside bi_api's budget
const HEARTBEAT_MS = 15_000; // keeps proxies from closing an idle stream

type FeedItem = {
  kind: string; provenance: string; score: number;
  title: string; detail: string; nodes: string[];
  relation?: string; epistemic_status?: string; timestamp?: string;
};
type Snapshot = { items: FeedItem[]; counts: Record<string, number>; graph: { nodes: number; edges: number } };

// Module scope: shared by every request this process serves.
let snapshot: Snapshot | null = null;
let fetchedAt = 0;
let poller: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(s: Snapshot) => void>();

async function pollOnce() {
  try {
    const res = await fetch(`${DINGIR_API_URL}/reasoning/feed?limit=60`, {
      headers: { 'X-API-Key': DINGIR_API_KEY },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as Snapshot;
    if (!body?.items) return;
    snapshot = body;
    fetchedAt = Date.now();
    for (const notify of subscribers) notify(body);
  } catch {
    // A poll failure is not worth tearing the stream down: the next tick
    // retries, and clients keep the last snapshot they were given.
  }
}

function ensurePoller() {
  if (poller) return;
  poller = setInterval(pollOnce, POLL_MS);
  void pollOnce();
}

export async function GET(req: Request) {
  if (!(await currentLogin())) return new Response(null, { status: 404 });

  ensurePoller();

  // ?once=1 -- one JSON snapshot instead of a stream. The chat panel needs the
  // current anomalies and predictions at the moment a question is sent, not a
  // subscription; opening an EventSource per chat would mean a second consumer
  // of the same data with its own lifecycle for no benefit. Reads the shared
  // snapshot, so it costs nothing upstream.
  if (new URL(req.url).searchParams.get('once')) {
    if (!snapshot) {
      // The poller was only just started by this request. Give the first fetch
      // a chance rather than returning an empty snapshot the caller cannot
      // distinguish from a genuinely quiet system.
      await pollOnce();
    }
    return new Response(JSON.stringify(snapshot ?? { items: [], counts: {}, graph: { nodes: 0, edges: 0 } }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const encoder = new TextEncoder();

  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client went away mid-write */
        }
      };

      // A new reader gets the current snapshot immediately rather than waiting
      // up to a minute for the next tick, so opening the panel is never blank.
      send('status', { connected: true, pollSeconds: POLL_MS / 1000, lastFetch: fetchedAt || null });
      if (snapshot) send('snapshot', snapshot);

      const onSnapshot = (s: Snapshot) => send('snapshot', s);
      subscribers.add(onSnapshot);

      const heartbeat = setInterval(() => send('heartbeat', { t: Date.now() }), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        subscribers.delete(onSnapshot);
        // Stop polling once nobody is listening. The upstream budget is small
        // enough that a poller running against an empty room is a real cost.
        if (subscribers.size === 0 && poller) {
          clearInterval(poller);
          poller = null;
        }
        try { controller.close(); } catch { /* already closed */ }
      };
    },
    // Called when the client disconnects. Without wiring this up, every closed
    // tab would leave its heartbeat and its subscription behind, and the poller
    // would keep spending the upstream budget on an empty room forever.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
