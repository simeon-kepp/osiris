import { promises as fs } from 'fs';
import path from 'path';

/**
 * Market volatility persistence forecast.
 *
 * The question: an instrument is swinging harder than usual right now. Will it still be swinging
 * that hard over the next 5 daily bars?
 *
 * "Swinging" = realised volatility over 5 daily log returns (RV5). "Harder than usual" = above that
 * instrument's own 75th percentile over the past year. Every forecast is appended once and never
 * edited; scoring adds a separate line once 5 completed daily bars exist after the issue day.
 * The probability is a pooled base rate: across all tracked instruments, on the days RV5 sat above
 * its own 75th percentile, the share where the next 5 bars were again above it. The threshold uses
 * the whole year, so the base rate is mildly in-sample; only the scoring on new days is a real test.
 */

const DATASETS_DIR =
  process.env.KINDOM_DATASETS_DIR ||
  path.join(process.env.HOME || '/home/eri-irfos', 'Desktop/kindom/execution/datasets');
export const MARKET_FILE = path.join(DATASETS_DIR, 'market_forecasts.jsonl');
const LOCK_FILE = path.join(DATASETS_DIR, '.market_forecast.lock');

const DAY = 86_400_000;
const H = 5;            // bars in the swing window
const Q = 0.75;         // "high" = above own 75th percentile
const MIN_BARS = 120;

const TICKERS: Array<{ symbol: string; name: string }> = [
  { symbol: 'ES=F', name: 'S&P 500' }, { symbol: 'NQ=F', name: 'Nasdaq 100' }, { symbol: '^VIX', name: 'VIX' },
  { symbol: 'DX-Y.NYB', name: 'Dollar Index' }, { symbol: '^TNX', name: 'US 10Y' },
  { symbol: 'RTX', name: 'RTX' }, { symbol: 'LMT', name: 'LMT' }, { symbol: 'NOC', name: 'NOC' },
  { symbol: 'GD', name: 'GD' }, { symbol: 'BA', name: 'BA' }, { symbol: 'LHX', name: 'LHX' }, { symbol: 'PLTR', name: 'PLTR' },
  { symbol: 'CL=F', name: 'WTI Crude' }, { symbol: 'BZ=F', name: 'Brent Crude' }, { symbol: 'NG=F', name: 'Natural Gas' },
  { symbol: 'GC=F', name: 'Gold' }, { symbol: 'SI=F', name: 'Silver' }, { symbol: 'HG=F', name: 'Copper' },
  { symbol: 'ZW=F', name: 'Wheat' }, { symbol: 'ZC=F', name: 'Corn' },
  { symbol: 'BTC-USD', name: 'Bitcoin' }, { symbol: 'ETH-USD', name: 'Ethereum' },
  { symbol: 'SOL-USD', name: 'Solana' }, { symbol: 'XRP-USD', name: 'XRP' },
];

interface Bar { day: string; close: number }
interface Series { symbol: string; name: string; bars: Bar[] }

export interface MarketForecast {
  type: 'issue';
  id: string;
  issued_utc: string;
  symbol: string;
  name: string;
  as_of_day: string;
  rv5: number;
  threshold: number;
  p_stays_high: number;
  base_n: number;
  window_utc: [string, string];
  method: string;
  source: string;
  falsified_if: string;
}
export interface MarketScore { type: 'score'; id: string; scored_utc: string; stayed_high: boolean; rv5_next: number }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let cache: { at: number; series: Series[] } | null = null;

async function loadOne(t: { symbol: string; name: string }, today: string): Promise<Series | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t.symbol)}?interval=1d&range=1y`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const cl: Array<number | null> = r?.indicators?.quote?.[0]?.close ?? [];
    const bars: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = cl[i];
      if (!Number.isFinite(c) || !(c as number > 0)) continue;
      const day = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (day >= today) continue; // the bar of the current UTC day is still moving
      if (bars.length && bars[bars.length - 1].day === day) bars[bars.length - 1].close = c as number; else bars.push({ day, close: c as number });
    }
    return bars.length >= MIN_BARS ? { ...t, bars } : null;
  } catch { return null; }
}

async function loadAll(now: number): Promise<Series[]> {
  if (cache && now - cache.at < 30 * 60_000) return cache.series;
  const today = new Date(now).toISOString().slice(0, 10);
  const out: Series[] = [];
  for (let i = 0; i < TICKERS.length; i += 6) {
    const got = await Promise.all(TICKERS.slice(i, i + 6).map(t => loadOne(t, today)));
    for (const s of got) if (s) out.push(s);
  }
  cache = { at: now, series: out };
  return out;
}

/** RV5 ending at bar i (needs i >= H): standard deviation of the last H daily log returns. */
function rv(bars: Bar[], i: number): number {
  const r: number[] = [];
  for (let k = i - H + 1; k <= i; k++) r.push(Math.log(bars[k].close / bars[k - 1].close));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function analyse(series: Series[]) {
  let n = 0, hits = 0;
  const now: Array<{ s: Series; rv5: number; thr: number }> = [];
  for (const s of series) {
    const rvs: number[] = [];
    for (let i = H; i < s.bars.length; i++) rvs.push(rv(s.bars, i));
    const thr = quantile(rvs, Q);
    for (let k = 0; k + H < rvs.length; k++) {
      if (rvs[k] >= thr) { n++; if (rvs[k + H] >= thr) hits++; }
    }
    const last = rvs[rvs.length - 1];
    if (last >= thr) now.push({ s, rv5: last, thr });
  }
  return { p: (hits + 1) / (n + 2), n, now };
}

export async function readRecord(): Promise<{ issues: MarketForecast[]; scores: Map<string, MarketScore> }> {
  const issues: MarketForecast[] = [];
  const scores = new Map<string, MarketScore>();
  let text = '';
  try { text = await fs.readFile(MARKET_FILE, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
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
  await fs.appendFile(MARKET_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export async function issueForecasts(now = Date.now()): Promise<number> {
  const series = await loadAll(now);
  const { p, n, now: hot } = analyse(series);
  const { issues } = await readRecord();
  const have = new Set(issues.map(f => f.id));
  const issued = new Date(now).toISOString();
  const rows: MarketForecast[] = [];
  for (const { s, rv5, thr } of hot.sort((a, b) => b.rv5 / b.thr - a.rv5 / a.thr)) {
    const asOf = s.bars[s.bars.length - 1].day;
    const id = `mkt-${asOf.replace(/-/g, '')}-${s.symbol.replace(/[^A-Za-z0-9]/g, '_')}`;
    if (have.has(id)) continue;
    rows.push({
      type: 'issue', id, issued_utc: issued, symbol: s.symbol, name: s.name, as_of_day: asOf,
      rv5: +rv5.toFixed(5), threshold: +thr.toFixed(5), p_stays_high: +p.toFixed(3), base_n: n,
      window_utc: [issued, new Date(now + 8 * DAY).toISOString()],
      method: `Pooled over ${series.length} instruments and the past year: on ${n} days when 5-day volatility sat above the instrument's own 75th percentile, the share where the next 5 daily bars were again above it, smoothed +1/+2.`,
      source: 'Yahoo Finance daily closes, completed UTC days only',
      falsified_if: 'the volatility of the 5 daily bars after the as-of day falls below the stated threshold; across many forecasts, the share that stayed high differs clearly from the stated probabilities.',
    });
  }
  if (rows.length) await append(rows);
  return rows.length;
}

export async function scoreDue(now = Date.now()): Promise<number> {
  const { issues, scores } = await readRecord();
  const due = issues.filter(f => !scores.has(f.id));
  if (!due.length) return 0;
  const series = await loadAll(now);
  const out: MarketScore[] = [];
  for (const f of due) {
    const s = series.find(x => x.symbol === f.symbol);
    if (!s) continue;
    const i0 = s.bars.findIndex(b => b.day === f.as_of_day);
    if (i0 < 0 || s.bars.length - 1 < i0 + H) continue; // 5 completed bars after the as-of day are not there yet
    const next = rv(s.bars, i0 + H);
    out.push({ type: 'score', id: f.id, scored_utc: new Date(now).toISOString(), stayed_high: next >= f.threshold, rv5_next: +next.toFixed(5) });
  }
  if (out.length) await append(out);
  return out.length;
}

export async function summary(now = Date.now()) {
  const { issues, scores } = await readRecord();
  const scored = issues.filter(f => scores.has(f.id));
  const hits = scored.filter(f => scores.get(f.id)!.stayed_high).length;
  const meanP = scored.length ? scored.reduce((s, f) => s + f.p_stays_high, 0) / scored.length : null;
  const brier = scored.length ? scored.reduce((s, f) => s + (f.p_stays_high - (scores.get(f.id)!.stayed_high ? 1 : 0)) ** 2, 0) / scored.length : null;
  const unscored = issues.filter(f => !scores.has(f.id));
  const open = unscored.filter(f => Date.parse(f.window_utc[1]) > now);
  const latest = issues.length ? issues[issues.length - 1].issued_utc : null;
  const nextDay = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:10:00Z').getTime() + DAY;
  return {
    issued: issues.length, scored: scored.length, hits, mean_p: meanP, brier,
    open: open.length, awaiting: unscored.length - open.length,
    next_issue_utc: new Date(latest && Date.parse(latest) > nextDay - DAY ? nextDay : Math.max(now, nextDay - DAY)).toISOString(),
    open_forecasts: open.sort((a, b) => b.rv5 / b.threshold - a.rv5 / a.threshold).slice(0, 40),
    recent_scored: scored.slice(-12).reverse().map(f => ({ ...f, result: scores.get(f.id) })),
  };
}

/** One cycle: score what closed, then issue for any instrument that is hot and has no forecast for its latest bar yet. */
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
    const issued = await issueForecasts();
    if (scored || issued) console.log(`[DINGIR] market forecast cycle: scored ${scored}, issued ${issued}`);
  } catch (e) {
    console.warn('[DINGIR] market forecast cycle failed:', e instanceof Error ? e.message : e);
  } finally {
    await fs.rm(LOCK_FILE, { force: true }).catch(() => undefined);
  }
}
