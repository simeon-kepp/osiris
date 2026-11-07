'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, Maximize2, Minimize2, ExternalLink, AlertTriangle, Download, Settings, History, ChevronRight } from 'lucide-react';
import { useLocale } from '@/lib/LocaleProvider';
import {
  buildChain, type MainshockForecast, type ForecastMethod, type ChainStep, type ChainStage,
} from '@/lib/predictionChain';
import { FORECAST_DOMAINS, FORECAST_STATUS_STYLE } from '@/lib/forecastDomains';

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
  scored_at_utc?: string;
  actual_count?: number;
  within_95_interval?: boolean;
  verdict?: string;
};

type Payload = {
  latest: Forecast | null;
  history: Forecast[];
  scoreboard: {
    runs: number; cases_scored: number; hits: number; misses: number;
    coverage: number | null; nominal_coverage: number | null; latest_run_at: string | null;
  };
  live: { total: number; open: number; awaiting_score: number; scored: number; hits: number; misses: number; coverage: number | null };
  worker: { worker?: string; last_cycle_at_utc?: string; last_success_at_utc?: string; next_issue_due_utc?: string; last_error?: string } | null;
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

/** Width of the causality-chain column that opens beside the forecast table. */
const CHAIN_W = 440;

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
  const [selectedIssuedAt, setSelectedIssuedAt] = useState<string | null>(null);
  // The audit trail is the primary product of this panel, not a hidden debug
  // drawer. Keep it visible so the operator sees open/awaiting/scored rows.
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const width = (expanded ? 1120 : 860) + (openChain ? CHAIN_W : 0);
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
  const forecastHistory = data?.history.filter(isAftershockForecast) ?? [];
  const selected = selectedIssuedAt
    ? forecastHistory.find(forecast => forecast.issued_at_utc === selectedIssuedAt) ?? null
    : null;
  const f = selected ?? (isAftershockForecast(data?.latest)
    ? data!.latest
    : (forecastHistory[0] ?? null));
  const sb = data?.scoreboard;
  const forecastState = f
    ? (f.scored ? 'SCORED' : new Date(f.target_window_utc[1]).getTime() > Date.now() ? 'OPEN' : 'AWAITING_SCORE')
    : null;
  const windowOpen = forecastState === 'OPEN';
  // Sorted by probability, not by the engine's discovery order: the operator's
  // first question is "which of these is most likely", and a list that answers
  // it by position answers it before it is asked.
  const rows = f ? [...f.per_mainshock].sort(
    (a, b) => (b.percent_at_least_one ?? 0) - (a.percent_at_least_one ?? 0)) : [];
  const tracked = forecastHistory.slice(0, 8);
  // Resolved from the id rather than stored as an object: if a poll replaces
  // the forecast while the modal is open, this follows the new record instead
  // of showing a stale copy of the old one.
  const chain = rows.find(m => m.mainshock_id === openChain) ?? null;

  const exportHistory = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data.history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dingir-forecast-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatCountdown = (value?: string) => {
    if (!value) return '—';
    const seconds = Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1000));
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  useEffect(() => { if (openChain && data && !chain) setOpenChain(null); }, [openChain, data, chain]);

  // Escape closes the chain column. Registered only while it is open, so it cannot
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
        className="fixed top-0 h-full z-[498] flex flex-row glass-panel overflow-hidden bg-[#080c15]"
        style={{
          left: 'auto',
          right: offsetRight,
          width: expanded || openChain
            ? `min(${width}px, calc(100vw - ${offsetRight}px))`
            : `min(${width}px, 68vw)`,
          transition: 'width 0.38s cubic-bezier(0.2, 0.8, 0.2, 1), right 0.38s cubic-bezier(0.2, 0.8, 0.2, 1)',
          borderLeft: '1px solid var(--border-primary)',
          borderRadius: 0,
        }}
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
        {/* ── header: the scoreboard first, because a forecast tool with no
            track record is a marketing surface ───────────────────────────── */}
        <div className="px-5 py-4 border-b border-white/[0.08] shrink-0">
          <div className="flex items-start justify-between mb-4">
            <div>
            <div className="hud-text text-[13px] text-[var(--text-primary)]">
              {tr('pred.title')}
            </div>
            <div className="mt-1 text-[9px] text-[#c3c8d2] tracking-wide">LIVE FORECAST CONTROL CENTER</div>
            </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setExpanded(e => !e)} title={expanded ? 'Collapse' : 'Expand'}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              {expanded ? <Minimize2 className="w-4 h-4 text-[#c3c8d2]" />
                        : <Maximize2 className="w-4 h-4 text-[#c3c8d2]" />}
            </button>
            <button onClick={onClose} title="Close"
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              <X className="w-4 h-4 text-[#c3c8d2]" />
            </button>
          </div>
          </div>
          {/* The loop this tool runs, left to right: issue a forecast, follow it while its window is open,
              score it against what happened. Three numbers, one per step. */}
          {(() => {
            const scoredN = sb ? sb.hits + sb.misses : 0;
            const running = data?.worker?.worker === 'running';
            const steps = [
              { n: '1', label: 'PREDICT', value: formatCountdown(data?.worker?.next_issue_due_utc), sub: 'until the next forecast is issued', dot: running ? '#00f5c4' : '#ffd166', dotLabel: running ? 'engine running' : 'engine not running' },
              { n: '2', label: 'TRACK', value: `${(data?.live?.open ?? 0) + (data?.live?.awaiting_score ?? 0)}`, sub: `${data?.live?.open ?? 0} open · ${data?.live?.awaiting_score ?? 0} waiting for the result` },
              { n: '3', label: 'SCORE', value: scoredN > 0 && sb ? `${((sb.hits / scoredN) * 100).toFixed(0)}%` : '—', sub: scoredN > 0 && sb ? `${sb.hits} of ${scoredN} landed inside the 95% range` : 'nothing scored yet' },
            ];
            return (
              <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-2">
                {steps.flatMap((st, i) => [
                  <div key={st.label} className="min-w-0 rounded-lg border border-white/10 bg-[#0d1420] px-3 py-3">
                    <div className="flex items-center gap-1.5 text-[10px] tracking-[.18em] text-white">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[9px]">{st.n}</span>{st.label}
                      {st.dot && <span className="ml-auto flex items-center gap-1 text-[9px] tracking-normal text-[#c3c8d2]"><span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />{st.dotLabel}</span>}
                    </div>
                    <div className="mt-2 text-[24px] leading-none tabular-nums text-white">{st.value}</div>
                    <div className="mt-1.5 text-[10px] leading-snug text-[#c3c8d2]">{st.sub}</div>
                  </div>,
                  ...(i < steps.length - 1 ? [<ChevronRight key={`a${i}`} className="self-center h-4 w-4 text-[#c3c8d2]" />] : []),
                ])}
              </div>
            );
          })()}
        </div>

        <div className="shrink-0 border-b border-white/[0.08] bg-[#080c15] px-5 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] tracking-[.16em] text-white">FORECAST DOMAIN LANES</div>
            <div className="font-mono text-[8px] text-[#aeb4c0]">EVIDENCE STATUS · NO FABRICATED SCORES</div>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {FORECAST_DOMAINS.map(domain => {
              const style = FORECAST_STATUS_STYLE[domain.status];
              return (
                <div key={domain.id} className="min-w-0 rounded-lg border border-white/10 bg-[#0d1420] px-2.5 py-2">
                  <div className="truncate font-mono text-[9px] tracking-wider text-white">{domain.label}</div>
                  <div className={`mt-1 font-mono text-[8px] font-semibold ${style.className}`}>{style.label}</div>
                  <div className="mt-1 line-clamp-2 font-mono text-[8px] leading-relaxed text-[#c3c8d2]" title={`${domain.question} · ${domain.evidence}`}>{domain.question}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── calibration line: over-coverage is a failure, and saying so here
            stops the scoreboard reading as a score to maximise ───────────── */}
        {sb && sb.coverage !== null && sb.nominal_coverage && (
          <div className="px-4 py-2 border-b border-white/[0.06] shrink-0 text-[9px] tabular-nums leading-relaxed text-[#c3c8d2]">
            {sb.coverage > sb.nominal_coverage + 0.15
              ? <span className="text-[#ffd166]">{tr('pred.overcovered')}</span>
              : sb.coverage < sb.nominal_coverage - 0.15
                ? <span className="text-[#ff6b6b]">{tr('pred.undercovered')}</span>
                : <span>{tr('pred.calibrated')}</span>}
          </div>
        )}

        {/* The audit table is deliberately above the selected forecast: this
            is a control center first, and a detail view second. */}
        {showHistory && data && (
          <div className="absolute left-3 right-3 bottom-14 z-20 max-h-[52%] overflow-hidden rounded-xl border border-white/[0.14] bg-[#080c15] shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[11px] tracking-[0.16em] text-white">TRACKED FORECASTS</div>
              <div className="text-[9px] font-mono text-[#aeb4c0]">{tracked.length} RECENT · AUTO-SCORED</div>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
                <div className="grid grid-cols-[1.45fr_1fr_.7fr_.7fr_24px] gap-3 px-2 pb-2 text-[8px] tracking-[.14em] text-[#aeb4c0]">
                  <span>TIME WINDOW (UTC)</span><span>STATUS</span><span>HIT / MISS</span><span>EVENTS</span><span />
                </div>
                {tracked.map((forecast, forecastIndex) => {
                  const state = forecast.scored ? 'SCORED' : new Date(forecast.target_window_utc[1]).getTime() > Date.now() ? 'OPEN' : 'AWAITING SCORE';
                  const result = forecast.scored ? (forecast.within_95_interval ? 'HIT' : 'MISS') : '—';
                  return (
                    <button key={`${forecast.issued_at_utc}-${forecastIndex}`} onClick={() => { setSelectedIssuedAt(forecast.issued_at_utc); setOpenChain(null); }} className={`grid w-full grid-cols-[1.45fr_1fr_.7fr_.7fr_24px] items-center gap-3 rounded-lg border-t border-white/[.06] px-2 py-2.5 text-left text-[10px] tabular-nums hover:bg-white/[.06] ${f?.issued_at_utc === forecast.issued_at_utc ? 'bg-white/[.07]' : ''}`}>
                      <span className="text-[#e2e5eb]">{forecast.target_window_utc[0].slice(0, 16).replace('T', ' ')} → {forecast.target_window_utc[1].slice(11, 16)}</span>
                      <span className={state === 'OPEN' ? 'text-[#00f5c4]' : state === 'SCORED' ? 'text-[#7fd4ff]' : 'text-[#ffd166]'}>{state}</span>
                      <span className={result === 'MISS' ? 'text-[#ff6b6b]' : result === 'HIT' ? 'text-[#00f5c4]' : 'text-[#aeb4c0]'}>{result}</span>
                      <span className="text-[#c3c8d2]">{forecast.mainshocks_considered}</span>
                      <ChevronRight className="h-3.5 w-3.5 text-[#c3c8d2]" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!data && !error ? (
            <div className="flex h-full items-center justify-center gap-2 px-6 text-[11px] text-[#c3c8d2]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {tr('pred.loading')}
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">
              {error}
            </div>
          ) : !f ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#c3c8d2]">
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
                  <span className="text-[10px] text-[#c3c8d2] tabular-nums">
                    {tr('pred.atleastone')}
                  </span>
                </div>
                <div className="mt-1.5 text-[10px] tabular-nums text-[#c3c8d2] leading-relaxed">
                  {tr('pred.expected')} {f.total_predicted_aftershocks} · 95%
                  [{f.total_interval_95[0]}, {f.total_interval_95[1]}] ·
                  {' '}{f.mainshocks_considered} {tr('pred.sequences')}
                  <br />
                  {fmtWindow(f.target_window_utc[0], f.target_window_utc[1])}
                  {' · '}
                  <span className={windowOpen ? 'text-[var(--cyan-primary)]' : 'text-[#c3c8d2]'}>
                    {forecastState === 'OPEN' ? tr('pred.open') : forecastState === 'AWAITING_SCORE' ? tr('pred.awaiting') : forecastState === 'SCORED' ? tr('pred.scored') : tr('pred.closed')}
                  </span>
                </div>
                {forecastState === 'SCORED' && (
                  <div className={`mt-2 text-[10px] font-bold tracking-widest ${f.within_95_interval ? 'text-[#00f5c4]' : 'text-[#ff6b6b]'}`}>
                    {f.within_95_interval ? 'HIT' : 'MISS'} · actual {f.actual_count ?? '—'} · scored {f.scored_at_utc?.replace('T', ' ').slice(0, 16) ?? '—'} UTC
                  </div>
                )}
                {f.falsified_if && (
                  <p className="mt-2 text-[10px] leading-relaxed text-[#ff9f43]">
                    <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5" />
                    {f.falsified_if}
                  </p>
                )}
              </div>

              <div className="px-4 pt-4 pb-2 border-b border-white/[0.06]">
                <div className="text-[10px] tracking-widest text-[var(--text-primary)]">EVENTS IN THE SELECTED WINDOW</div>
                <div className="mt-2 grid grid-cols-[minmax(0,2fr)_0.8fr_0.9fr_auto] gap-3 text-[8px] tracking-widest text-[#c3c8d2]">
                  <span>EVENT</span><span>PROBABILITY</span><span>EXPECTED</span><span>SEEN</span>
                </div>
              </div>

              {/* ── one row per sequence ───────────────────────────────── */}
              {rows.map(m => {
                const pctv = m.percent_at_least_one ?? 0;
                const chainOpen = openChain === m.mainshock_id;
                return (
                  <div key={m.mainshock_id} className="border-b border-white/[0.04]">
                    {/* TITLE -> whitebox on the mainshock node */}
                    <button
                      onClick={() => onInspect?.(`QUAKE:${m.mainshock_id}`)}
                      title={tr('pred.title.hint')}
                      className="grid w-full grid-cols-[minmax(0,2fr)_0.8fr_0.9fr_auto] items-center gap-3 text-left px-4 py-3 hover:bg-white/[0.03] transition-colors group">
                      <span className="text-[11px] tabular-nums text-[var(--text-primary)] group-hover:text-[var(--cyan-primary)] transition-colors truncate">
                        M{m.mainshock_mag} · {m.mainshock_place}
                      </span>
                      <span className="tabular-nums text-[15px]" style={{ color: probColour(pctv) }}>{pctv.toFixed(1)}%</span>
                      <span className="text-[11px] tabular-nums text-[#c3c8d2]">expect {m.predicted_count}</span>
                      <span className="text-[11px] tabular-nums text-[#c3c8d2]">seen {m.aftershocks_observed_so_far}</span>
                    </button>

                    {/* BODY -> the causality chain */}
                    <div
                      onClick={() => setOpenChain(chainOpen ? null : m.mainshock_id)}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setOpenChain(chainOpen ? null : m.mainshock_id); }}
                      role="button" tabIndex={0} title={tr('pred.body.hint')}
                      className={`block w-full text-left px-4 pb-2.5 hover:bg-white/[0.03] transition-colors ${chainOpen ? 'bg-white/[0.03]' : ''}`}>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] tabular-nums text-[#c3c8d2]">
                          {m.aftershock_zone_radius_km} km zone · {m.horizon_days} days
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
                      <div className="mt-1 text-[10px] tabular-nums text-[#c3c8d2]">
                        <button onClick={event => { event.stopPropagation(); setOpenChain(chainOpen ? null : m.mainshock_id); }} className="ml-1 rounded border border-[var(--cyan-primary)]/40 px-1.5 py-0.5 text-[var(--cyan-primary)] hover:bg-[var(--cyan-primary)]/10">
                          {chainOpen ? tr('pred.chain.hide') : tr('pred.chain.show')}
                        </button>
                      </div>
                    </div>

                  </div>
                );
              })}

              {/* ── method footer: the same for every row, so it is stated
                  once rather than nine times ─────────────────────────── */}
              <div className="px-4 py-3 text-[9px] tabular-nums text-[#c3c8d2] leading-relaxed">
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
              <div className="sticky bottom-0 flex items-center justify-between gap-3 px-4 py-3 border-t border-white/[0.10] bg-[#0c1018]/95 backdrop-blur-md text-[9px] shrink-0">
                <div className="text-[#c3c8d2]">AUTO-UPDATE <span className="text-[#00f5c4]">● Aktiv</span></div>
                <div className="flex items-center gap-4">
                  <button onClick={() => setShowHistory(v => !v)} className="flex items-center gap-1.5 text-[#c3c8d2] hover:text-[var(--cyan-primary)] transition-colors">
                    <History className="w-3 h-3" /> {showHistory ? 'HISTORIE AUSBLENDEN' : 'HISTORIE'}
                  </button>
                  <button onClick={exportHistory} className="flex items-center gap-1.5 text-[#c3c8d2] hover:text-[var(--cyan-primary)] transition-colors">
                    <Download className="w-3 h-3" /> HISTORIE EXPORTIEREN
                  </button>
                  <button onClick={() => setShowSettings(v => !v)} className="flex items-center gap-1.5 text-[#c3c8d2] hover:text-[var(--cyan-primary)] transition-colors">
                    <Settings className="w-3 h-3" /> EINSTELLUNGEN
                  </button>
                </div>
              </div>
              {showSettings && (
                <div className="sticky bottom-0 px-4 py-3 border-t border-white/[0.08] bg-[#101520] text-[9px] text-[#c3c8d2] leading-relaxed">
                  Forecast-Ausgabe: alle 6 Stunden · Score-Prüfung: alle 5 Minuten · Quelle: USGS ComCat · Historische Einträge bleiben unveränderlich.
                </div>
              )}
            </>
          )}
        </div>
      </div>

        {/* ── the causality chain, as a column beside the table. It was a modal that covered the very
            numbers it explains; now the row stays visible while its reasoning is read. ── */}
        <AnimatePresence initial={false}>
          {chain && f && (
            <motion.aside
              key="chain"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="flex shrink-0 flex-col border-l border-white/[0.12] bg-[#0a0f1a]"
              style={{ width: CHAIN_W }}
            >
              <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-white/[0.08] shrink-0">
                <div className="min-w-0">
                  <div className="hud-text text-[13px] text-[var(--text-primary)]">
                    {tr('pred.chain.title')}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--text-primary)] break-words">
                    M{chain.mainshock_mag} · {chain.mainshock_place}
                  </div>
                  <div className="mt-1 text-[11px] text-[#c3c8d2] tabular-nums">
                    <span style={{ color: probColour(chain.percent_at_least_one ?? 0) }}>
                      {(chain.percent_at_least_one ?? 0).toFixed(1)}%
                    </span>
                    {' '}{tr('pred.atleastone')} · {tr('pred.expected')} {chain.predicted_count}
                    {' '}· 95% [{chain.interval_95_poisson[0]}, {chain.interval_95_poisson[1]}]
                  </div>
                </div>
                <button onClick={() => setOpenChain(null)} title={tr('pred.chain.close')}
                  className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
                  <X className="w-4 h-4 text-[#c3c8d2]" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {f && buildChain(chain, f.method).map((s: ChainStep, i, all) => (
                  <div key={i} className="px-5 py-3.5 border-b border-white/[0.05] last:border-b-0">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: STAGE_COLOUR[s.stage] }} />
                      <span className="text-[9px] tracking-[0.2em] text-[#c3c8d2]">
                        {s.stage.toUpperCase()}
                      </span>
                      {/* Position in the chain, so a reader can see how far
                          the inference has travelled from the observation. */}
                      <span className="ml-auto text-[9px] tabular-nums text-[#c3c8d2]">
                        {i + 1}/{all.length}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[13px] text-[var(--text-primary)] leading-snug break-words">
                      {s.headline}
                    </div>
                    <p className="mt-1.5 text-[12px] text-[#c3c8d2] leading-relaxed break-words">
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
            </motion.aside>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
