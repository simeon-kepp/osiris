'use client';

// Markets lane of the Prediction Engine: will a currently wild instrument stay wild for 5 more daily bars?

export interface MarketRow {
  id: string; symbol: string; name: string; as_of_day: string; rv5: number; threshold: number;
  p_stays_high: number; base_n: number; result?: { stayed_high: boolean; rv5_next: number };
}
export interface MarketSummary {
  issued: number; scored: number; hits: number; mean_p: number | null; brier: number | null;
  open: number; awaiting: number; next_issue_utc: string | null;
  open_forecasts: MarketRow[]; recent_scored: MarketRow[];
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function marketSteps(m: MarketSummary | null) {
  const mins = m?.next_issue_utc ? Math.max(0, Math.round((Date.parse(m.next_issue_utc) - Date.now()) / 60000)) : null;
  return {
    next: mins === null ? '—' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
    watching: m ? m.open + m.awaiting : 0,
    record: m && m.scored > 0 ? `${Math.round((m.hits / m.scored) * 100)}%` : '—',
    recordSub: m && m.scored > 0 ? `${m.hits} of ${m.scored} stayed wild` : 'first scores come after 5 more trading days',
  };
}

function Card({ r, scored }: { r: MarketRow; scored?: boolean }) {
  const p = Math.round(r.p_stays_high * 100);
  return (
    <div className="mx-3 my-2.5 rounded-lg border border-white/10 bg-[#0d1420] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-white">{r.name} <span className="text-[#c3c8d2]">{r.symbol}</span></span>
        <span className="text-[11px] tabular-nums text-[#e4e8ef]">{p}% chance the swings stay high</span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
        <div className="h-1.5 rounded-full bg-[#5ea8ff]" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-2 text-[10px] leading-snug text-[#c3c8d2]">
        daily swing {pct(r.rv5)} over the last 5 days · its own “high” line is {pct(r.threshold)} · as of {r.as_of_day}
      </div>
      {scored && r.result && (
        <div className={`mt-2 text-[11px] ${r.result.stayed_high ? 'text-[#00f5c4]' : 'text-[#ffd166]'}`}>
          {r.result.stayed_high ? 'Held: swings stayed high' : 'Missed: it calmed down'} ({pct(r.result.rv5_next)} over the next 5 days)
        </div>
      )}
    </div>
  );
}

export default function MarketView({ m, err }: { m: MarketSummary | null; err: string | null }) {
  if (err) return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">{err}</div>;
  if (!m) return <div className="flex h-full items-center justify-center text-[11px] text-[#c3c8d2]">loading…</div>;
  return (
    <div className="pb-4">
      {m.open_forecasts.length === 0 && m.recent_scored.length === 0 && (
        <div className="px-6 py-8 text-center text-[11px] text-[#c3c8d2]">
          A forecast is issued only for instruments that swing harder than usual right now. None qualifies at the moment.
        </div>
      )}
      {m.open_forecasts.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">RUNNING NOW · {m.open_forecasts.length} WILDEST</div>}
      {m.open_forecasts.map(r => <Card key={r.id} r={r} />)}
      {m.recent_scored.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">SCORED</div>}
      {m.recent_scored.map(r => <Card key={r.id} r={r} scored />)}
      <p className="mx-5 mt-3 text-[10px] leading-relaxed text-[#c3c8d2]">
        Method: across 24 instruments and the past year, the share of “wild” days that were followed by another wild week. It says nothing about direction.
        It is a base rate, not a trained model. {m.brier !== null ? `Brier score ${m.brier.toFixed(3)}.` : ''}
      </p>
    </div>
  );
}
