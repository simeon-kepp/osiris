import { promises as fs } from 'fs';
import path from 'path';
import { withLock, appendJsonl, lowerBound } from './forecast-io';

/**
 * Geomagnetic storm forecast.
 *
 * The question: will the planetary Kp index reach 5 or more (a G1 storm) at any point in the next
 * 72 hours? The state is the highest Kp of the last 24 hours, in three bands. The probability is the
 * share of the past three years of 6-hourly moments in the same band that were followed by a Kp >= 5
 * within 72 hours (Potsdam GFZ definitive/nowcast Kp, public). Windows of consecutive forecasts overlap,
 * so the scoreboard counts correlated forecasts; the Brier score is still honest, the sample is smaller
 * than its row count suggests.
 */

const DATASETS_DIR =
  process.env.KINDOM_DATASETS_DIR ||
  path.join(process.env.HOME || '/home/eri-irfos', 'Desktop/kindom/execution/datasets');
export const SPACE_FILE = path.join(DATASETS_DIR, 'space_forecasts.jsonl');
const LOCK_FILE = path.join(DATASETS_DIR, '.space_forecast.lock');

const HOUR = 3_600_000;
const STEP = 3 * HOUR;
const ISSUE_EVERY_H = 6;
const LOOKBACK_YEARS = 3;
const STORM = 5;
const WINDOW_H = 72;

interface Kp { t: number; kp: number }
let cache: { at: number; rows: Kp[] } | null = null;

async function loadKp(now: number): Promise<Kp[]> {
  if (cache && now - cache.at < 30 * 60_000) return cache.rows;
  const start = new Date(now - LOOKBACK_YEARS * 365 * 24 * HOUR).toISOString().slice(0, 19) + 'Z';
  const end = new Date(now).toISOString().slice(0, 19) + 'Z';
  const res = await fetch(`https://kp.gfz.de/app/json/?start=${start}&end=${end}&index=Kp`, {
    signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'DINGIR-SpaceForecast/1.0' },
  });
  if (!res.ok) throw new Error(`GFZ answered ${res.status}`);
  const j = await res.json() as { datetime: string[]; Kp: number[] };
  const rows: Kp[] = [];
  for (let i = 0; i < j.datetime.length; i++) {
    const t = Date.parse(j.datetime[i]);
    if (Number.isFinite(t) && Number.isFinite(j.Kp[i]) && t + STEP <= now) rows.push({ t, kp: j.Kp[i] });
  }
  rows.sort((a, b) => a.t - b.t);
  cache = { at: now, rows };
  return rows;
}

export const bandOf = (max24: number) => (max24 >= STORM ? 'storm' : max24 >= 4 ? 'active' : 'quiet');
const BAND_TEXT: Record<string, string> = { storm: 'a storm (Kp 5+) in the last 24 h', active: 'active (Kp 4) in the last 24 h', quiet: 'quiet (Kp below 4) in the last 24 h' };

function maxIn(rows: Kp[], from: number, to: number, ts: number[] = rows.map(r => r.t)): number {
  let m = -1;
  for (let i = lowerBound(ts, from); i < rows.length && rows[i].t < to; i++) if (rows[i].kp > m) m = rows[i].kp;
  return m;
}

function countIn(rows: Kp[], from: number, to: number): number {
  const ts = rows.map(r => r.t);
  return lowerBound(ts, to) - lowerBound(ts, from);
}

export function baseRates(rows: Kp[]) {
  const out: Record<string, { n: number; hits: number }> = { quiet: { n: 0, hits: 0 }, active: { n: 0, hits: 0 }, storm: { n: 0, hits: 0 } };
  if (!rows.length) return out;
  const first = rows[0].t + 24 * HOUR;
  const last = rows[rows.length - 1].t + STEP - WINDOW_H * HOUR;
  const idx = new Map(rows.map((r, i) => [r.t, i]));
  const ts = rows.map(r => r.t);
  for (let t = Math.ceil(first / (6 * HOUR)) * 6 * HOUR; t <= last; t += 6 * HOUR) {
    const m24 = maxIn(rows, t - 24 * HOUR, t, ts);
    const mNext = maxIn(rows, t, t + WINDOW_H * HOUR, ts);
    if (m24 < 0 || mNext < 0 || !idx.has(t)) continue;
    const b = out[bandOf(m24)];
    b.n++;
    if (mNext >= STORM) b.hits++;
  }
  return out;
}

export interface SpaceForecast {
  type: 'issue'; id: string; issued_utc: string; band: string; kp_now: number; kp_max_24h: number;
  p_storm: number; base_n: number; window_utc: [string, string]; method: string; source: string; falsified_if: string;
}
export interface SpaceScore { type: 'score'; id: string; scored_utc: string; storm: boolean; kp_max_window: number }

export async function readRecord(): Promise<{ issues: SpaceForecast[]; scores: Map<string, SpaceScore> }> {
  const issues: SpaceForecast[] = [];
  const scores = new Map<string, SpaceScore>();
  let text = '';
  try { text = await fs.readFile(SPACE_FILE, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
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
  await appendJsonl(SPACE_FILE, rows as Array<{ type?: string; id?: string }>);
}

export async function issueForecasts(now = Date.now()): Promise<number> {
  const rows = await loadKp(now);
  if (rows.length < 1000) throw new Error('too little Kp history');
  const rates = baseRates(rows);
  // The window starts at the end of the last completed 3 h interval, which is where the data ends.
  const t0 = rows[rows.length - 1].t + STEP;
  const m24 = maxIn(rows, t0 - 24 * HOUR, t0);
  const b = bandOf(m24);
  const r = rates[b];
  const issued = new Date(now).toISOString();
  const row: SpaceForecast = {
    type: 'issue',
    id: `space-${issued.slice(0, 13).replace(/\D/g, '')}`,
    issued_utc: issued,
    band: b,
    kp_now: rows[rows.length - 1].kp,
    kp_max_24h: m24,
    p_storm: +((r.hits + 1) / (r.n + 2)).toFixed(3),
    base_n: r.n,
    window_utc: [new Date(t0).toISOString(), new Date(t0 + WINDOW_H * HOUR).toISOString()],
    method: `Share of ${r.n} six-hourly moments in the past ${LOOKBACK_YEARS} years where the situation was ${BAND_TEXT[b]} and Kp reached ${STORM}+ within the next ${WINDOW_H} h, smoothed +1/+2.`,
    source: 'GFZ Potsdam planetary Kp index',
    falsified_if: `Kp stays below ${STORM} for the whole window; across many forecasts, the share of storms differs clearly from the stated probabilities.`,
  };
  await append([row]);
  return 1;
}

export async function scoreDue(now = Date.now()): Promise<number> {
  const { issues, scores } = await readRecord();
  const due = issues.filter(f => !scores.has(f.id) && Date.parse(f.window_utc[1]) + 3 * HOUR <= now);
  if (!due.length) return 0;
  const rows = await loadKp(now);
  const out: SpaceScore[] = [];
  for (const f of due) {
    const [from, to] = f.window_utc.map(Date.parse);
    const m = maxIn(rows, from, to);
    if (m < 0) continue;
    // GFZ publishes with a lag. A window the data does not fully cover would score a storm as "No" for good.
    if (rows[rows.length - 1].t + STEP < to || countIn(rows, from, to) < Math.floor((WINDOW_H / 3) * 0.9)) continue;
    out.push({ type: 'score', id: f.id, scored_utc: new Date(now).toISOString(), storm: m >= STORM, kp_max_window: m });
  }
  if (out.length) await append(out);
  return out.length;
}

export async function summary(now = Date.now()) {
  const { issues, scores } = await readRecord();
  const scored = issues.filter(f => scores.has(f.id));
  const hits = scored.filter(f => scores.get(f.id)!.storm).length;
  const meanP = scored.length ? scored.reduce((s, f) => s + f.p_storm, 0) / scored.length : null;
  const brier = scored.length ? scored.reduce((s, f) => s + (f.p_storm - (scores.get(f.id)!.storm ? 1 : 0)) ** 2, 0) / scored.length : null;
  const unscored = issues.filter(f => !scores.has(f.id));
  const open = unscored.filter(f => Date.parse(f.window_utc[1]) > now);
  const latest = issues.length ? issues[issues.length - 1].issued_utc : null;
  return {
    issued: issues.length, scored: scored.length, hits, mean_p: meanP, brier,
    open: open.length, awaiting: unscored.length - open.length,
    next_issue_utc: latest ? new Date(Date.parse(latest) + ISSUE_EVERY_H * HOUR).toISOString() : null,
    open_forecasts: open.slice(-12).reverse(),
    recent_scored: scored.slice(-12).reverse().map(f => ({ ...f, result: scores.get(f.id) })),
  };
}

export async function runCycle(): Promise<void> {
  try {
    await fs.mkdir(DATASETS_DIR, { recursive: true });
    await withLock(LOCK_FILE, async () => {
      const scored = await scoreDue();
      const { issues } = await readRecord();
      const last = issues.length ? Date.parse(issues[issues.length - 1].issued_utc) : 0;
      let issued = 0;
      if (Date.now() - last >= ISSUE_EVERY_H * HOUR) issued = await issueForecasts();
      if (scored || issued) console.log(`[DINGIR] space forecast cycle: scored ${scored}, issued ${issued}`);
    });
  } catch (e) {
    console.warn('[DINGIR] space forecast cycle failed:', e instanceof Error ? e.message : e);
  }
}
