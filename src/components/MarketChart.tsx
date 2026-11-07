'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { X, Loader2, AlertTriangle } from 'lucide-react';

interface Candle {
  time: number;
  open: number; high: number; low: number; close: number; volume: number;
}

/** Wilder's RSI. Needs period+1 closes before the first value exists. */
function computeRsi(candles: { time: number; close: number }[], period = 14): { time: number; value: number }[] {
  if (candles.length <= period) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const out: { time: number; value: number }[] = [];
  const toRsi = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  out.push({ time: candles[period].time, value: toRsi() });
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push({ time: candles[i].time, value: toRsi() });
  }
  return out;
}

interface MarketChartProps {
  symbol: string;
  name: string;
  onClose: () => void;
  /** Taller layout for the maximized panel, where there is room for it. */
  large?: boolean;
  /** Explicit canvas height in px; overrides the large/small presets. */
  chartHeight?: number;
}

/* Lowercase m is minutes, uppercase M is months — the convention every
   trading tool uses, and what the API's range keys mean. */
const RANGES = ['1m', '15m', '24H', '1W', '1M', '6M', '1Y'] as const;
type Range = typeof RANGES[number];

/** Bars finer than a day need the clock on the axis, not just the date. */
const INTRADAY: Record<Range, boolean> = {
  '1m': true, '15m': true, '24H': true, '1W': true,
  '1M': false, '6M': false, '1Y': false,
};

const UP = '#26A69A';
const DOWN = '#D32F2F';
const GRID = 'rgba(255,255,255,0.04)';
const AXIS = 'rgba(255,255,255,0.12)';

/** Prices here span FX pairs to Bitcoin — pick the precision from the value. */
function priceFormat(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export default function MarketChart({ symbol, name, onClose, large = false, chartHeight }: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);

  const [range, setRange] = useState<Range>('1M');
  /* Keyed by the request it answers, so status is derived rather than set on
     the way in — a synchronous setState in the effect body would cascade. */
  const [result, setResult] = useState<{ key: string; rows: Candle[] | null }>({ key: '', rows: null });
  /** Whatever the crosshair is currently over — falls back to the last bar. */
  const [hover, setHover] = useState<Candle | null>(null);

  const height = chartHeight ?? (large ? 420 : 200);

  // ── Chart instance. Built once; data and axis formatting are applied later
  //    so that changing range never tears down the canvas.
  useEffect(() => {
    if (!containerRef.current) return;

    // lightweight-charts draws its own text onto a <canvas>, so it never
    // sees the page's CSS cascade -- a literal "'JetBrains Mono'" string
    // here only works if that font happens to be installed on the visitor's
    // OS, and silently falls through to Courier New/monospace on every
    // machine where it isn't. The self-hosted webfont next/font already
    // loaded for the rest of the page is sitting in --font-hud on <html>;
    // reading it at runtime and handing the resolved stack to the chart is
    // what actually makes this text match everything else on screen.
    const hudFont = getComputedStyle(document.documentElement).getPropertyValue('--font-hud').trim()
      || "'Inter', sans-serif";

    const chart = createChart(containerRef.current, {
      // The library measures the container itself. Sizing the canvases by
      // hand left their bitmaps at the 300x150 default — laid out, but never
      // painted.
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#78909C',
        fontFamily: hudFont,
        fontSize: 9,
        // Keep the required TradingView attribution as a compact text link in
        // our chart footer instead of the large canvas logo overlay.
        attributionLogo: false,
        // Price, volume and RSI are three panes, divided by a visible line the
        // operator can drag to resize.
        panes: { separatorColor: 'rgba(212,175,55,0.35)', separatorHoverColor: 'rgba(212,175,55,0.7)', enableResize: true },
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: { borderColor: AXIS, scaleMargins: large ? { top: 0.08, bottom: 0.06 } : { top: 0.1, bottom: 0.26 } },
      timeScale: { borderColor: AXIS, secondsVisible: false },
      crosshair: {
        vertLine: { color: 'rgba(212,175,55,0.4)', labelBackgroundColor: '#D4AF37' },
        horzLine: { color: 'rgba(212,175,55,0.4)', labelBackgroundColor: '#D4AF37' },
      },
      handleScale: { axisPressedMouseMove: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      borderVisible: false,
    });

    let volumeSeries: ISeriesApi<'Histogram'>;
    if (large) {
      // Fullscreen: one pane each for price, volume and RSI. Panes share one time
      // scale, so panning and zooming stay in step across all three.
      volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' }, title: 'VOL', priceLineVisible: false,
      }, 1);
      volumeSeries.priceScale().applyOptions({ borderColor: AXIS, scaleMargins: { top: 0.15, bottom: 0.05 } });
      const rsi = chart.addSeries(LineSeries, {
        color: '#B388FF', lineWidth: 2, priceLineVisible: false, title: 'RSI 14',
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, 2);
      rsi.priceScale().applyOptions({ borderColor: AXIS, scaleMargins: { top: 0.1, bottom: 0.1 } });
      rsi.createPriceLine({ price: 70, color: 'rgba(211,47,47,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' });
      rsi.createPriceLine({ price: 30, color: 'rgba(38,166,154,0.6)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' });
      const panes = chart.panes();
      panes[0].setStretchFactor(5);
      panes[1].setStretchFactor(1.4);
      panes[2].setStretchFactor(1.8);
      rsiRef.current = rsi;
    } else {
      // Docked: too small for panes, so volume sits in the bottom quarter on its own
      // invisible scale and never distorts the price axis.
      volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }

    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(candleSeries) as Candle | undefined;
      setHover(d && param.time ? { ...d, time: param.time as number, volume: d.volume ?? 0 } : null);
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    return () => { chart.remove(); chartRef.current = null; rsiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built once; large is fixed per mount
  }, []);

  // Only intraday bars need the clock on the axis. Applied separately so
  // switching range never tears down the canvas.
  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ timeVisible: INTRADAY[range] });
  }, [range]);

  const requestKey = `${symbol}|${range}`;
  const status: 'loading' | 'ready' | 'error' =
    result.key !== requestKey ? 'loading' : result.rows === null ? 'error' : 'ready';
  const candles = useMemo(
    () => (result.key === requestKey && result.rows ? result.rows : []),
    [result, requestKey],
  );

  // ── Data ──
  useEffect(() => {
    let cancelled = false;

    fetch(`/api/markets/history?symbol=${encodeURIComponent(symbol)}&range=${range}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        const rows: Candle[] = d.candles || [];
        setResult({ key: `${symbol}|${range}`, rows: rows.length ? rows : null });
      })
      .catch(() => { if (!cancelled) setResult({ key: `${symbol}|${range}`, rows: null }); });

    return () => { cancelled = true; };
  }, [symbol, range]);

  const rsiPoints = useMemo(() => computeRsi(candles), [candles]);
  const rsiByTime = useMemo(() => new Map(rsiPoints.map(r => [r.time, r.value])), [rsiPoints]);

  // Push data once both the series and the rows exist.
  useEffect(() => {
    if (status !== 'ready' || !candleRef.current || !volumeRef.current) return;

    candleRef.current.setData(candles.map(c => ({
      time: c.time as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    volumeRef.current.setData(candles.map(c => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(38,166,154,0.28)' : 'rgba(211,47,47,0.28)',
    })));

    rsiRef.current?.setData(rsiPoints.map(r => ({ time: r.time as UTCTimestamp, value: r.value })));

    chartRef.current?.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rsiPoints derives from candles
  }, [candles, status]);

  // ── Range summary: first open to last close across the window shown ──
  const last = candles[candles.length - 1];
  const first = candles[0];
  const rangeChange = first && last ? ((last.close - first.open) / first.open) * 100 : null;
  const shown = hover || last;
  const high = candles.length ? Math.max(...candles.map(c => c.high)) : null;
  const low = candles.length ? Math.min(...candles.map(c => c.low)) : null;

  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-black/30 p-2">
      {/* Identity + range performance */}
      <div className="flex items-start justify-between mb-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono font-bold text-[var(--text-primary)] truncate">{name}</span>
            <span className="text-[8px] font-mono text-[var(--text-muted)]">{symbol}</span>
          </div>
          {rangeChange !== null && (
            <div className="text-[9px] font-mono tabular-nums" style={{ color: rangeChange >= 0 ? UP : DOWN }}>
              {rangeChange >= 0 ? '+' : ''}{rangeChange.toFixed(2)}% over {range}
            </div>
          )}
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-white transition-colors shrink-0" title="Close chart">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* OHLC readout — tracks the crosshair, resting on the latest bar */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1 text-[8px] font-mono tabular-nums">
        {shown ? (
          <>
            <span className="text-[var(--text-muted)]">O <span className="text-[var(--text-secondary)]">{priceFormat(shown.open)}</span></span>
            <span className="text-[var(--text-muted)]">H <span style={{ color: UP }}>{priceFormat(shown.high)}</span></span>
            <span className="text-[var(--text-muted)]">L <span style={{ color: DOWN }}>{priceFormat(shown.low)}</span></span>
            <span className="text-[var(--text-muted)]">C <span className="text-[var(--text-primary)] font-bold">{priceFormat(shown.close)}</span></span>
            {shown.volume > 0 && <span className="text-[var(--text-muted)]">V <span className="text-[var(--text-secondary)]">{formatVolume(shown.volume)}</span></span>}
          </>
        ) : <span className="text-[var(--text-muted)]">—</span>}
      </div>

      {/* Canvas, with loading and failure drawn over the same box so the
          panel never changes height while a range is fetching. */}
      <div className="relative" style={{ height }}>
        <div ref={containerRef} className="w-full" style={{ height }} />

        {status !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/40 text-[9px] font-mono text-[var(--text-muted)]">
            {status === 'loading'
              ? <><Loader2 className="w-3 h-3 animate-spin" /> LOADING {range}</>
              : <><AlertTriangle className="w-3 h-3" /> NO {range} DATA FOR {symbol}</>}
          </div>
        )}
      </div>

      {/* Window extremes + range selector */}
      <div className="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
        <div className="text-[8px] font-mono text-[var(--text-muted)] tabular-nums">
          {high !== null && low !== null && <>H {priceFormat(high)} · L {priceFormat(low)}</>}
        </div>
        {/* Seven ranges will not fit one line in the docked panel — let them wrap. */}
        <div className="flex gap-0.5 flex-wrap justify-end">
          {RANGES.map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-1.5 py-0.5 rounded text-[8px] font-mono tracking-wider transition-all ${
                range === r
                  ? 'bg-[var(--hover-accent)] text-[var(--gold-primary)] border border-[var(--border-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="mt-1 block text-right text-[7px] font-mono text-[#7d8796] hover:text-[#c3c8d2]">Charting by TradingView</a>
    </div>
  );
}
