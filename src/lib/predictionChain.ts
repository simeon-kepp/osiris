// The causality chain behind one aftershock forecast, as data rather than prose.
//
// WHY THIS IS A LIBRARY AND NOT JSX. The panel could format these sentences
// inline, and it would look identical. It is separated for one reason: a
// whitebox explanation that only exists inside a React component cannot be
// unit-tested, cannot be served to an auditor without a browser, and drifts
// away from the numbers it claims to explain the moment somebody edits the
// markup. Here it is a pure function over the forecast record, so
// predictionChain.test.ts can assert that the explanation still matches the
// arithmetic -- see the "inference step reproduces the stated count" case.
//
// THE STAGE VOCABULARY is fixed and ordered: observation -> transformation ->
// mechanism -> inference -> uncertainty -> result -> evidence -> limits. Every
// forecast renders the same eight stages in the same order, so an operator
// comparing two predictions is comparing like with like. A stage is never
// omitted for being uninteresting; a stage with nothing to say says so.
//
// PROVENANCE. Everything here is derived from fields the forecast engine wrote
// (kindom/execution/intelligence/aftershock_forecast.py). Nothing is fetched,
// nothing is inferred beyond the arithmetic shown. `resolving_query` is the
// literal USGS URL the engine will use to score itself, so a reader can open
// it and count the events by hand.

export type ForecastMethod = {
  law: string;
  p_fitted_on_our_catalogue: number;
  p_published_range: [number, number];
  c_days_ASSUMED_not_fitted: number;
  min_magnitude: number;
  radius_law: string;
  reference: string;
};

export type MainshockForecast = {
  mainshock_id: string;
  mainshock_mag: number;
  mainshock_place: string;
  mainshock_time_utc: string;
  mainshock_lat: number;
  mainshock_lon: number;
  aftershock_zone_radius_km: number;
  days_elapsed_at_issue: number;
  aftershocks_observed_so_far: number;
  horizon_days: number;
  predicted_count: number;
  p_zero?: number;
  p_at_least_one?: number;
  p_two_or_more?: number;
  percent_at_least_one?: number;
  interval_95_poisson: [number, number];
  interval_from_published_p_range: [number, number];
  resolving_query: string;
  /** Written by the scorer once the window has closed. Absent while open. */
  actual_count?: number;
  verdict?: 'HIT' | 'MISS';
};

export type ChainStage =
  | 'observation' | 'transformation' | 'mechanism' | 'inference'
  | 'uncertainty' | 'result' | 'evidence' | 'limits';

export type ChainStep = {
  stage: ChainStage;
  /** One line an operator reads first. */
  headline: string;
  /** The arithmetic or the source, spelled out. Never a summary of itself. */
  detail: string;
  /** Present only where a step rests on something unproven. */
  caveat?: string;
  /** A URL a reader can open to check the step without trusting us. */
  href?: string;
};

/** Omori-Utsu integrated over [a, b] days, with K left out because it cancels.
 *  Exported so the test can check the panel's arithmetic against an
 *  independent evaluation rather than against itself. */
export function omoriIntegral(a: number, b: number, p: number, c: number): number {
  if (p === 1) return Math.log((b + c) / (a + c));
  const e = 1 - p;
  return (Math.pow(b + c, e) - Math.pow(a + c, e)) / e;
}

/** The ratio that turns "n observed so far" into "n expected next".
 *  K cancels, which is the whole reason this method needs no K estimate. */
export function omoriRatio(m: MainshockForecast, method: ForecastMethod): number {
  const c = method.c_days_ASSUMED_not_fitted;
  const p = method.p_fitted_on_our_catalogue;
  const t1 = m.days_elapsed_at_issue;
  const t2 = t1 + m.horizon_days;
  const past = omoriIntegral(0, t1, p, c);
  const future = omoriIntegral(t1, t2, p, c);
  // `past === 0` cannot happen for t1 > 0, but a zero denominator would
  // silently return 0 and look like a confident "nothing will happen" --
  // the exact failure mode already found and fixed in the Python engine.
  return past !== 0 ? future / past : Number.NaN;
}

function pct(x: number | undefined): string {
  return x === undefined ? '—' : `${x.toFixed(1)}%`;
}

function iso(s: string): string {
  return s.replace('T', ' ').slice(0, 19) + ' UTC';
}

export function buildChain(m: MainshockForecast, method: ForecastMethod): ChainStep[] {
  const ratio = omoriRatio(m, method);
  const t1 = m.days_elapsed_at_issue;
  const t2 = t1 + m.horizon_days;
  const [lo, hi] = m.interval_95_poisson;
  const [plo, phi] = m.interval_from_published_p_range;

  const steps: ChainStep[] = [
    {
      stage: 'observation',
      headline: `M${m.mainshock_mag} — ${m.mainshock_place}`,
      detail:
        `Mainshock recorded ${iso(m.mainshock_time_utc)} at ` +
        `${m.mainshock_lat.toFixed(4)}, ${m.mainshock_lon.toFixed(4)}. ` +
        `USGS event id ${m.mainshock_id}.`,
      href: `https://earthquake.usgs.gov/earthquakes/eventpage/${m.mainshock_id}`,
    },
    {
      stage: 'observation',
      headline:
        `${m.aftershocks_observed_so_far} aftershocks M≥${method.min_magnitude} ` +
        `in the first ${t1.toFixed(2)} days`,
      detail:
        `Counted inside the aftershock zone, not globally. This single ` +
        `integer is the only quantity the forecast learns from this ` +
        `sequence — everything downstream is it, scaled.`,
      caveat:
        m.aftershocks_observed_so_far === 0
          ? 'Zero observed means the ratio has nothing to scale. Any forecast from it is a floor, not an estimate.'
          : undefined,
    },
    {
      stage: 'transformation',
      headline: `Aftershock zone → ${m.aftershock_zone_radius_km} km radius`,
      detail:
        `${method.radius_law}, evaluated at M${m.mainshock_mag}. ` +
        `Events outside this circle are not counted as belonging to this sequence.`,
      caveat:
        'A circle is a crude stand-in for a rupture, which is a plane with a ' +
        'strike. For a long strike-slip rupture this both over-counts ' +
        'perpendicular to the fault and under-counts along it.',
    },
    {
      stage: 'mechanism',
      headline: `Omori-Utsu decay, p=${method.p_fitted_on_our_catalogue}`,
      detail:
        `${method.law}. c=${method.c_days_ASSUMED_not_fitted} days. ` +
        `Aftershock rate falls off as a power law in time since the mainshock; ` +
        `this is an empirical law with a century of support, not a fitted curve ` +
        `of ours.`,
      caveat:
        `c is ASSUMED, not fitted. p is a single global value; the backtest ` +
        `showed errors running in BOTH directions across sequences, which is ` +
        `evidence that one global p cannot capture sequence-to-sequence variation.`,
      href: 'https://doi.org/10.4294/jpe1952.43.1',
    },
    {
      stage: 'inference',
      headline: `Rate ratio ${Number.isFinite(ratio) ? ratio.toFixed(4) : 'undefined'} × ${m.aftershocks_observed_so_far} observed = ${m.predicted_count}`,
      detail:
        `∫ over the forecast window [${t1.toFixed(2)}, ${t2.toFixed(2)}] days ` +
        `divided by ∫ over the elapsed window [0, ${t1.toFixed(2)}] days. ` +
        `K cancels in the division, so no productivity constant has to be ` +
        `estimated — this is what lets the method run on a bare count.`,
    },
    {
      stage: 'uncertainty',
      headline: `P(at least one) = ${pct(m.percent_at_least_one)}`,
      detail:
        `Expected count ${m.predicted_count} → P(exactly 0) = ` +
        `${pct(m.p_zero !== undefined ? m.p_zero * 100 : undefined)}, ` +
        `P(2 or more) = ${pct(m.p_two_or_more !== undefined ? m.p_two_or_more * 100 : undefined)}. ` +
        `95% Poisson interval [${lo}, ${hi}]. Re-running the mechanism across ` +
        `the published p range ${method.p_published_range[0]}–${method.p_published_range[1]} ` +
        `gives [${plo}, ${phi}], which is the METHOD uncertainty as distinct ` +
        `from the counting uncertainty.`,
      caveat:
        'MEASURED, no longer just a caveat: the same 1−e^−λ conversion was ' +
        'scored over 469,480 headless retrodictions of the 2016–2026 ' +
        'catalogue (retrodiction_etas.py) and came out over-confident at ' +
        'every level, worse the more confident it got — a stated 87% happened ' +
        '48% of the time. Part of that is clustering: occupied cell-windows ' +
        'held 1.33 events on average against a Poisson 1.02, an over-' +
        'dispersion factor of 1.31. The rest points at the rate itself being ' +
        'too high after large events. Treat this percentage as an upper ' +
        'bound until the same reliability test has been run on THIS forecast.',
    },
    {
      stage: 'result',
      headline:
        m.verdict
          ? `${m.verdict} — predicted ${m.predicted_count} [${lo}, ${hi}], actual ${m.actual_count}`
          : `Open — expecting ${m.predicted_count} events, ${pct(m.percent_at_least_one)} chance of at least one`,
      detail: m.verdict
        ? (m.verdict === 'HIT'
            ? 'The observed count fell inside the stated interval.'
            : 'The observed count fell outside the stated interval. Recorded, not discarded — a miss is the only thing that carries information about where the method is wrong.')
        : 'The window has not closed yet. The resolving query below decides this, and it was fixed before the outcome was known.',
    },
    {
      stage: 'evidence',
      headline: 'The query that will score this, written in advance',
      detail:
        'A forecast that picks its own test after the fact is not a forecast. ' +
        'This URL was recorded at issue time; opening it returns the events ' +
        'that decide the verdict, and anyone can count them.',
      href: m.resolving_query,
    },
    {
      stage: 'limits',
      headline: 'The USGS catalogue is mutable — measured, not assumed',
      detail:
        'Checked 2026-08-17 against the Feb 2023 Kahramanmaraş sequence: 34 of ' +
        '34 events had been modified more than a day after they occurred, the ' +
        'largest lag 1283 days. The M7.8 mainshock carries 10 superseded origin ' +
        'versions; its magnitude held at 7.8 but its epicentre moved ~3 km ' +
        'between the first and last. So the answer this query returns today is ' +
        'not guaranteed to be the answer it returns next year.',
      caveat:
        'Until an as-of snapshot is captured at scoring time, a verdict is ' +
        'reproducible in method but not in data. This is the current top gap.',
      href: 'https://earthquake.usgs.gov/data/comcat/',
    },
  ];

  return steps;
}
