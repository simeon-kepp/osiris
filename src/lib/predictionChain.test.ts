import { describe, it, expect } from 'vitest';
import {
  buildChain, omoriIntegral, omoriRatio,
  type MainshockForecast, type ForecastMethod, type ChainStage,
} from './predictionChain';

// The point of this file is NOT to check that the panel renders. It is to check
// that the explanation the panel shows is arithmetically the same object as the
// forecast the Python engine issued. Those are two independent implementations
// in two languages, and the only thing keeping them honest is a test that runs
// one against a record the other actually wrote.
//
// REAL_RECORD below is copied verbatim from the last line of
// kindom/execution/datasets/predictions.jsonl (issued 2026-08-17T18:59:18Z).
// It is not a fixture invented to pass -- if the engine's arithmetic changes,
// this test fails and that is the intended behaviour, not a nuisance.

const METHOD: ForecastMethod = {
  law: 'Omori-Utsu n(t)=K/(t+c)^p; K cancels in the ratio',
  p_fitted_on_our_catalogue: 1.1,
  p_published_range: [0.7, 1.5],
  c_days_ASSUMED_not_fitted: 0.1,
  min_magnitude: 5.0,
  radius_law: 'log10(r_km) = 0.5*M - 1.8',
  reference: "Utsu, Ogata & Matsu'ura (1995), J. Phys. Earth 43:1-33",
};

const REAL_RECORD: MainshockForecast = {
  mainshock_id: 'us6000tga9',
  mainshock_mag: 5.8,
  mainshock_place: '194 km NW of Oula Xiuma, China',
  mainshock_time_utc: '2026-07-28T03:34:05.627000+00:00',
  mainshock_lat: 35.429,
  mainshock_lon: 99.5557,
  aftershock_zone_radius_km: 12.6,
  days_elapsed_at_issue: 20.643,
  aftershocks_observed_so_far: 1,
  horizon_days: 2.0,
  predicted_count: 0.01,
  p_zero: 0.987084,
  p_at_least_one: 0.012916,
  p_two_or_more: 8.4e-5,
  percent_at_least_one: 1.3,
  interval_95_poisson: [0, 1],
  interval_from_published_p_range: [0.0, 0.04],
  resolving_query: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-07-28T03%3A34%3A05&endtime=2026-08-17T18%3A59%3A18&minmagnitude=5.0&orderby=time-asc&limit=20000&latitude=35.429&longitude=99.5557&maxradiuskm=12.589254117941667',
};

describe('omoriIntegral', () => {
  it('handles p=1 through the logarithmic branch, not the divide-by-zero one', () => {
    // At p=1 the power-law antiderivative has 1-p in the denominator. A naive
    // implementation returns Infinity here and the caller silently forecasts
    // nothing. The log form is the correct limit.
    const got = omoriIntegral(0, 10, 1.0, 0.1);
    expect(got).toBeCloseTo(Math.log(10.1 / 0.1), 12);
    expect(Number.isFinite(got)).toBe(true);
  });

  it('agrees with numeric integration for p != 1', () => {
    // Independent check: coarse Riemann sum over the same interval. If the
    // closed form were wrong, these would not meet.
    const p = 1.1, c = 0.1, a = 1, b = 9;
    const n = 400_000, h = (b - a) / n;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.pow(a + (i + 0.5) * h + c, -p) * h;
    expect(omoriIntegral(a, b, p, c)).toBeCloseTo(sum, 6);
  });
});

describe('omoriRatio reproduces the Python engine', () => {
  it('recomputes the issued forecast from the record it was issued with', () => {
    // THE CROSS-LANGUAGE CHECK. aftershock_forecast.py wrote predicted_count
    // 0.01 for this mainshock. This TypeScript reaches the same number from
    // the same inputs, so the panel is explaining the real forecast rather
    // than a plausible-looking reconstruction of it.
    const ratio = omoriRatio(REAL_RECORD, METHOD);
    const recomputed = ratio * REAL_RECORD.aftershocks_observed_so_far;
    expect(Number(recomputed.toFixed(2))).toBe(REAL_RECORD.predicted_count);
  });

  it('returns NaN rather than a confident zero when the denominator vanishes', () => {
    // The exact bug already found and fixed in the Python engine: `x / d if
    // d > 0 else 0.0` returns 0 for a negative denominator, which reads as
    // "certainly nothing will happen". NaN is honest; 0 is a false claim.
    const degenerate = { ...REAL_RECORD, days_elapsed_at_issue: 0 };
    expect(Number.isNaN(omoriRatio(degenerate, METHOD))).toBe(true);
  });
});

describe('buildChain', () => {
  const EXPECTED_ORDER: ChainStage[] = [
    'observation', 'observation', 'transformation', 'mechanism',
    'inference', 'uncertainty', 'result', 'evidence', 'limits',
  ];

  it('emits every stage, always in the same order', () => {
    // An operator comparing two forecasts must be comparing like with like.
    // A stage dropped for being uninteresting breaks that silently.
    expect(buildChain(REAL_RECORD, METHOD).map(s => s.stage)).toEqual(EXPECTED_ORDER);
  });

  it('states the probability in the uncertainty step', () => {
    // Standing instruction: a prediction never appears without its percentage.
    const unc = buildChain(REAL_RECORD, METHOD).find(s => s.stage === 'uncertainty')!;
    expect(unc.headline).toContain('1.3%');
  });

  it('carries the MEASURED over-confidence, not a generic clustering warning', () => {
    // The percentage this panel shows is produced by 1-exp(-lambda), and that
    // conversion was scored over 469,480 retrodictions and came out
    // over-confident. A reader must not be able to take the number at face
    // value without meeting that measurement, so it is asserted here rather
    // than left to survive future edits by luck.
    const unc = buildChain(REAL_RECORD, METHOD).find(s => s.stage === 'uncertainty')!;
    expect(unc.caveat).toContain('469,480');
    expect(unc.caveat).toContain('87%');
    expect(unc.caveat).toMatch(/upper\s+bound/);
  });

  it('shows the inference arithmetic, not just its answer', () => {
    const inf = buildChain(REAL_RECORD, METHOD).find(s => s.stage === 'inference')!;
    expect(inf.headline).toContain(String(REAL_RECORD.predicted_count));
    expect(inf.headline).toContain(String(REAL_RECORD.aftershocks_observed_so_far));
    expect(inf.detail).toContain('K cancels');
  });

  it('carries the resolving query as an openable link', () => {
    const ev = buildChain(REAL_RECORD, METHOD).find(s => s.stage === 'evidence')!;
    expect(ev.href).toBe(REAL_RECORD.resolving_query);
  });

  it('flags a zero-observation sequence instead of quietly forecasting from nothing', () => {
    const zero = { ...REAL_RECORD, aftershocks_observed_so_far: 0 };
    const obs = buildChain(zero, METHOD).filter(s => s.stage === 'observation')[1];
    expect(obs.caveat).toMatch(/floor, not an estimate/);
    // ...and the same step on the real record must NOT carry that caveat,
    // otherwise the warning is decoration rather than a signal.
    const real = buildChain(REAL_RECORD, METHOD).filter(s => s.stage === 'observation')[1];
    expect(real.caveat).toBeUndefined();
  });

  it('reports a scored verdict with both numbers once the window has closed', () => {
    const scored = { ...REAL_RECORD, actual_count: 3, verdict: 'MISS' as const };
    const res = buildChain(scored, METHOD).find(s => s.stage === 'result')!;
    expect(res.headline).toContain('MISS');
    expect(res.headline).toContain('actual 3');
    expect(res.detail).toContain('a miss is the only thing that carries information');
  });

  it('keeps the catalogue-mutability limit attached to every forecast', () => {
    // Measured 2026-08-17. This is a property of the data source, so it is not
    // conditional on which forecast is being viewed -- it must never be
    // possible to read a verdict without reading this.
    const lim = buildChain(REAL_RECORD, METHOD).find(s => s.stage === 'limits')!;
    expect(lim.detail).toContain('1283');
    expect(lim.caveat).toContain('reproducible in method but not in data');
  });
});
