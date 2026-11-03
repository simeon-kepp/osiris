'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart3, X,
  Shield, Droplets, Gem, Bitcoin, LineChart, Maximize2, Minimize2,
  DollarSign, ArrowUpDown, AlertTriangle,
} from 'lucide-react';
import AiOverview from './AiOverview';
import MarketTicker, { formatPrice, type MarketQuote } from './markets/MarketTicker';
import SpaceWeatherCard from './markets/SpaceWeatherCard';

// Canvas charting has no business in the server bundle, and it only mounts
// once a ticker is actually opened.
const MarketChart = dynamic(() => import('./MarketChart'), { ssr: false });

interface MarketsPanelProps { data: any; spaceWeather?: any; onClose?: () => void; }

const SECTIONS = [
  { key: 'indices', label: 'INDICES', icon: LineChart },
  { key: 'stocks', label: 'DEFENSE', icon: Shield },
  { key: 'oil', label: 'ENERGY', icon: Droplets },
  { key: 'commodities', label: 'COMMODITIES', icon: Gem },
  { key: 'crypto', label: 'CRYPTO', icon: Bitcoin },
  { key: 'fx', label: 'FX', icon: DollarSign },
];

const GREEN = 'var(--alert-green)';
const RED = 'var(--alert-red)';

/** How long ago the feed was built, so a frozen panel is visibly frozen. */
function useFeedAge(timestamp?: string): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!timestamp) return null;
  const ms = now - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function MarketsPanel({ data, spaceWeather, onClose }: MarketsPanelProps) {
  const [expanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [activeSection, setActiveSection] = useState('stocks');
  const [sortByMove, setSortByMove] = useState(false);
  /** The instrument whose chart is open, if any. */
  const [selected, setSelected] = useState<{ symbol: string; name: string } | null>(null);
  const autoOpenedRef = useRef(false);
  // Memoised so the derived lists below don't recompute on every render.
  const markets = useMemo(() => data.markets || {}, [data.markets]);
  const age = useFeedAge(markets.timestamp);

  // Ensure portal only renders on client
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Fullscreen covers the map, so Escape has to get you out of it — closing
  // the chart first, since that is the nearer thing to dismiss.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(null);
      else setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized, selected]);

  /** Every instrument across every section — the basis for the breadth line. */
  const allQuotes = useMemo<MarketQuote[]>(
    () => SECTIONS.flatMap(s => Object.values<MarketQuote>(markets[s.key] || {})).filter(q => Number.isFinite(q?.change_percent)),
    [markets],
  );

  const breadth = useMemo(() => {
    if (!allQuotes.length) return null;
    const up = allQuotes.filter(q => q.change_percent > 0).length;
    const sorted = [...allQuotes].sort((a, b) => b.change_percent - a.change_percent);
    return { up, down: allQuotes.length - up, total: allQuotes.length, top: sorted[0], worst: sorted[sorted.length - 1] };
  }, [allQuotes]);

  /** Top 3 movers per section, for the fullscreen overview grid -- the same
   *  data every tab already has, just previewed before it's clicked into. */
  const sectionOverviews = useMemo(
    () => SECTIONS.map(s => ({
      section: s,
      top: Object.values<MarketQuote>(markets[s.key] || {})
        .filter(q => Number.isFinite(q?.change_percent))
        .sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent))
        .slice(0, 3),
    })),
    [markets],
  );

  const rows = useMemo<MarketQuote[]>(() => {
    const list = Object.values<MarketQuote>(markets[activeSection] || {});
    return sortByMove ? [...list].sort((a, b) => b.change_percent - a.change_percent) : list;
  }, [markets, activeSection, sortByMove]);

  // Give the operator a useful first view immediately, and make section tabs
  // deterministic: changing INDICES/DEFENSE/ENERGY always opens that section's
  // first instrument instead of leaving the previous section's chart behind.
  useEffect(() => {
    if (!autoOpenedRef.current && rows[0]?.symbol) {
      autoOpenedRef.current = true;
      setSelected({ symbol: rows[0].symbol, name: rows[0].name });
    }
  }, [rows]);

  // A section with no rows means the upstream refresh failed — say so, rather
  // than showing a "Loading…" that never resolves until the next 15m poll.
  const feedLoaded = Boolean(markets.timestamp || markets.error);
  const sessionOpen = rows.some(q => q.market_open);

  /* The blocks below are shared by both layouts. Docked stacks them in one
     column; fullscreen splits them across two, so they carry no margins of
     their own — the container that places them owns the spacing. */

  const breadthBlock = breadth && (
    <div className="px-2 py-1.5 rounded-lg border border-[var(--border-primary)] bg-white/[0.02]">
      <div className="flex items-center justify-between">
        <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">BREADTH</span>
        <span className="text-[9px] font-mono tabular-nums">
          <span style={{ color: GREEN }}>{breadth.up}▲</span>
          <span className="text-[var(--text-muted)]"> / </span>
          <span style={{ color: RED }}>{breadth.down}▼</span>
          <span className="text-[var(--text-muted)]"> of {breadth.total}</span>
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full overflow-hidden bg-[var(--alert-red)]/30">
        <div className="h-full rounded-full" style={{ width: `${(breadth.up / breadth.total) * 100}%`, background: GREEN }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[8px] font-mono">
        <span style={{ color: GREEN }}>▲ {breadth.top.name} +{breadth.top.change_percent.toFixed(2)}%</span>
        <span style={{ color: RED }}>▼ {breadth.worst.name} {breadth.worst.change_percent.toFixed(2)}%</span>
      </div>
    </div>
  );

  const spaceBlock = <SpaceWeatherCard weather={spaceWeather} />;

  const aiBlock = <AiOverview mode="markets" payload={{ markets, spaceWeather }} accent="#D4AF37" />;

  /** Every instrument, one continuous strip -- the Aladdin/terminal-style
   *  "everything moving right now" bar across the top of the fullscreen
   *  view. Same data as the tabbed list below, just all of it at once and
   *  without a click required to see it. */
  const tickerStripBlock = allQuotes.length > 0 && (
    <div className="flex items-center gap-4 overflow-x-auto styled-scrollbar shrink-0 py-1 border-b border-[var(--border-primary)]">
      {allQuotes.map(q => (
        <div key={q.symbol || q.name} className="flex items-center gap-1.5 shrink-0 whitespace-nowrap text-[10px] font-mono">
          <span className="text-[var(--text-secondary)]">{q.symbol || q.name}</span>
          <span className="text-[var(--text-primary)] font-bold tabular-nums">{formatPrice(q.price)}</span>
          <span className="font-bold tabular-nums" style={{ color: q.up ? GREEN : RED }}>
            {q.change_percent > 0 ? '+' : ''}{q.change_percent?.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );

  /** Fills the fullscreen left column when no chart is open -- a preview
   *  grid, one card per section, so the space isn't empty until a ticker is
   *  clicked. Clicking a card's mover opens straight to its chart, same as
   *  clicking it in the full list would. */
  const sectionOverviewGrid = (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 auto-rows-fr gap-2 min-h-[390px]">
      {sectionOverviews.map(({ section, top }) => {
        const Icon = section.icon;
        return (
          <div key={section.key} className="min-h-[112px] p-3 rounded-lg border border-[var(--border-primary)] bg-gradient-to-br from-white/[0.045] to-transparent">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Icon className="w-3 h-3 text-[var(--gold-primary)]" />
              <span className="text-[9px] font-mono tracking-widest text-[var(--text-muted)]">{section.label}</span>
            </div>
            {top.length > 0 ? (
              <div className="space-y-1">
                {top.map(q => (
                  <button key={q.symbol || q.name} onClick={() => { setActiveSection(section.key); setSelected({ symbol: q.symbol, name: q.name }); }}
                    className="w-full flex items-center justify-between text-[10px] font-mono hover:bg-[var(--hover-accent)] rounded px-1 -mx-1 py-1 transition-colors">
                    <span className="text-[#d7dbe3] truncate">{q.name}</span>
                    <span className="font-bold tabular-nums shrink-0 ml-2" style={{ color: q.up ? GREEN : RED }}>
                      {q.change_percent > 0 ? '+' : ''}{q.change_percent?.toFixed(2)}%
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-[8px] font-mono text-[var(--text-muted)] py-1">no data</div>
            )}
          </div>
        );
      })}
    </div>
  );

  const marketPulseBlock = breadth && (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 rounded-lg border border-[var(--border-primary)] bg-gradient-to-r from-[#101927] via-[#0b111c] to-[#11151d] p-3 min-h-[142px]">
      <div className="md:border-r md:border-white/[.08] pr-3">
        <div className="text-[8px] font-mono tracking-[.18em] text-[#aeb4c0]">MARKET PULSE</div>
        <div className="mt-2 flex items-end gap-2">
          <span className="text-2xl font-mono font-bold text-white">{breadth.up}<span className="text-[#8b96a6] text-sm"> / {breadth.total}</span></span>
          <span className="mb-1 text-[10px] font-mono text-[#00f5c4]">ADVANCING</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full overflow-hidden bg-[#ff6b6b]/30"><div className="h-full rounded-full bg-[#00f5c4]" style={{ width: `${(breadth.up / breadth.total) * 100}%` }} /></div>
      </div>
      <div className="md:border-r md:border-white/[.08] px-1 md:px-3">
        <div className="text-[8px] font-mono tracking-[.18em] text-[#aeb4c0]">LEADER</div>
        <div className="mt-3 text-[13px] font-mono text-white truncate">{breadth.top.name}</div>
        <div className="mt-1 text-[18px] font-mono font-bold text-[#00f5c4]">+{breadth.top.change_percent.toFixed(2)}%</div>
      </div>
      <div className="px-1 md:px-3">
        <div className="text-[8px] font-mono tracking-[.18em] text-[#aeb4c0]">LAGGARD</div>
        <div className="mt-3 text-[13px] font-mono text-white truncate">{breadth.worst.name}</div>
        <div className="mt-1 text-[18px] font-mono font-bold text-[#ff6b6b]">{breadth.worst.change_percent.toFixed(2)}%</div>
      </div>
    </div>
  );

  const scmBlock = markets.scm_alerts && markets.scm_alerts.length > 0 && (
    <div className="space-y-1">
      {markets.scm_alerts.map((alert: string, i: number) => (
        <div key={i} className="px-2 py-1.5 rounded border border-[#FF9500] bg-[#FF9500]/10 text-[#FF9500] text-[9px] font-mono leading-tight shadow-[0_0_8px_rgba(255,149,0,0.15)]">
          {alert}
        </div>
      ))}
    </div>
  );

  const chartBlock = selected && (
    <MarketChart
      symbol={selected.symbol}
      name={selected.name}
      large={maximized}
      onClose={() => setSelected(null)}
    />
  );

  const tabsBar = (
    <div className="flex gap-0.5 overflow-x-auto styled-scrollbar">
      {SECTIONS.map(s => {
        const Icon = s.icon;
        const count = Object.keys(markets[s.key] || {}).length;
        return (
          <button key={s.key} onClick={() => { setActiveSection(s.key); const first = Object.values<MarketQuote>(markets[s.key] || {})[0]; if (first?.symbol) setSelected({ symbol: first.symbol, name: first.name }); }}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded text-[9px] font-mono tracking-wider whitespace-nowrap transition-all ${activeSection === s.key ? 'bg-[var(--hover-accent)] text-[var(--gold-primary)] border border-[var(--border-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent'}`}>
            <Icon className="w-3 h-3" />
            {s.label}
            {count > 0 && <span className="text-[var(--text-muted)]">{count}</span>}
          </button>
        );
      })}
    </div>
  );

  const listHeader = rows.length > 0 && (
    <div className="flex items-center justify-between px-2 py-1 shrink-0">
      <span className="flex items-center gap-1 text-[8px] font-mono tracking-widest text-[var(--text-muted)]">
        <span className="w-1 h-1 rounded-full" style={{ background: sessionOpen ? GREEN : 'var(--text-muted)' }} />
        {sessionOpen ? 'SESSION OPEN' : 'SESSION CLOSED'}
      </span>
      <button
        onClick={() => setSortByMove(v => !v)}
        className={`flex items-center gap-1 text-[8px] font-mono tracking-widest transition-colors ${sortByMove ? 'text-[var(--gold-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
        title={sortByMove ? 'Listed by biggest move' : 'Listed in feed order'}
      >
        <ArrowUpDown className="w-2.5 h-2.5" />
        {sortByMove ? 'BY MOVE' : 'DEFAULT'}
      </button>
    </div>
  );

  const listRows = (
    <>
      {rows.map(q => (
        <MarketTicker
          key={q.symbol || q.name}
          quote={q}
          active={selected?.symbol === q.symbol}
          onSelect={() => setSelected(
            selected?.symbol === q.symbol ? null : { symbol: q.symbol, name: q.name },
          )}
        />
      ))}

      {rows.length === 0 && (
        feedLoaded ? (
          <div className="flex items-center justify-center gap-1.5 py-3 text-[9px] font-mono text-[var(--text-muted)]">
            <AlertTriangle className="w-3 h-3" />
            {activeSection.toUpperCase()} FEED UNAVAILABLE — RETRYING
          </div>
        ) : (
          <div className="text-center py-3 text-[10px] font-mono text-[var(--text-muted)]">Loading {activeSection}...</div>
        )
      )}
    </>
  );

  const content = (
    <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.6, duration: 0.6 }} className={`glass-panel p-3 pointer-events-auto transition-all duration-300 flex flex-col h-full min-h-0 bg-[#090d16]/95 border border-white/10 shadow-2xl ${maximized ? 'fixed inset-3 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl' : ''}`}>
      {/* Header controls sit side by side, not nested — a button inside a
          button is invalid HTML and React fails hydration on it. */}
      <div className="flex items-center justify-between w-full mb-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[12px] text-[var(--text-primary)]">MARKETS & INTEL</span>
          <span className="gotham-tag gotham-tag--low" style={{ fontSize: '7px', padding: '1px 4px' }}>LIVE</span>
        </div>
        <div className="flex items-center gap-2">
          {age && <span className="text-[8px] font-mono text-[var(--text-muted)]">{age}</span>}
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          <button onClick={() => setMaximized(!maximized)} className="hover:text-white transition-colors" title={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Minimize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
          </button>
          {onClose && <button onClick={onClose} className="rounded p-1 hover:bg-white/10 hover:text-white" title="Close"><X className="h-3.5 w-3.5 text-[#c3c8d2]" /></button>}
        </div>
      </div>

      {/* Fades rather than animating height. Fullscreen makes this a flex child
          and docked lets it size to content; animating height across that
          switch stranded it at 0 with the content spilling out of the panel.
          The key remounts it per mode so the chart re-measures at the new size. */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key={maximized ? 'fullscreen' : 'docked'}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={maximized ? 'flex-1 min-h-0 flex flex-col' : ''}
          >
            {maximized ? (
              /* Fullscreen: a ticker strip across the top (every instrument,
                 Aladdin/terminal-style), then context on the left and the
                 full list beside it. Each column scrolls on its own, so a
                 long list never pushes the chart off-screen and the panel
                 itself never overflows. Below lg the columns stack and the
                 whole body scrolls instead. Left column shows the section
                 overview grid until a ticker is opened, so the space is
                 never just empty -- a chart replaces it, not adds to it. */
              <div className="flex-1 min-h-0 flex flex-col gap-2">
                {tickerStripBlock}
                <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-3 overflow-y-auto lg:overflow-hidden styled-scrollbar">
                  <div className="min-h-0 lg:overflow-y-auto styled-scrollbar space-y-3 lg:pr-1">
                    {chartBlock}
                    {!selected && sectionOverviewGrid}
                    {!selected && marketPulseBlock}
                    {breadthBlock}
                    {scmBlock}
                    {spaceBlock}
                    {aiBlock}
                  </div>

                  <div className="min-h-0 flex flex-col lg:border-l lg:border-[var(--border-primary)] lg:pl-3">
                    <div className="shrink-0 space-y-2">
                      {tabsBar}
                      {listHeader}
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto styled-scrollbar space-y-0.5">
                      {listRows}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Docked: one scroll region for the whole body, capped to the
                 viewport. With a chart open the content is taller than the
                 screen, and nested scrollers here would mean choosing which
                 one you meant to scroll. */
              <div className="space-y-2 overflow-y-auto styled-scrollbar max-h-[calc(100vh-9rem)] pr-0.5">
                {breadthBlock}
                {spaceBlock}
                {aiBlock}
                {tabsBar}
                {scmBlock}
                {chartBlock}
                <div>
                  {listHeader}
                  <div className="space-y-0.5">
                    {listRows}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );

  if (maximized && mounted && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
