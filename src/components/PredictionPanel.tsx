'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, Maximize2, Minimize2, ExternalLink, AlertTriangle } from 'lucide-react';
import { useLocale } from '@/lib/LocaleProvider';
import {
  buildChain, type MainshockForecast, type ForecastMethod, type ChainStep, type ChainStage,
} from '@/lib/predictionChain';

// Standing forecasts, each one openable down to the arithmetic that produced it.
//
// WHY THIS IS ITS OWN TOOL AND NOT A SECTION OF THE REASONING FEED. The feed
// answers "what is DINGIR noticing right now" and its entries are disposable --
// they change on every snapshot and nobody is accountable for one of them. A
// forecast is the opposite: it is fixed at issue time, it names a deadline, and
// it will be scored whether or not anyone is watching. Mixing the two taught
// the reader to skim both. Separated, the scoreboard at the top of this panel
// is the honest summary of a claim the system cannot walk back.
//
// THE TWO CLICK TARGETS are deliberate and different, per the operator's own
// request. The TITLE opens the reasoning panel on the mainshock node -- that is
// "what else does the corpus know about this earthquake". The BODY opens the
// causality chain -- that is "why does this number say what it says". They are
// distinct questions and conflating them into one click loses one of them.
//
// EVERY probability is rendered as a percent, never as a bare expected count.
// An expected count of 0.04 and a 4.3% chance are the same fact, but only one
// of them is a fact a person can act on.

type Forecast = {
  issued_at_utc: string;
  target_window_utc: [string, string];
  method: ForecastMethod;
  mainshocks_considered: number;
  total_predicted_aftershocks: number;
  total_probabilities?: { percent_at_least_one?: number; p_zero?: number; p_two_or_more?: number };
  total_interval_95: [number, number];
  per_mainshock: MainshockForecast[];
  falsified_if?: string;
  scored?: unknown;
};

type Payload = {
  latest: Forecast | null;
  history: Forecast[];
  scoreboard: {
    runs: number; cases_scored: number; hits: number; misses: number;
    coverage: number | null; nominal_coverage: number | null; latest_run_at: string | null;
  };
  source: { malformed_lines_skipped: number; engine_has_not_run: boolean };
};

const STAGE_COLOUR: Record<ChainStage, string> = {
  observation: '#00f5c4',    // measured, take at face value
  transformation: '#7fd4ff',
  mechanism: '#ffd166',
  inference: '#b388ff',      // same violet the feed uses for hypotheses
  uncertainty: '#ff9f43',
  result: '#ffffff',
  evidence: '#00f5c4',
  limits: '#ff6b6b',         // the one an operator must not skip
};

/** Warm for likely, cold for unlikely. A forecast list read at a glance should
 *  sort itself visually before anyone reads a number. */
function probColour(p: number): string {
  if (p >= 66) return '#ff6b6b';
  if (p >= 33) return '#ffd166';
  if (p >= 10) return '#7fd4ff';
  return '#8a8aa0';
}

function fmtWindow(a: string, b: string): string {
  return `${a.replace('T', ' ').slice(0, 16)} → ${b.replace('T', ' ').slice(0, 16)} UTC`;
}

interface Props {
  onClose: () => void;
  /** Opens the reasoning/whitebox panel on a node id. */
  onInspect?: (nodeId: string) => void;
  /** Width in px already occupied to the right of this panel, if anything is
   *  stacked there. Passed as a number rather than a boolean so this component
   *  never has to guess another panel's width -- the bug that made the feed
   *  disappear behind a fullscreened whitebox. */
  offsetRight?: number;
  /** Reported upward so whatever else is on screen can lay out around the real
   *  width instead of a hardcoded constant. */
  onWidthChange?: (px: number) => void;
}

export default function PredictionPanel({ onClose, onInspect, offsetRight = 0, onWidthChange }: Props) {
  const { t: tr } = useLocale();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openChain, setOpenChain] = useState<string | null>(null);

  const width = expanded ? 900 : 460;
  useEffect(() => { onWidthChange?.(width); }, [width, onWidthChange]);
  useEffect(() => () => onWidthChange?.(0), [onWidthChange]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/predictions')
        .then(r => {
          // 404 is the gate, not a missing route -- say so plainly rather than
          // showing an empty panel that looks like "no forecasts exist".
          if (r.status === 404) throw new Error(tr('pred.gated'));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(j => { if (alive) { setData(j); setError(null); } })
        .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    };
    load();
    // Forecasts are issued by a separate engine run, not continuously. A slow
    // poll is enough and keeps this off the hot path of a dashboard that was
    // already measured to be laggy.
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, [tr]);

  // predictions.jsonl is append-only across every forecast kind the DINGIR
  // engine issues, not just this panel's aftershock-count forecasts (a
  // wildfire-persistence forecast landed as `latest` on 2026-08-19, with none
  // of this shape's fields). `data.latest` is only "the newest line in the
  // whole file", not "the newest forecast this panel understands" -- so this
  // panel falls back to the newest entry in `history` that actually has
  // `per_mainshock`, rather than assuming the newest LINE is always one of
  // its own. `api/predictions` itself is intentionally left alone: `latest`
  // there is a real, honestly-documented, locked-down contract ("the newest
  // line, full stop") that other consumers of the same file are entitled to
  // rely on.
  const isAftershockForecast = (r: unknown): r is Forecast =>
    !!r && typeof r === 'object' && Array.isArray((r as { per_mainshock?: unknown }).per_mainshock);
  const f = isAftershockForecast(data?.latest)
    ? data!.latest
    : (data?.history.find(isAftershockForecast) ?? null);
  const sb = data?.scoreboard;
  const windowOpen = f ? new Date(f.target_window_utc[1]).getTime() > Date.now() : false;
  // Sorted by probability, not by the engine's discovery order: the operator's
  // first question is "which of these is most likely", and a list that answers
  // it by position answers it before it is asked.
  const rows = f ? [...f.per_mainshock].sort(
    (a, b) => (b.percent_at_least_one ?? 0) - (a.percent_at_least_one ?? 0)) : [];
  // Resolved from the id rather than stored as an object: if a poll replaces
  // the forecast while the modal is open, this follows the new record instead
  // of showing a stale copy of the old one.
  const chain = rows.find(m => m.mainshock_id === openChain) ?? null;

  // Escape closes the modal. Registered only while it is open, so it cannot
  // swallow the key from the panel or the map underneath.
  useEffect(() => {
    if (!chain) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenChain(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chain]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 500, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 500, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed top-0 h-full z-[498] flex flex-col glass-panel"
        style={{
          right: offsetRight,
          width: `min(${width}px, ${expanded ? 95 : 92}vw)`,
          borderLeft: '1px solid var(--border-primary)',
          borderRadius: 0,
        }}
      >
        {/* ── header: the scoreboard first, because a forecast tool with no
            track record is a marketing surface ───────────────────────────── */}
        <div className="flex items-start justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div>
            <div className="hud-text text-[13px] text-[var(--text-primary)]">
              {tr('pred.title')}
            </div>
            <div className="text-[9px] text-[var(--text-muted)] tabular-nums tracking-wide">
              {sb && sb.cases_scored > 0
                ? `${sb.hits} hit · ${sb.misses} miss · ${((sb.coverage ?? 0) * 100).toFixed(0)}% coverage` +
                  (sb.nominal_coverage ? ` vs ${(sb.nominal_coverage * 100).toFixed(0)}% nominal` : '') +
                  ` · ${sb.cases_scored} scored`
                : (error || tr('pred.loading'))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setExpanded(e => !e)} title={expanded ? 'Collapse' : 'Expand'}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              {expanded ? <Minimize2 className="w-4 h-4 text-[var(--text-muted)]" />
                        : <Maximize2 className="w-4 h-4 text-[var(--text-muted)]" />}
            </button>
            <button onClick={onClose} title="Close"
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              <X className="w-4 h-4 text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        {/* ── calibration line: over-coverage is a failure, and saying so here
            stops the scoreboard reading as a score to maximise ───────────── */}
        {sb && sb.coverage !== null && sb.nominal_coverage && (
          <div className="px-4 py-2 border-b border-white/[0.06] shrink-0 text-[9px] tabular-nums leading-relaxed text-[var(--text-muted)]">
            {sb.coverage > sb.nominal_coverage + 0.15
              ? <span className="text-[#ffd166]">{tr('pred.overcovered')}</span>
              : sb.coverage < sb.nominal_coverage - 0.15
                ? <span className="text-[#ff6b6b]">{tr('pred.undercovered')}</span>
                : <span>{tr('pred.calibrated')}</span>}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!data && !error ? (
            <div className="flex h-full items-center justify-center gap-2 px-6 text-[11px] text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {tr('pred.loading')}
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">
              {error}
            </div>
          ) : !f ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--text-muted)]">
              {tr('pred.empty')}
            </div>
          ) : (
            <>
              {/* ── the aggregate claim ────────────────────────────────── */}
              <div className="px-4 py-3 border-b border-white/[0.06]">
                <div className="flex items-baseline gap-2">
                  <span className="tabular-nums text-[26px] leading-none"
                    style={{ color: probColour(f.total_probabilities?.percent_at_least_one ?? 0) }}>
                    {(f.total_probabilities?.percent_at_least_one ?? 0).toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
                    {tr('pred.atleastone')}
                  </span>
                </div>
                <div className="mt-1.5 text-[10px] tabular-nums text-[var(--text-muted)] leading-relaxed">
                  {tr('pred.expected')} {f.total_predicted_aftershocks} · 95%
                  [{f.total_interval_95[0]}, {f.total_interval_95[1]}] ·
                  {' '}{f.mainshocks_considered} {tr('pred.sequences')}
                  <br />
                  {fmtWindow(f.target_window_utc[0], f.target_window_utc[1])}
                  {' · '}
                  <span className={windowOpen ? 'text-[var(--cyan-primary)]' : 'text-[var(--text-muted)]'}>
                    {windowOpen ? tr('pred.open') : tr('pred.closed')}
                  </span>
                </div>
                {f.falsified_if && (
                  <p className="mt-2 text-[10px] leading-relaxed text-[#ff9f43]">
                    <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5" />
                    {f.falsified_if}
                  </p>
                )}
              </div>

              {/* ── one row per sequence ───────────────────────────────── */}
              {rows.map(m => {
                const pctv = m.percent_at_least_one ?? 0;
                const chainOpen = openChain === m.mainshock_id;
                const [lo, hi] = m.interval_95_poisson;
                return (
                  <div key={m.mainshock_id} className="border-b border-white/[0.04]">
                    {/* TITLE -> whitebox on the mainshock node */}
                    <button
                      onClick={() => onInspect?.(`QUAKE:${m.mainshock_id}`)}
                      title={tr('pred.title.hint')}
                      className="block w-full text-left px-4 pt-2.5 pb-1 hover:bg-white/[0.03] transition-colors group">
                      <span className="text-[11px] tabular-nums text-[var(--text-primary)] group-hover:text-[var(--cyan-primary)] transition-colors">
                        M{m.mainshock_mag} · {m.mainshock_place}
                      </span>
                    </button>

                    {/* BODY -> the causality chain */}
                    <button
                      onClick={() => setOpenChain(chainOpen ? null : m.mainshock_id)}
                      title={tr('pred.body.hint')}
                      className={`block w-full text-left px-4 pb-2.5 hover:bg-white/[0.03] transition-colors ${chainOpen ? 'bg-white/[0.03]' : ''}`}>
                      <div className="flex items-baseline gap-2">
                        <span className="tabular-nums text-[15px]" style={{ color: probColour(pctv) }}>
                          {pctv.toFixed(1)}%
                        </span>
                        <span className="text-[9px] tabular-nums text-[var(--text-muted)]">
                          {tr('pred.expected')} {m.predicted_count} · 95% [{lo}, {hi}]
                        </span>
                        {m.verdict && (
                          <span className={`ml-auto text-[8px] tabular-nums tracking-widest border rounded px-1 ${
                            m.verdict === 'HIT'
                              ? 'text-[#00f5c4] border-[#00f5c4]/40'
                              : 'text-[#ff6b6b] border-[#ff6b6b]/40'}`}>
                            {m.verdict} {m.actual_count}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[9px] tabular-nums text-[var(--text-muted)]">
                        {m.aftershocks_observed_so_far} {tr('pred.observed')} ·{' '}
                        {m.aftershock_zone_radius_km} km · {m.horizon_days}d ·{' '}
                        <span className="text-[var(--cyan-primary)]">
                          {chainOpen ? tr('pred.chain.hide') : tr('pred.chain.show')}
                        </span>
                      </div>
                    </button>

                  </div>
                );
              })}

              {/* ── method footer: the same for every row, so it is stated
                  once rather than nine times ─────────────────────────── */}
              <div className="px-4 py-3 text-[9px] tabular-nums text-[var(--text-muted)] leading-relaxed">
                {f.method.law}<br />
                p={f.method.p_fitted_on_our_catalogue} (published {f.method.p_published_range[0]}–{f.method.p_published_range[1]}) ·
                {' '}c={f.method.c_days_ASSUMED_not_fitted}d assumed · M≥{f.method.min_magnitude}<br />
                {f.method.reference}
                {data?.source.malformed_lines_skipped ? (
                  <><br /><span className="text-[#ff9f43]">
                    {data.source.malformed_lines_skipped} {tr('pred.skipped')}
                  </span></>
                ) : null}
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* ── the causality chain, as a real modal ──────────────────────────
          WAS AN INLINE ACCORDION, AND IT WAS WRONG TWICE. It animated
          height 0 -> auto inside an already-scrolling container, which did
          not reliably open at all; and even when it did, nine stages of
          reasoning were being folded into a 460px column where sentences
          and a 300-character USGS query had nowhere to wrap.

          A causality chain is the thing an operator actually reads before
          acting on a number. It gets the screen, not a gutter. */}
      <AnimatePresence>
        {chain && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[700] flex items-center justify-center p-4 sm:p-8"
            style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }}
            onClick={() => setOpenChain(null)}
          >
            <motion.div
              initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              // Stops a click inside the dialog from reaching the backdrop
              // handler and closing it mid-read.
              onClick={e => e.stopPropagation()}
              role="dialog" aria-modal="true"
              className="glass-panel w-full max-w-3xl max-h-[88vh] flex flex-col"
              style={{ border: '1px solid var(--border-primary)' }}
            >
              <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-white/[0.08] shrink-0">
                <div className="min-w-0">
                  <div className="hud-text text-[13px] text-[var(--text-primary)]">
                    {tr('pred.chain.title')}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--text-primary)] break-words">
                    M{chain.mainshock_mag} · {chain.mainshock_place}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-muted)] tabular-nums">
                    <span style={{ color: probColour(chain.percent_at_least_one ?? 0) }}>
                      {(chain.percent_at_least_one ?? 0).toFixed(1)}%
                    </span>
                    {' '}{tr('pred.atleastone')} · {tr('pred.expected')} {chain.predicted_count}
                    {' '}· 95% [{chain.interval_95_poisson[0]}, {chain.interval_95_poisson[1]}]
                  </div>
                </div>
                <button onClick={() => setOpenChain(null)} title={tr('pred.chain.close')}
                  className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4 text-[var(--text-muted)]" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {f && buildChain(chain, f.method).map((s: ChainStep, i, all) => (
                  <div key={i} className="px-5 py-3.5 border-b border-white/[0.05] last:border-b-0">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: STAGE_COLOUR[s.stage] }} />
                      <span className="text-[9px] tracking-[0.2em] text-[var(--text-muted)]">
                        {s.stage.toUpperCase()}
                      </span>
                      {/* Position in the chain, so a reader can see how far
                          the inference has travelled from the observation. */}
                      <span className="ml-auto text-[9px] tabular-nums text-[var(--text-muted)]">
                        {i + 1}/{all.length}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[13px] text-[var(--text-primary)] leading-snug break-words">
                      {s.headline}
                    </div>
                    <p className="mt-1.5 text-[12px] text-[var(--text-muted)] leading-relaxed break-words">
                      {s.detail}
                    </p>
                    {s.caveat && (
                      <p className="mt-2 text-[12px] leading-relaxed text-[#ff9f43] break-words">
                        <AlertTriangle className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5 shrink-0" />
                        {s.caveat}
                      </p>
                    )}
                    {s.href && (
                      // break-all, not break-words: the resolving query is a
                      // 300-character URL with no spaces, so word-boundary
                      // wrapping leaves it overflowing exactly as reported.
                      <a href={s.href} target="_blank" rel="noopener noreferrer"
                        className="mt-2 flex items-start gap-1.5 text-[11px] tabular-nums text-[var(--cyan-primary)] hover:underline break-all">
                        <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span className="min-w-0">{s.href}</span>
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </AnimatePresence>
  );
}
