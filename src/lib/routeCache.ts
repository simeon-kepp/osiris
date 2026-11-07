/** In-process response cache for slow, upstream-bound API routes.
 *
 *  Measured 2026-10-10 in ~/.dingir/logs/web.log: cctv 10-23s, stats 7-16s, weather 6-11s,
 *  markets/history 23s, predictions 10s. Each hit re-fetched public upstreams (TfL, WSDOT, NWS,
 *  Yahoo...) from scratch. This wraps a handler so that:
 *   - a fresh entry (age < ttl) is served instantly,
 *   - a stale entry (ttl <= age < staleMax) is served instantly AND refreshed in the background,
 *   - concurrent cold requests share one in-flight upstream call instead of stampeding.
 *  Only 2xx responses are cached; errors always fall through to the next real attempt. */
type Entry = { body: string; status: number; headers: [string, string][]; at: number };

const store = new Map<string, Entry>();
// keyOf() puts the query string in the key, so a client can mint keys at will. Cap the map.
const MAX_ENTRIES = 300;
const inflight = new Map<string, Promise<Entry>>();

async function run(key: string, handler: () => Promise<Response>): Promise<Entry> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    const res = await handler();
    const entry: Entry = {
      body: await res.text(),
      status: res.status,
      headers: [['Content-Type', res.headers.get('Content-Type') || 'application/json']],
      at: Date.now(),
    };
    // A handler marks a degraded answer (upstream down, fallback data) with X-Route-NoStore so it
    // is served once but never replaces a good entry or sticks for a full ttl.
    if (res.status >= 200 && res.status < 300 && !res.headers.get('X-Route-NoStore')) {
      if (store.size >= MAX_ENTRIES && !store.has(key)) {
        let oldest: string | null = null, oldestAt = Infinity;
        for (const [k, v] of store) if (v.at < oldestAt) { oldest = k; oldestAt = v.at; }
        if (oldest) store.delete(oldest);
      }
      store.set(key, entry);
    }
    return entry;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const toResponse = (e: Entry, state: string) =>
  new Response(e.body, {
    status: e.status,
    headers: [...e.headers, ['X-Route-Cache', state], ['Cache-Control', 'no-store']],
  });

export async function cachedRoute(
  key: string,
  ttlMs: number,
  handler: () => Promise<Response>,
  staleMaxMs = ttlMs * 20
): Promise<Response> {
  const hit = store.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < ttlMs) return toResponse(hit, 'HIT');
  if (hit && age < staleMaxMs) {
    void run(key, handler).catch(() => {}); // refresh behind the response
    return toResponse(hit, 'STALE');
  }
  return toResponse(await run(key, handler), 'MISS');
}

/** Cache key from a request URL, ignoring cache-busting params like `_t`. */
export function keyOf(request: Request): string {
  const u = new URL(request.url);
  u.searchParams.delete('_t');
  u.searchParams.sort();
  return u.pathname + u.search;
}
