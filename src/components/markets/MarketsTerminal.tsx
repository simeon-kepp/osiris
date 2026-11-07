'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Sparkline, formatPrice, type MarketQuote } from './MarketTicker';

const GREEN = 'var(--alert-green)';
const RED = 'var(--alert-red)';

export interface WatchGroup { key: string; label: string; quotes: MarketQuote[] }

const pct = (q: MarketQuote) => `${q.change_percent > 0 ? '+' : ''}${q.change_percent?.toFixed(2)}%`;

/** Short tile label: strips Yahoo suffixes (ES=F, EURUSD=X, BTC-USD, ^VIX). */
function shortLabel(q: MarketQuote): string {
  const s = (q.symbol || q.name).replace(/^\^/, '').replace(/(=F|=X|-USD|\.NYB)$/, '');
  return s.length <= 7 ? s : q.name.slice(0, 8);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[8px] font-mono tracking-[.18em] text-[var(--text-muted)]">{children}</div>;
}

/** The left-hand watchlist: every instrument, grouped, one dense row each. */
export function Watchlist({ groups, selected, onSelect }: {
  groups: WatchGroup[];
  selected?: string;
  onSelect: (q: MarketQuote) => void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col">
      {groups.map(g => {
        const isClosed = closed[g.key];
        const Chevron = isClosed ? ChevronRight : ChevronDown;
        return (
          <div key={g.key} className="mb-1">
            <button
              onClick={() => setClosed(c => ({ ...c, [g.key]: !c[g.key] }))}
              className="flex w-full items-center gap-1 px-1.5 py-1 text-[8px] font-mono tracking-[.18em] text-[var(--text-muted)] hover:text-white transition-colors"
            >
              <Chevron className="h-3 w-3" />
              {g.label}
              <span className="ml-auto tabular-nums">{g.quotes.length}</span>
            </button>
            {!isClosed && g.quotes.map(q => (
              <button
                key={q.symbol || q.name}
                onClick={() => onSelect(q)}
                title={`${q.name} — open chart`}
                className={`grid w-full grid-cols-[minmax(0,1fr)_46px_62px_56px] items-center gap-2 border-l-2 px-2 py-1.5 text-left transition-colors ${
                  selected === q.symbol
                    ? 'border-[var(--gold-primary)] bg-white/[0.06]'
                    : 'border-transparent hover:bg-white/[0.03]'
                }`}
              >
                <span className="truncate font-mono text-[10px] text-[#e4e8ef]">{q.name}</span>
                <Sparkline points={q.spark || []} up={q.up} />
                <span className="text-right font-mono text-[10px] font-bold tabular-nums text-[var(--text-primary)]">{formatPrice(q.price)}</span>
                <span className="text-right font-mono text-[10px] font-bold tabular-nums" style={{ color: q.up ? GREEN : RED }}>{pct(q)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Biggest gainers and losers across all groups. */
export function MoversList({ quotes, onSelect, count = 5 }: {
  quotes: MarketQuote[];
  onSelect: (q: MarketQuote) => void;
  count?: number;
}) {
  const { gainers, losers } = useMemo(() => {
    const sorted = [...quotes].sort((a, b) => b.change_percent - a.change_percent);
    return {
      gainers: sorted.filter(q => q.change_percent > 0).slice(0, count),
      losers: sorted.filter(q => q.change_percent < 0).slice(-count).reverse(),
    };
  }, [quotes, count]);

  const column = (title: string, list: MarketQuote[], color: string) => (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[8px] font-mono tracking-[.18em]" style={{ color }}>{title}</div>
      {list.length === 0 && <div className="text-[9px] font-mono text-[var(--text-muted)]">none</div>}
      {list.map(q => (
        <button key={q.symbol || q.name} onClick={() => onSelect(q)} className="flex w-full items-center justify-between gap-2 py-0.5 text-[10px] font-mono hover:bg-white/[0.04]">
          <span className="truncate text-[#d7dbe3]">{shortLabel(q)}</span>
          <span className="shrink-0 font-bold tabular-nums" style={{ color }}>{pct(q)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <SectionTitle>MOVERS · 1D</SectionTitle>
      <div className="flex gap-3">
        {column('GAINERS', gainers, GREEN)}
        {column('LOSERS', losers, RED)}
      </div>
    </div>
  );
}

/** One tile per instrument, colour strength = size of the daily move. */
export function Heatmap({ groups, selected, onSelect, fill = false }: {
  /** Stretch tiles to use the remaining column height. */
  fill?: boolean;
  groups: WatchGroup[];
  selected?: string;
  onSelect: (q: MarketQuote) => void;
}) {
  const tiles = groups.flatMap(g => g.quotes);
  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col' : ''}>
      <SectionTitle>HEATMAP · 1D CHANGE</SectionTitle>
      <div className={`grid grid-cols-4 gap-1 ${fill ? 'min-h-0 flex-1 auto-rows-fr' : ''}`}>
        {tiles.map(q => {
          const tone = q.change_percent >= 0 ? GREEN : RED;
          const strength = Math.min(1, Math.abs(q.change_percent) / 3);
          return (
            <button
              key={q.symbol || q.name}
              onClick={() => onSelect(q)}
              title={`${q.name} ${pct(q)}`}
              className={`flex min-h-[46px] flex-col items-center justify-center rounded border font-mono transition-colors ${
                selected === q.symbol ? 'border-[var(--gold-primary)]' : 'border-white/5 hover:border-white/20'
              }`}
              style={{ background: `color-mix(in srgb, ${tone} ${Math.round(12 + strength * 48)}%, #0b0f16)` }}
            >
              <span className="text-[9px] font-bold text-white">{shortLabel(q)}</span>
              <span className="text-[8px] tabular-nums text-white/80">{pct(q)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
