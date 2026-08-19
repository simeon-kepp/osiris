import { NextResponse } from 'next/server';

/**
 * DINGIR — Road traffic layer (TomTom Traffic Incidents + Flow).
 *
 * WHY THIS LAYER EXISTS AND IT IS NOT DECORATION. The corpus audit found road
 * transport to be a total blank: `eu_historical_roads` could not even be
 * opened, and `transit_wien` / `transit_fintraffic` / `maritime_ais` are source
 * registrations holding zero bytes. Meanwhile road disruption is the arrow two
 * of the fifty causal chains run through (road closure -> delivery time ->
 * trucking cost, and commute time -> reachable labour market). This is the
 * first live road observation the system has ever had.
 *
 * THE KEY IS SERVER-SIDE ONLY. TOMTOM_API_KEY carries no NEXT_PUBLIC_ prefix on
 * purpose: the browser never sees it, this route holds it. The evaluation tier
 * has request limits and a leaked key would be spent by strangers within a day.
 *
 * INCIDENTS vs FLOW, because they answer different questions:
 *   incidents  discrete events with a start, an end, a length and a delay.
 *              These are what a causal chain can hang an arrow on.
 *   flow       current speed against free-flow speed at a point. This is a
 *              STATE, not an event, and it is what makes congestion visible
 *              on a map where an incident marker alone would not.
 *
 * CACHING. Traffic changes on a scale of minutes, not seconds, and the tier is
 * limited, so responses are held briefly per bounding box. Without this, one
 * user panning the map would burn the quota in an afternoon.
 */

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || '';
const INCIDENTS_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const FLOW_URL = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json';

// TomTom's iconCategory enum. Mapped to plain words because a bare integer in
// a popup tells an operator nothing, and the categories are what distinguish
// "a lane is shut" from "it is raining".
const CATEGORY: Record<number, string> = {
  0: 'Unknown', 1: 'Accident', 2: 'Fog', 3: 'Dangerous conditions', 4: 'Rain',
  5: 'Ice', 6: 'Jam', 7: 'Lane closed', 8: 'Road closed', 9: 'Road works',
  10: 'Wind', 11: 'Flooding', 14: 'Broken down vehicle',
};

// magnitudeOfDelay, TomTom's own severity scale.
const MAGNITUDE: Record<number, string> = {
  0: 'unknown', 1: 'minor', 2: 'moderate', 3: 'major', 4: 'undefined',
};

export type TrafficIncident = {
  id: string;
  lat: number; lng: number;
  category: string; categoryId: number;
  severity: string; severityId: number;
  description: string | null;
  from: string | null; to: string | null;
  roadNumbers: string[] | null;
  lengthM: number | null;
  delayS: number | null;
  startTime: string | null; endTime: string | null;
};

type CacheEntry = { at: number; body: unknown };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 120_000;

/** First coordinate of the incident geometry, whatever its shape. TomTom
 *  returns a LineString for a stretch of road and a Point for a spot event;
 *  a marker needs one position and picking the head is stable across both. */
function headCoord(geometry: { type?: string; coordinates?: unknown }): [number, number] | null {
  const c = geometry?.coordinates as unknown;
  if (!Array.isArray(c) || c.length === 0) return null;
  if (typeof c[0] === 'number' && typeof c[1] === 'number') return [c[0] as number, c[1] as number];
  const first = c[0] as unknown;
  if (Array.isArray(first) && typeof first[0] === 'number' && typeof first[1] === 'number') {
    return [first[0] as number, first[1] as number];
  }
  return null;
}

export async function GET(req: Request) {
  if (!TOMTOM_KEY) {
    // Distinguished from an upstream failure on purpose: an unset key is a
    // deployment state a person can fix, not an outage to retry.
    return NextResponse.json(
      { error: 'TOMTOM_API_KEY is not set on the server', incidents: [], flow: null },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(req.url);
  // Vienna as the default only because the map opens somewhere; every real
  // call passes the current viewport.
  const bbox = searchParams.get('bbox') || '16.18,48.11,16.58,48.33';
  const point = searchParams.get('point');

  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
    return NextResponse.json({ error: 'bbox must be west,south,east,north' }, { status: 400 });
  }
  const [w, s, e, n] = parts;
  // TomTom rejects very large boxes, and a whole-continent request would be
  // meaningless on screen anyway. Clamped rather than errored so panning out
  // degrades to "the middle of the view" instead of to a red banner.
  const MAX_DEG = 2.0;
  const cw = Math.min(e - w, MAX_DEG), ch = Math.min(n - s, MAX_DEG);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const clamped = [cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2]
    .map(v => v.toFixed(4)).join(',');

  const cacheKey = `${clamped}|${point ?? ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ ...(hit.body as object), cached: true });
  }

  const fields = '{incidents{type,geometry{type,coordinates},properties{iconCategory,'
    + 'magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,'
    + 'delay,roadNumbers}}}';

  try {
    const incUrl = `${INCIDENTS_URL}?key=${TOMTOM_KEY}&bbox=${clamped}`
      + `&fields=${encodeURIComponent(fields)}&language=en-GB`;
    const incRes = await fetch(incUrl, { signal: AbortSignal.timeout(20_000) });
    if (!incRes.ok) {
      return NextResponse.json(
        { error: `TomTom incidents ${incRes.status}`, incidents: [], flow: null },
        { status: 502 }
      );
    }
    const incJson = await incRes.json() as {
      incidents?: Array<{ geometry?: { type?: string; coordinates?: unknown };
                          properties?: Record<string, unknown> }>;
    };

    const incidents: TrafficIncident[] = [];
    for (const [i, raw] of (incJson.incidents ?? []).entries()) {
      const coord = headCoord(raw.geometry ?? {});
      if (!coord) continue;
      const p = (raw.properties ?? {}) as Record<string, unknown>;
      const catId = Number(p.iconCategory ?? 0);
      const sevId = Number(p.magnitudeOfDelay ?? 0);
      const events = (p.events as Array<{ description?: string }> | undefined) ?? [];
      incidents.push({
        id: `${clamped}-${i}`,
        lng: coord[0], lat: coord[1],
        categoryId: catId, category: CATEGORY[catId] ?? `Category ${catId}`,
        severityId: sevId, severity: MAGNITUDE[sevId] ?? 'unknown',
        description: events[0]?.description ?? null,
        from: (p.from as string) ?? null,
        to: (p.to as string) ?? null,
        roadNumbers: (p.roadNumbers as string[]) ?? null,
        lengthM: p.length == null ? null : Math.round(Number(p.length)),
        delayS: p.delay == null ? null : Number(p.delay),
        startTime: (p.startTime as string) ?? null,
        endTime: (p.endTime as string) ?? null,
      });
    }

    // Flow is a point query, so it is only fetched when the caller asks about
    // a specific place; requesting it for a whole viewport would need a grid
    // of calls and the evaluation tier will not carry that.
    let flow: Record<string, unknown> | null = null;
    if (point) {
      const fRes = await fetch(`${FLOW_URL}?key=${TOMTOM_KEY}&point=${encodeURIComponent(point)}`,
        { signal: AbortSignal.timeout(15_000) });
      if (fRes.ok) {
        const fj = await fRes.json() as { flowSegmentData?: Record<string, unknown> };
        const d = fj.flowSegmentData;
        if (d) {
          const cur = Number(d.currentSpeed), free = Number(d.freeFlowSpeed);
          flow = {
            currentSpeed: cur, freeFlowSpeed: free,
            currentTravelTime: d.currentTravelTime, freeFlowTravelTime: d.freeFlowTravelTime,
            // The quantity a causal chain actually wants: 1.0 is free flow,
            // 0.3 is a crawl. Derived here so every consumer computes it the
            // same way rather than each inventing its own congestion index.
            congestionRatio: free > 0 ? Number((cur / free).toFixed(3)) : null,
            confidence: d.confidence, roadClosure: d.roadClosure, frc: d.frc,
          };
        }
      }
    }

    const body = {
      incidents,
      flow,
      bbox: clamped,
      counts: incidents.reduce<Record<string, number>>((acc, i) => {
        acc[i.category] = (acc[i.category] ?? 0) + 1;
        return acc;
      }, {}),
      source: 'TomTom Traffic Incidents v5 / Flow v4',
      fetchedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), body });
    // Unbounded growth would leak memory across a long-running server; the map
    // only ever needs the recent boxes.
    if (cache.size > 200) {
      for (const k of Array.from(cache.keys()).slice(0, 100)) cache.delete(k);
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: `TomTom unreachable: ${e instanceof Error ? e.message : String(e)}`,
        incidents: [], flow: null },
      { status: 502 }
    );
  }
}
