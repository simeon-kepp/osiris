'use client';

import { useMemo } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';

export interface MarketQuote {
  name: string;
  symbol: string;
  price: number;
  change_percent: number;
  up: boolean;
  spark?: number[];
  currency?: string;
  market_open?: boolean;
}

const GREEN = 'var(--alert-green)';
const RED = 'var(--alert-red)';

export function formatPrice(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000) return `${(value / 1000).toFixed(1)}K`;
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const width = 46;
    const height = 14;
    const min = Math.min(...points);
    const span = Math.max(...points) - min || 1;
    const step = width / (points.length - 1);
    return points.map((point, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - ((point - min) / span) * height).toFixed(1);
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    }).join(' ');
  }, [points]);

  if (!path) return <div className="h-[14px] w-[46px]" />;
  return (
    <svg width="46" height="14" viewBox="0 0 46 14" className="shrink-0 overflow-visible" aria-hidden="true">
      <path d={path} fill="none" stroke={up ? GREEN : RED} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function MarketTicker({ quote, active, onSelect }: {
  quote: MarketQuote;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      title={`${quote.name} — open chart`}
      className={`grid w-full grid-cols-[minmax(0,1fr)_52px_78px] items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors ${active ? 'border-[var(--border-primary)] bg-[var(--hover-accent)]' : 'border-transparent hover:bg-[var(--hover-accent)]'}`}
    >
      <div className="min-w-0">
        <div className="truncate font-mono text-[10px] tracking-wide text-[#e4e8ef]">{quote.name}</div>
        {quote.symbol && quote.symbol !== quote.name && <div className="truncate font-mono text-[8px] text-[#b7c0ce]">{quote.symbol}</div>}
      </div>
      <Sparkline points={quote.spark || []} up={quote.up} />
      <div className="flex shrink-0 flex-col items-end">
        <span className="font-mono text-[11px] font-bold tabular-nums text-[var(--text-primary)]">{formatPrice(quote.price)}</span>
        <span className="flex items-center gap-0.5 font-mono text-[9px] font-bold tabular-nums" style={{ color: quote.up ? GREEN : RED }}>
          {quote.up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {quote.change_percent > 0 ? '+' : ''}{quote.change_percent?.toFixed(2)}%
        </span>
      </div>
    </button>
  );
}
