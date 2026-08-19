import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Two properties are worth locking down here, and neither is visible in the UI.
//
// 1. THE GATE. This route serves forecasts the system will be held to. It must
//    answer 404 without a session -- 403 would confirm the endpoint exists to
//    anyone probing the public demo. Same pattern as reasoning/graph.
//
// 2. THE SCOREBOARD ARITHMETIC. Coverage is recomputed from summed totals, not
//    averaged across runs. Averaging percentages over runs of different size
//    overweights a small run against a large one, and the resulting number
//    would look perfectly reasonable while being wrong. That is exactly the
//    class of error a test has to catch, because nobody spots it by reading.

const currentLogin = vi.fn();
vi.mock('@/lib/dingirSessionServer', () => ({
  currentLogin: () => currentLogin(),
  authConfigured: () => true,
}));

let dir: string;

async function seed(predictions: unknown[], ledger: unknown[]) {
  await fs.writeFile(path.join(dir, 'predictions.jsonl'),
    predictions.map(p => JSON.stringify(p)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'prediction_ledger.jsonl'),
    ledger.map(p => JSON.stringify(p)).join('\n') + '\n');
}

async function get() {
  const { GET } = await import('./route');
  return GET();
}

describe('GET /api/predictions', () => {
  beforeEach(async () => {
    currentLogin.mockReset();
    vi.resetModules();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preds-'));
    process.env.KINDOM_DATASETS_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.KINDOM_DATASETS_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('answers 404 when nobody is signed in', async () => {
    currentLogin.mockResolvedValue(null);
    await seed([{ issued_at_utc: 'x' }], []);
    expect((await get()).status).toBe(404);
  });

  it('returns the newest forecast as `latest`, not the first line', async () => {
    // The file is append-only, so the last line is the current forecast. Taking
    // rows[0] would silently serve the oldest one forever.
    currentLogin.mockResolvedValue('zabih-sudo');
    await seed(
      [{ issued_at_utc: '2026-08-10T00:00:00Z' }, { issued_at_utc: '2026-08-17T18:59:18Z' }],
      []);
    const body = await (await get()).json();
    expect(body.latest.issued_at_utc).toBe('2026-08-17T18:59:18Z');
    expect(body.history[0].issued_at_utc).toBe('2026-08-17T18:59:18Z'); // newest first
  });

  it('sums the scoreboard across runs and derives coverage from the totals', async () => {
    currentLogin.mockResolvedValue('zabih-sudo');
    await seed([], [
      { hits: 3, misses: 1, cases_scored: 4, nominal_coverage: 0.68 },   // 75%
      { hits: 13, misses: 7, cases_scored: 20, nominal_coverage: 0.68 }, // 65%
    ]);
    const { scoreboard } = await (await get()).json();
    expect(scoreboard.hits).toBe(16);
    expect(scoreboard.misses).toBe(8);
    expect(scoreboard.cases_scored).toBe(24);
    // 16/24 = 0.6667. Averaging the two run percentages would give 0.70 --
    // a plausible-looking number that overweights the 4-case run sixfold.
    expect(scoreboard.coverage).toBeCloseTo(16 / 24, 10);
    expect(scoreboard.coverage).not.toBeCloseTo((0.75 + 0.65) / 2, 3);
  });

  it('survives a half-written last line and reports how many it skipped', async () => {
    // Normal state of a file another process is appending to. Losing the whole
    // scoreboard over one torn line would be the wrong trade.
    currentLogin.mockResolvedValue('zabih-sudo');
    await fs.writeFile(path.join(dir, 'predictions.jsonl'),
      '{"issued_at_utc":"2026-08-17T18:59:18Z"}\n{"issued_at_utc":"trunc');
    await fs.writeFile(path.join(dir, 'prediction_ledger.jsonl'), '');
    const body = await (await get()).json();
    expect(body.latest.issued_at_utc).toBe('2026-08-17T18:59:18Z');
    expect(body.source.malformed_lines_skipped).toBe(1);
  });

  it('distinguishes "the engine has not run" from a read failure', async () => {
    // A missing file is a real, expected state on a fresh checkout. It must not
    // surface as a 502, which would send someone hunting a broken route.
    currentLogin.mockResolvedValue('zabih-sudo');
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latest).toBeNull();
    expect(body.source.engine_has_not_run).toBe(true);
  });

  it('serves the real forecast store when it is present', async () => {
    // Not a fixture: reads the actual file the engine writes, if this machine
    // has one. Skipped rather than failed elsewhere, so the suite stays
    // portable while still exercising the real schema where it exists.
    const real = path.join(process.env.HOME || '', 'Desktop/kindom/execution/datasets');
    let exists = true;
    try { await fs.access(path.join(real, 'predictions.jsonl')); } catch { exists = false; }
    if (!exists) return;

    process.env.KINDOM_DATASETS_DIR = real;
    currentLogin.mockResolvedValue('zabih-sudo');
    const body = await (await get()).json();
    expect(body.latest).not.toBeNull();
    // `latest` is honestly "the newest line in the file, full stop" (locked
    // down by the test above) -- the file is no longer aftershock-forecast
    // only as of 2026-08-19 (a wildfire-persistence forecast is a real,
    // valid entry with none of these fields), so this test finds the newest
    // AFTERSHOCK forecast the same way PredictionPanel.tsx does, rather than
    // assuming the newest line is always one.
    const aftershockForecast = Array.isArray(body.latest?.per_mainshock)
      ? body.latest
      : (body.history as unknown[]).find(
          (r: any) => Array.isArray(r?.per_mainshock),
        );
    expect(aftershockForecast).toBeTruthy();
    expect(Array.isArray(aftershockForecast.per_mainshock)).toBe(true);
    expect(aftershockForecast.per_mainshock.length).toBeGreaterThan(0);
    // The standing instruction: a prediction never ships without its percent.
    for (const m of aftershockForecast.per_mainshock) {
      expect(typeof m.percent_at_least_one).toBe('number');
    }
    expect(body.scoreboard.cases_scored).toBeGreaterThan(0);
  });
});
