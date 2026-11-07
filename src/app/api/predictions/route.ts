import { cachedRoute } from '@/lib/routeCache';
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { currentLogin } from '@/lib/dingirSessionServer';

// The forecast record and the scoreboard, served from the append-only files the
// forecast engine writes.
//
// WHY THIS READS FILES INSTEAD OF PROXYING bi_api.py. The rest of the reasoning
// surface proxies the model server because it needs the trained graph in
// memory. This does not: a forecast is a finished artifact, already written to
// disk at issue time, and the whole claim being made about it is that it was
// fixed BEFORE the outcome was known. Routing it through a live model would
// reintroduce exactly the doubt the append-only file removes. Reading the file
// is not a shortcut here, it is the point.
//
// Gated like the rest of the reasoning surface: no session, 404 rather than
// 403, so probing the public demo does not confirm the endpoint exists.
//
// PATH SAFETY. Two fixed filenames, joined to one configured directory. No part
// of the request reaches the filesystem, so there is no traversal surface.

const DATASETS_DIR =
  process.env.KINDOM_DATASETS_DIR ||
  path.join(process.env.HOME || '/home/eri-irfos', 'Desktop/kindom/execution/datasets');

const PREDICTIONS = 'predictions.jsonl';
const LEDGER = 'prediction_ledger.jsonl';
const WORKER_STATE = 'forecast_worker_state.json';

/** Parse JSON Lines, skipping malformed lines rather than failing the request.
 *  A half-written last line is the normal state of a file being appended to by
 *  another process; losing the whole scoreboard over it would be wrong. The
 *  count of skipped lines is returned so the panel can say so instead of
 *  quietly showing less than there is. */
function parseJsonl(text: string): { rows: unknown[]; skipped: number } {
  const rows: unknown[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { skipped++; }
  }
  return { rows, skipped };
}

async function readJsonl(file: string): Promise<{ rows: unknown[]; skipped: number; missing: boolean }> {
  try {
    const text = await fs.readFile(path.join(DATASETS_DIR, file), 'utf8');
    return { ...parseJsonl(text), missing: false };
  } catch (e) {
    // ENOENT is a real state worth distinguishing from a read error: it means
    // the engine has not run yet, not that something is broken.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rows: [], skipped: 0, missing: true };
    }
    throw e;
  }
}

async function readWorkerState(): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(path.join(DATASETS_DIR, WORKER_STATE), 'utf8');
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { worker: 'degraded', last_error: `state unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function forecastStatus(row: unknown, now = Date.now()): 'OPEN' | 'AWAITING_SCORE' | 'SCORED' | 'UNKNOWN' {
  if (!row || typeof row !== 'object') return 'UNKNOWN';
  const r = row as { scored?: unknown; target_window_utc?: unknown };
  if (r.scored === true) return 'SCORED';
  const window = Array.isArray(r.target_window_utc) ? r.target_window_utc : [];
  const end = typeof window[1] === 'string' ? Date.parse(window[1]) : NaN;
  if (Number.isFinite(end)) return end > now ? 'OPEN' : 'AWAITING_SCORE';
  return 'UNKNOWN';
}

type LedgerRun = {
  run_at_utc?: string;
  cases_scored?: number;
  hits?: number;
  misses?: number;
  coverage?: number;
  nominal_coverage?: number;
  cases?: unknown[];
};

async function compute() {
  try {
    const [preds, ledger, worker] = await Promise.all([
      readJsonl(PREDICTIONS), readJsonl(LEDGER), readWorkerState(),
    ]);

    const runs = ledger.rows as LedgerRun[];
    // The scoreboard is summed across every backtest run rather than taken from
    // the newest one. A single run's coverage is a small-n number; the standing
    // claim ("N falsifications") is cumulative, so the display has to be too.
    let hits = 0, misses = 0, incompleteRuns = 0;
    for (const r of runs) {
      const h = Number.isFinite(r.hits) ? Math.max(0, r.hits as number) : 0;
      const explicitMisses = Number.isFinite(r.misses) ? Math.max(0, r.misses as number) : null;
      const cases = Number.isFinite(r.cases_scored) ? Math.max(0, r.cases_scored as number) : null;
      if (explicitMisses !== null) {
        hits += Math.min(h, h + explicitMisses);
        misses += explicitMisses;
      } else if (cases !== null) {
        hits += Math.min(h, cases);
        misses += Math.max(0, cases - h);
      } else if (h > 0) {
        incompleteRuns += 1;
      }
    }
    const scored = hits + misses;

    const liveForecasts = preds.rows.filter(row =>
      !!row && typeof row === 'object' && (row as { kind?: unknown }).kind === 'aftershock_count_forecast');
    const liveStatuses = liveForecasts.map(row => forecastStatus(row));
    const liveScored = liveForecasts.filter(row => forecastStatus(row) === 'SCORED') as Array<Record<string, unknown>>;
    const liveHits = liveScored.filter(row => row.within_95_interval === true).length;

    return NextResponse.json({
      latest: preds.rows.length ? preds.rows[preds.rows.length - 1] : null,
      // Newest first, and bounded -- the panel is a live tool, not an archive
      // browser. The file itself stays the full record.
      history: preds.rows.slice(-25).reverse(),
      scoreboard: {
        runs: runs.length,
        cases_scored: scored,
        hits,
        misses,
        incomplete_runs: incompleteRuns,
        // Coverage recomputed from the totals, NOT averaged across runs:
        // averaging percentages over runs of different size is a real error
        // that would quietly overweight a 3-case run against a 40-case one.
        coverage: scored > 0 ? hits / scored : null,
        nominal_coverage: runs.length ? runs[runs.length - 1].nominal_coverage ?? null : null,
        latest_run_at: runs.length ? runs[runs.length - 1].run_at_utc ?? null : null,
      },
      live: {
        total: liveForecasts.length,
        open: liveStatuses.filter(s => s === 'OPEN').length,
        awaiting_score: liveStatuses.filter(s => s === 'AWAITING_SCORE').length,
        scored: liveScored.length,
        hits: liveHits,
        misses: liveScored.length - liveHits,
        coverage: liveScored.length ? liveHits / liveScored.length : null,
      },
      worker,
      source: {
        predictions_file: PREDICTIONS,
        ledger_file: LEDGER,
        malformed_lines_skipped: preds.skipped + ledger.skipped,
        engine_has_not_run: preds.missing,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `prediction store unreadable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}

export async function GET() {
  // The gate sits BEFORE the cache. Inside compute() it ran only on a cache
  // miss, so one signed-in visit served the scoreboard to anyone for 60 s.
  if (!(await currentLogin())) return new NextResponse(null, { status: 404 });
  return cachedRoute('src/app/api/predictions/route.ts', 60000, () => compute());
}
