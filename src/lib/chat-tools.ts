import { listFacts, recallMemory } from '@/lib/chat-memory';

/**
 * Tools the chat model can call while it answers, so it looks things up instead of guessing.
 *
 * The protocol is plain text and works with every provider in the chain: the model answers with a
 * single line `TOOL {"tool":"digest","region":"europe","hours":24}`, the server runs it and the
 * model reads the result and answers. Native function calling differs between NIM, OpenRouter and
 * Gemini, so none of it is relied on here.
 *
 * Map data comes from this app's own feed routes (the same ones the map draws), the graph from the
 * login-gated reasoning routes with the caller's own session cookie forwarded.
 */

export interface ToolContext {
  cookie: string;
  providerLabel: string;
  model: string;
  historyTurns: number;
  systemChars: number;
  chatId?: string;
}

const BASE = `http://127.0.0.1:${process.env.PORT || 3005}`;

/** [west, south, east, north] */
const REGIONS: Record<string, [number, number, number, number]> = {
  europe: [-25, 36, 40, 72],
  'western europe': [-12, 35, 20, 61],
  'eastern europe': [14, 42, 45, 62],
  ukraine: [22, 44, 41, 53],
  russia: [27, 41, 180, 78],
  'middle east': [25, 12, 63, 42],
  israel: [34, 29, 36, 34],
  africa: [-20, -35, 52, 38],
  asia: [60, -11, 150, 55],
  'east asia': [100, 18, 146, 54],
  'north america': [-170, 14, -50, 72],
  'south america': [-82, -56, -34, 13],
  oceania: [110, -48, 180, 0],
  austria: [9.5, 46.3, 17.2, 49.1],
  germany: [5.8, 47.2, 15.1, 55.1],
  global: [-180, -90, 180, 90],
};

const LAYERS: Record<string, { route: string; label: string }> = {
  earthquakes: { route: 'earthquakes', label: 'Earthquakes' },
  conflicts: { route: 'conflicts', label: 'Conflict zones' },
  gdelt: { route: 'gdelt-events', label: 'GDELT events' },
  news: { route: 'news', label: 'OSINT news' },
  weather: { route: 'weather', label: 'Severe weather' },
  cyber: { route: 'cyber-attacks', label: 'Cyber attacks' },
  fires: { route: 'fires', label: 'Fires' },
  flights: { route: 'flights', label: 'Flights' },
  maritime: { route: 'maritime', label: 'Maritime' },
  radiation: { route: 'radar', label: 'Radar / radiation' },
  space_weather: { route: 'space-weather', label: 'Space weather' },
};

const DIGEST_LAYERS = ['earthquakes', 'conflicts', 'news', 'gdelt', 'weather', 'cyber', 'fires'];

type Row = Record<string, unknown>;

function num(v: unknown): number | null { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; }

function coordsOf(r: Row): [number, number] | null {
  const lat = num(r.lat ?? r.latitude ?? r.src_lat);
  const lon = num(r.lng ?? r.lon ?? r.longitude ?? r.src_lng);
  if (lat !== null && lon !== null) return [lat, lon];
  if (Array.isArray(r.coords) && r.coords.length === 2) {
    const a = num(r.coords[0]); const b = num(r.coords[1]);
    if (a !== null && b !== null) return [a, b];
  }
  return null;
}

function timeOf(r: Row): number | null {
  for (const k of ['timestamp', 'published', 'time_iso', 'occurred_at', 'created_at', 'date', 'time', 'updated', 'sqldate']) {
    const v = r[k];
    if (typeof v === 'string' || typeof v === 'number') {
      const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

const SHOW = ['title', 'name', 'label', 'place', 'location', 'magnitude', 'severity', 'type', 'category', 'country', 'event_code', 'source', 'callsign', 'description', 'risk_score', 'frp', 'confidence'];

function line(r: Row): string {
  const bits: string[] = [];
  for (const k of SHOW) {
    const v = r[k];
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).replace(/\s+/g, ' ').slice(0, k === 'description' ? 140 : 90);
    bits.push(k === 'title' || k === 'name' || k === 'place' || k === 'label' ? s : `${k}=${s}`);
  }
  const c = coordsOf(r);
  if (c) bits.push(`@${c[0].toFixed(1)},${c[1].toFixed(1)}`);
  const t = timeOf(r);
  if (t) bits.push(new Date(t).toISOString().slice(0, 16) + 'Z');
  return bits.join(' | ');
}

async function fetchJson(path: string, cookie = ''): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

function rowsOf(json: unknown): Row[] {
  if (Array.isArray(json)) return json.filter((x): x is Row => !!x && typeof x === 'object');
  if (json && typeof json === 'object') {
    let best: Row[] = [];
    for (const v of Object.values(json as Row)) {
      if (Array.isArray(v) && v.length > best.length && typeof v[0] === 'object') best = v as Row[];
    }
    return best;
  }
  return [];
}

function resolveRegion(name?: string): { key: string; box: [number, number, number, number] } {
  const k = (name || 'global').toLowerCase().trim();
  if (REGIONS[k]) return { key: k, box: REGIONS[k] };
  const hit = Object.keys(REGIONS).find(r => k.includes(r) || r.includes(k));
  return hit ? { key: hit, box: REGIONS[hit] } : { key: 'global', box: REGIONS.global };
}

async function readLayer(name: string, region: { key: string; box: [number, number, number, number] }, hours: number, limit: number): Promise<string> {
  const def = LAYERS[name];
  if (!def) return `Unknown layer "${name}". Layers: ${Object.keys(LAYERS).join(', ')}.`;
  const rows = rowsOf(await fetchJson(`/api/${def.route}`));
  const [w, s, e, n] = region.box;
  const cutoff = Date.now() - hours * 3_600_000;
  const inBox = rows.filter(r => {
    const c = coordsOf(r);
    return c ? c[1] >= w && c[1] <= e && c[0] >= s && c[0] <= n : region.key === 'global';
  });
  const recent = inBox.filter(r => { const t = timeOf(r); return t === null || t >= cutoff; });
  const timed = recent.filter(r => timeOf(r) !== null).length;
  recent.sort((a, b) => (timeOf(b) ?? 0) - (timeOf(a) ?? 0));
  const head = `${def.label}: ${recent.length} in ${region.key}, last ${hours} h (of ${rows.length} loaded${timed < recent.length ? `; ${recent.length - timed} without a timestamp` : ''})`;
  return [head, ...recent.slice(0, limit).map(r => `  - ${line(r)}`)].join('\n');
}

export const TOOL_HELP = `## TOOLS
You can look things up before you answer. To call a tool, reply with ONLY one line, nothing before it and nothing after it:
TOOL {"tool":"<name>", ...arguments}
The result comes back and you then write the real answer. You may call up to 3 tools in a row. Never write TOOL inside a normal answer.
- digest {"region":"europe","hours":24}  what happened in a region: earthquakes, conflict zones, news, GDELT events, severe weather, cyber attacks and fires in one pass. Regions: ${Object.keys(REGIONS).join(', ')}.
- layer {"name":"news","region":"ukraine","hours":12,"limit":25}  one map layer in detail. Layers: ${Object.keys(LAYERS).join(', ')}.
- graph {"query":"ACTOR:UNITED STATES"}  search the knowledge graph by name; with an exact node id it returns the recorded evidence for that node.
- memory {"query":"..."}  stored team facts and earlier team conversations.
- about {}  facts about yourself: model, how much you see right now, graph size, memory, tools.
Use a tool whenever the question is about a place, a time window, a node or yourself and the snapshot above does not already answer it. You can see the whole map through these tools, so never say you cannot see it. State the window and the region you looked at in your answer.`;

export async function runTool(call: Record<string, unknown>, ctx: ToolContext): Promise<{ label: string; result: string }> {
  const tool = String(call.tool || '');
  try {
    if (tool === 'digest') {
      const region = resolveRegion(String(call.region || 'europe'));
      const hours = Math.min(168, Math.max(1, num(call.hours) ?? 24));
      const parts = await Promise.all(DIGEST_LAYERS.map(l => readLayer(l, region, hours, l === 'fires' ? 0 : 8).catch(e => `${l}: unavailable (${e instanceof Error ? e.message : e})`)));
      return { label: `Reading the map: ${region.key}, last ${hours} h`, result: parts.join('\n\n') };
    }
    if (tool === 'layer') {
      const region = resolveRegion(String(call.region || 'global'));
      const hours = Math.min(168, Math.max(1, num(call.hours) ?? 24));
      const limit = Math.min(60, Math.max(3, num(call.limit) ?? 20));
      return { label: `Reading layer ${call.name}`, result: await readLayer(String(call.name || ''), region, hours, limit) };
    }
    if (tool === 'graph') {
      const q = String(call.query || '').trim();
      if (!q) return { label: 'Graph', result: 'Give a query.' };
      const nodes = await fetchJson(`/api/reasoning/nodes?q=${encodeURIComponent(q)}`, ctx.cookie) as { total?: number; matched?: number; nodes?: { id: string; type: string }[] };
      const list = nodes.nodes ?? [];
      let out = `Graph search "${q}": ${nodes.matched ?? list.length} of ${nodes.total ?? '?'} nodes match.\n` + list.slice(0, 15).map(n => `  - ${n.id} (${n.type})`).join('\n');
      const exact = list.find(n => n.id.toLowerCase() === q.toLowerCase()) ?? (list.length === 1 ? list[0] : undefined);
      if (exact) {
        try {
          const ev = await fetchJson(`/api/reasoning/evidence?node=${encodeURIComponent(exact.id)}`, ctx.cookie);
          out += `\n\nEvidence for ${exact.id}:\n${JSON.stringify(ev).slice(0, 3500)}`;
        } catch (e) { out += `\n(evidence unavailable: ${e instanceof Error ? e.message : e})`; }
      }
      return { label: `Searching the graph: ${q}`, result: out };
    }
    if (tool === 'memory') {
      const m = await recallMemory(String(call.query || ''), ctx.chatId);
      return { label: 'Checking memory', result: m || 'Nothing stored that matches.' };
    }
    if (tool === 'about') {
      let graph = 'unknown';
      try {
        const g = await fetchJson('/api/reasoning/nodes?q=%00', ctx.cookie) as { total?: number };
        if (g.total) graph = `${g.total} nodes`;
      } catch { /* login-gated or engine down */ }
      const facts = await listFacts().catch(() => []);
      return {
        label: 'Checking myself',
        result: [
          `Language model: ${ctx.model} via ${ctx.providerLabel}`,
          `Context this turn: about ${Math.round(ctx.systemChars / 4)} tokens of system and data, plus ${ctx.historyTurns} earlier messages of this conversation`,
          `Knowledge graph: ${graph}`,
          `Stored team facts: ${facts.length}`,
          `Map layers I can read: ${Object.keys(LAYERS).join(', ')}`,
          `Tools: digest, layer, graph, memory, about. Optional web search switch in the chat header.`,
          `Long conversations: the oldest part is summarised once it grows past about 24 messages; the latest 10 stay word for word.`,
        ].join('\n'),
      };
    }
    return { label: 'Tool', result: `Unknown tool "${tool}".` };
  } catch (e) {
    return { label: `Tool ${tool} failed`, result: `The tool failed: ${e instanceof Error ? e.message : String(e)}. Say so instead of guessing.` };
  }
}
