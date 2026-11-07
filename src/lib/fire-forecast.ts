import { promises as fs } from 'fs';
import path from 'path';
import { withLock, appendJsonl, lowerBound } from './forecast-io';

/**
 * Wildfire persistence forecast.
 *
 * The question: a fire cluster is burning today. Will satellites still see fire in that same
 * 0.25 degree cell between 24 and 72 hours from now?
 *
 * Every forecast is written once to an append-only file and never edited. Scoring adds a separate
 * line after the window has closed. The probability is not a model output: it is the share of
 * comparable clusters (same cell size, same detection-count band) that kept burning over the
 * previous days of the same satellite feed, so it can be recomputed by anyone from NASA's public
 * file. Whether that share holds up on new clusters is exactly what the scoring measures.
 */

const DATASETS_DIR =
  process.env.KINDOM_DATASETS_DIR ||
  path.join(process.env.HOME || '/home/eri-irfos', 'Desktop/kindom/execution/datasets');
export const FIRE_FILE = path.join(DATASETS_DIR, 'wildfire_forecasts.jsonl');
const LOCK_FILE = path.join(DATASETS_DIR, '.wildfire_forecast.lock');

const FEED = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv';
const CELL = 0.25;
const HOUR = 3_600_000;
const ISSUE_EVERY_H = 6;
const MIN_DETECTIONS = 4;
const TOP_N = 20;
const WINDOW_FROM_H = 24;
const WINDOW_TO_H = 72;

interface Det { t: number; cell: string; lat: number; lng: number; frp: number }

export interface FireForecast {
  type: 'issue';
  id: string;
  issued_utc: string;
  cell: string;
  lat: number;
  lng: number;
  detections_24h: number;
  frp_sum: number;
  band: string;
  p_keeps_burning: number;
  base_n: number;
  window_utc: [string, string];
  method: string;
  source: string;
  falsified_if: string;
}
export interface FireScore { type: 'score'; id: string; scored_utc: string; kept_burning: boolean; detections_in_window: number }

const cellKey = (lat: number, lng: number) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;
const band = (n: number) => (n >= 20 ? '20+' : n >= 8 ? '8-19' : '4-7');

let feedCache: { at: number; rows: Det[] } | null = null;

async function loadDetections(): Promise<Det[]> {
  if (feedCache && Date.now() - feedCache.at < 10 * 60_000) return feedCache.rows;
  const res = await fetch(FEED, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'DINGIR-FireForecast/1.0' } });
  if (!res.ok) throw new Error(`FIRMS answered ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  const head = lines[0].split(',');
  const ix = (k: string) => head.indexOf(k);
  const iLat = ix('latitude'), iLng = ix('longitude'), iDate = ix('acq_date'), iTime = ix('acq_time'), iConf = ix('confidence'), iFrp = ix('frp');
  if ([iLat, iLng, iDate, iTime].some(i => i < 0)) throw new Error('FIRMS columns changed');
  const rows: Det[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < head.length - 1) continue;
    const conf = parseFloat(c[iConf]);
    if (Number.isFinite(conf) && conf < 50) continue; // low-confidence detections are mostly noise
    const lat = parseFloat(c[iLat]), lng = parseFloat(c[iLng]);
    const hhmm = c[iTime].padStart(4, '0');
    const t = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(t)) continue;
    rows.push({ t, cell: cellKey(lat, lng), lat, lng, frp: parseFloat(c[iFrp]) || 0 });
  }
  feedCache = { at: Date.now(), rows };
  return rows;
}

function countByCell(dets: Det[], from: number, to: number) {
  const m = new Map<string, { n: number; frp: number; lat: number; lng: number }>();
  for (const d of dets) {
    if (d.t < from || d.t > to) continue;
    const e = m.get(d.cell) ?? { n: 0, frp: 0, lat: 0, lng: 0 };
    e.n++; e.frp += d.frp; e.lat += d.lat; e.lng += d.lng;
    m.set(d.cell, e);
  }
  return m;
}

/** For each past origin that has a full 24-72 h window in the feed: how many clusters of each band kept burning. */
function baseRates(dets: Det[], now: number): Record<string, { hits: number; n: number }> {
  const out: Record<string, { hits: number; n: number }> = { '4-7': { hits: 0, n: 0 }, '8-19': { hits: 0, n: 0 }, '20+': { hits: 0, n: 0 } };
  for (let day = 4; day <= 6; day++) {
    const t0 = now - day * 24 * HOUR;
    const today = countByCell(dets, t0 - 24 * HOUR, t0);
    const later = countByCell(dets, t0 + WINDOW_FROM_H * HOUR, t0 + WINDOW_TO_H * HOUR);
    for (const [cell, e] of today) {
      if (e.n < MIN_DETECTIONS) continue;
      const b = out[band(e.n)];
      b.n++;
      if (later.has(cell)) b.hits++;
    }
  }
  return out;
}

export async function readRecord(): Promise<{ issues: FireForecast[]; scores: Map<string, FireScore> }> {
  const issues: FireForecast[] = [];
  const scores = new Map<string, FireScore>();
  let text = '';
  try { text = await fs.readFile(FIRE_FILE, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'issue') issues.push(r); else if (r.type === 'score') scores.set(r.id, r);
    } catch { /* half-written last line */ }
  }
  return { issues, scores };
}

async function append(rows: object[]) {
  await fs.mkdir(DATASETS_DIR, { recursive: true });
  await appendJsonl(FIRE_FILE, rows as Array<{ type?: string; id?: string }>);
}

export async function issueForecasts(now = Date.now()): Promise<number> {
  const dets = await loadDetections();
  const rates = baseRates(dets, now);
  const today = countByCell(dets, now - 24 * HOUR, now);
  // Ranked by radiative power, but at most 3 cells per 5 degree block: otherwise one burning savanna fills the list.
  const perBlock = new Map<string, number>();
  const ranked = [...today.entries()].filter(([, e]) => e.n >= MIN_DETECTIONS).sort((a, b) => b[1].frp - a[1].frp).filter(([, e]) => {
    const k = `${Math.floor(e.lat / e.n / 5)},${Math.floor(e.lng / e.n / 5)}`;
    const c = perBlock.get(k) ?? 0;
    perBlock.set(k, c + 1);
    return c < 3;
  }).slice(0, TOP_N);
  const issued = new Date(now).toISOString();
  const rows: FireForecast[] = ranked.map(([cell, e]) => {
    const b = band(e.n);
    const r = rates[b];
    return {
      type: 'issue',
      id: `fire-${issued.slice(0, 13).replace(/\D/g, '')}-${cell.replace(/[^0-9-]/g, '_')}`,
      issued_utc: issued,
      cell,
      lat: +(e.lat / e.n).toFixed(3),
      lng: +(e.lng / e.n).toFixed(3),
      detections_24h: e.n,
      frp_sum: +e.frp.toFixed(1),
      band: b,
      p_keeps_burning: +((r.hits + 1) / (r.n + 2)).toFixed(3),
      base_n: r.n,
      window_utc: [new Date(now + WINDOW_FROM_H * HOUR).toISOString(), new Date(now + WINDOW_TO_H * HOUR).toISOString()],
      method: `Share of ${r.n} comparable clusters (${b} detections in 24 h, ${CELL} degree cell) in the previous days of the same feed that were seen burning again 24-72 h later, smoothed by +1/+2.`,
      source: 'NASA FIRMS MODIS C6.1 global 7-day file, confidence >= 50',
      falsified_if: 'the cell has no detection at all between 24 and 72 hours after issue; across many forecasts, the share that kept burning differs clearly from the stated probabilities.',
    };
  });
  if (rows.length) await append(rows);
  return rows.length;
}

export async function scoreDue(now = Date.now()): Promise<number> {
  const { issues, scores } = await readRecord();
  const due = issues.filter(f => !scores.has(f.id) && Date.parse(f.window_utc[1]) + 3 * HOUR <= now);
  if (!due.length) return 0;
  const dets = await loadDetections();
  const newest = dets.reduce((m, d) => Math.max(m, d.t), 0);
  const out: FireScore[] = [];
  for (const f of due) {
    const [from, to] = f.window_utc.map(Date.parse);
    // The 7-day file only reaches back 7 days; a window older than that cannot be checked honestly.
    if (from < now - 7 * 24 * HOUR) continue;
    // A feed that stops before the window ends would score a burning cell as "No", and the record is append-only.
    if (newest < to) continue;
    const hits = dets.filter(d => d.cell === f.cell && d.t >= from && d.t <= to).length;
    out.push({ type: 'score', id: f.id, scored_utc: new Date(now).toISOString(), kept_burning: hits > 0, detections_in_window: hits });
  }
  if (out.length) await append(out);
  return out.length;
}

export async function summary(now = Date.now()) {
  const { issues, scores } = await readRecord();
  const scored = issues.filter(f => scores.has(f.id));
  const hits = scored.filter(f => scores.get(f.id)!.kept_burning).length;
  const meanP = scored.length ? scored.reduce((s, f) => s + f.p_keeps_burning, 0) / scored.length : null;
  const brier = scored.length ? scored.reduce((s, f) => s + (f.p_keeps_burning - (scores.get(f.id)!.kept_burning ? 1 : 0)) ** 2, 0) / scored.length : null;
  const unscored = issues.filter(f => !scores.has(f.id));
  const open = unscored.filter(f => Date.parse(f.window_utc[1]) > now);
  const latest = issues.length ? issues[issues.length - 1].issued_utc : null;
  return {
    issued: issues.length,
    scored: scored.length,
    hits,
    mean_p: meanP,
    brier,
    open: open.length,
    awaiting: unscored.length - open.length,
    next_issue_utc: latest ? new Date(Date.parse(latest) + ISSUE_EVERY_H * HOUR).toISOString() : null,
    open_forecasts: open.sort((a, b) => b.p_keeps_burning - a.p_keeps_burning || b.frp_sum - a.frp_sum).slice(0, 40),
    recent_scored: scored.slice(-12).reverse().map(f => ({ ...f, result: scores.get(f.id) })),
  };
}

/** One cycle: score what closed, then issue if the interval is due. Safe to call from several processes: a lock file keeps it single-writer. */
export async function runCycle(): Promise<void> {
  try {
    await fs.mkdir(DATASETS_DIR, { recursive: true });
    await withLock(LOCK_FILE, async () => {
      const scored = await scoreDue();
      const { issues } = await readRecord();
      const last = issues.length ? Date.parse(issues[issues.length - 1].issued_utc) : 0;
      let issued = 0;
      if (Date.now() - last >= ISSUE_EVERY_H * HOUR) issued = await issueForecasts();
      if (scored || issued) console.log(`[DINGIR] wildfire forecast cycle: scored ${scored}, issued ${issued}`);
    });
  } catch (e) {
    console.warn('[DINGIR] wildfire forecast cycle failed:', e instanceof Error ? e.message : e);
  }
}
