import { promises as fs } from 'fs';
import path from 'path';

/**
 * Gale forecast for operations in 16 cities.
 *
 * The question: will gusts reach 62 km/h (Beaufort 8, gale) in this city at any hour of the next 48 h?
 * Only cities with gusts of 40 km/h or more in the last 24 h get a forecast. The probability is the share
 * of the past two years of 6-hourly moments, over all 16 cities, in the same band of last-24h gust that were
 * followed by a gale within 48 h. It is a base rate, not a weather model: it does not look at the sky.
 * Outcome and history both come from Open-Meteo's hourly analysis, which is model data, not station readings.
 * Forecasts for different cities on the same day are correlated (one storm front crosses several).
 */

const DATASETS_DIR =
  process.env.KINDOM_DATASETS_DIR ||
  path.join(process.env.HOME || '/home/eri-irfos', 'Desktop/kindom/execution/datasets');
export const WEATHER_FILE = path.join(DATASETS_DIR, 'weather_forecasts.jsonl');
const LOCK_FILE = path.join(DATASETS_DIR, '.weather_forecast.lock');

const HOUR = 3_600_000;
const ISSUE_EVERY_H = 6;
const GALE = 62;
const WINDOW_H = 48;
const MIN_STATE = 40;
const MAX_ISSUE = 12;

const CITIES: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Vienna', lat: 48.21, lng: 16.37 }, { name: 'Frankfurt', lat: 50.11, lng: 8.68 }, { name: 'London', lat: 51.51, lng: -0.13 },
  { name: 'Rotterdam', lat: 51.92, lng: 4.48 }, { name: 'Madrid', lat: 40.42, lng: -3.70 }, { name: 'Rome', lat: 41.9, lng: 12.5 },
  { name: 'Istanbul', lat: 41.01, lng: 28.98 }, { name: 'Reykjavik', lat: 64.15, lng: -21.94 }, { name: 'New York', lat: 40.71, lng: -74.0 },
  { name: 'Miami', lat: 25.76, lng: -80.19 }, { name: 'Houston', lat: 29.76, lng: -95.37 }, { name: 'Tokyo', lat: 35.68, lng: 139.69 },
  { name: 'Manila', lat: 14.6, lng: 120.98 }, { name: 'Sydney', lat: -33.87, lng: 151.21 }, { name: 'Singapore', lat: 1.35, lng: 103.82 },
  { name: 'Mumbai', lat: 19.08, lng: 72.88 },
];

interface Hourly { t: number[]; g: number[] }
const bandOf = (m24: number) => (m24 >= 50 ? 'strong' : m24 >= MIN_STATE ? 'breezy' : 'calm');
const BAND_TEXT: Record<string, string> = { strong: 'gusts of 50 km/h or more', breezy: 'gusts of 40-49 km/h', calm: 'gusts below 40 km/h' };

async function getJson(url: string): Promise<{ hourly?: { time: string[]; wind_gusts_10m: Array<number | null> } }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'DINGIR-WeatherForecast/1.0' } });
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  return res.json();
}
function toHourly(j: Awaited<ReturnType<typeof getJson>>): Hourly {
  const t: number[] = [], g: number[] = [];
  const h = j.hourly;
  if (!h) return { t, g };
  for (let i = 0; i < h.time.length; i++) {
    const v = h.wind_gusts_10m[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    t.push(Date.parse(h.time[i] + 'Z')); g.push(v);
  }
  return { t, g };
}
function maxIn(h: Hourly, from: number, to: number): number {
  let m = -1;
  for (let i = 0; i < h.t.length; i++) if (h.t[i] >= from && h.t[i] < to && h.g[i] > m) m = h.g[i];
  return m;
}

let histCache: { at: number; rates: Record<string, { n: number; hits: number }> } | null = null;
async function baseRates(now: number) {
  if (histCache && now - histCache.at < 24 * HOUR) return histCache.rates;
  const end = new Date(now - 3 * 24 * HOUR).toISOString().slice(0, 10);
  const start = new Date(now - 2 * 365 * 24 * HOUR).toISOString().slice(0, 10);
  const rates: Record<string, { n: number; hits: number }> = { calm: { n: 0, hits: 0 }, breezy: { n: 0, hits: 0 }, strong: { n: 0, hits: 0 } };
  for (let i = 0; i < CITIES.length; i += 4) {
    const got = await Promise.all(CITIES.slice(i, i + 4).map(async c => toHourly(await getJson(
      `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lng}&start_date=${start}&end_date=${end}&hourly=wind_gusts_10m&timezone=UTC`))));
    for (const h of got) {
      if (h.t.length < 1000) continue;
      const idx = new Map(h.t.map((t, k) => [t, k]));
      const first = h.t[0] + 24 * HOUR, last = h.t[h.t.length - 1] - WINDOW_H * HOUR;
      for (let t = Math.ceil(first / (6 * HOUR)) * 6 * HOUR; t <= last; t += 6 * HOUR) {
        if (!idx.has(t)) continue;
        const m24 = maxIn(h, t - 24 * HOUR, t), mn = maxIn(h, t, t + WINDOW_H * HOUR);
        if (m24 < 0 || mn < 0) continue;
        const b = rates[bandOf(m24)]; b.n++; if (mn >= GALE) b.hits++;
      }
    }
  }
  histCache = { at: now, rates };
  return rates;
}

export interface WeatherForecast {
  type: 'issue'; id: string; issued_utc: string; city: string; lat: number; lng: number; band: string;
  gust_max_24h: number; p_gale: number; base_n: number; window_utc: [string, string]; method: string; source: string; falsified_if: string;
}
export interface WeatherScore { type: 'score'; id: string; scored_utc: string; gale: boolean; gust_max_window: number }

export async function readRecord(): Promise<{ issues: WeatherForecast[]; scores: Map<string, WeatherScore> }> {
  const issues: WeatherForecast[] = [];
  const scores = new Map<string, WeatherScore>();
  let text = '';
  try { text = await fs.readFile(WEATHER_FILE, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
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
  await fs.appendFile(WEATHER_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const recent = (c: { lat: number; lng: number }) =>
  getJson(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}&hourly=wind_gusts_10m&past_days=7&forecast_days=1&timezone=UTC`).then(toHourly);

export async function issueForecasts(now = Date.now()): Promise<number> {
  const rates = await baseRates(now);
  const issued = new Date(now).toISOString();
  const start = Math.floor(now / HOUR) * HOUR;
  const hot: Array<{ c: typeof CITIES[number]; m24: number }> = [];
  for (let i = 0; i < CITIES.length; i += 4) {
    const got = await Promise.all(CITIES.slice(i, i + 4).map(async c => ({ c, h: await recent(c) })));
    for (const { c, h } of got) {
      const m24 = maxIn(h, start - 24 * HOUR, start + HOUR);
      if (m24 >= MIN_STATE) hot.push({ c, m24 });
    }
  }
  const rows: WeatherForecast[] = hot.sort((a, b) => b.m24 - a.m24).slice(0, MAX_ISSUE).map(({ c, m24 }) => {
    const b = bandOf(m24), r = rates[b];
    return {
      type: 'issue', id: `weather-${issued.slice(0, 13).replace(/\D/g, '')}-${c.name.replace(/\W/g, '')}`, issued_utc: issued,
      city: c.name, lat: c.lat, lng: c.lng, band: b, gust_max_24h: +m24.toFixed(1),
      p_gale: +((r.hits + 1) / (r.n + 2)).toFixed(3), base_n: r.n,
      window_utc: [new Date(start).toISOString(), new Date(start + WINDOW_H * HOUR).toISOString()],
      method: `Share of ${r.n} six-hourly moments over two years in ${CITIES.length} cities where the last 24 h had ${BAND_TEXT[b]} and gusts reached ${GALE} km/h within the next ${WINDOW_H} h, smoothed +1/+2.`,
      source: 'Open-Meteo hourly wind gusts at 10 m (model analysis)',
      falsified_if: `gusts stay below ${GALE} km/h at every hour of the window; across many forecasts, the share of gales differs clearly from the stated probabilities.`,
    };
  });
  if (rows.length) await append(rows);
  return rows.length;
}

export async function scoreDue(now = Date.now()): Promise<number> {
  const { issues, scores } = await readRecord();
  const due = issues.filter(f => !scores.has(f.id) && Date.parse(f.window_utc[1]) + 3 * HOUR <= now);
  if (!due.length) return 0;
  const out: WeatherScore[] = [];
  const cache = new Map<string, Hourly>();
  for (const f of due) {
    const [from, to] = f.window_utc.map(Date.parse);
    if (from < now - 6 * 24 * HOUR) continue; // the 7-day recent feed cannot check older windows honestly
    let h = cache.get(f.city);
    if (!h) { h = await recent({ lat: f.lat, lng: f.lng }); cache.set(f.city, h); }
    const m = maxIn(h, from, to);
    if (m < 0) continue;
    out.push({ type: 'score', id: f.id, scored_utc: new Date(now).toISOString(), gale: m >= GALE, gust_max_window: +m.toFixed(1) });
  }
  if (out.length) await append(out);
  return out.length;
}

export async function summary(now = Date.now()) {
  const { issues, scores } = await readRecord();
  const scored = issues.filter(f => scores.has(f.id));
  const hits = scored.filter(f => scores.get(f.id)!.gale).length;
  const meanP = scored.length ? scored.reduce((s, f) => s + f.p_gale, 0) / scored.length : null;
  const brier = scored.length ? scored.reduce((s, f) => s + (f.p_gale - (scores.get(f.id)!.gale ? 1 : 0)) ** 2, 0) / scored.length : null;
  const unscored = issues.filter(f => !scores.has(f.id));
  const open = unscored.filter(f => Date.parse(f.window_utc[1]) > now);
  const latest = issues.length ? issues[issues.length - 1].issued_utc : null;
  return {
    issued: issues.length, scored: scored.length, hits, mean_p: meanP, brier,
    open: open.length, awaiting: unscored.length - open.length,
    next_issue_utc: latest ? new Date(Date.parse(latest) + ISSUE_EVERY_H * HOUR).toISOString() : null,
    open_forecasts: open.sort((a, b) => b.p_gale - a.p_gale || b.gust_max_24h - a.gust_max_24h).slice(0, 40),
    recent_scored: scored.slice(-12).reverse().map(f => ({ ...f, result: scores.get(f.id) })),
  };
}

export async function runCycle(): Promise<void> {
  try {
    const raw = await fs.readFile(LOCK_FILE, 'utf8').catch(() => '');
    const [pid, at] = raw.split(':').map(Number);
    let alive = false;
    if (pid && Date.now() - at < 15 * 60_000) { try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; } }
    if (alive) return;
    await fs.mkdir(DATASETS_DIR, { recursive: true });
    await fs.writeFile(LOCK_FILE, `${process.pid}:${Date.now()}`);
    const scored = await scoreDue();
    const { issues } = await readRecord();
    const last = issues.length ? Date.parse(issues[issues.length - 1].issued_utc) : 0;
    let issued = 0;
    if (Date.now() - last >= ISSUE_EVERY_H * HOUR) issued = await issueForecasts();
    if (scored || issued) console.log(`[DINGIR] weather forecast cycle: scored ${scored}, issued ${issued}`);
  } catch (e) {
    console.warn('[DINGIR] weather forecast cycle failed:', e instanceof Error ? e.message : e);
  } finally {
    await fs.rm(LOCK_FILE, { force: true }).catch(() => undefined);
  }
}
