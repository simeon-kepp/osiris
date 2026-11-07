'use client';

// Weather lane of the Prediction Engine: will a city see gale-force gusts (62 km/h) within 48 h?

export interface WeatherRow {
  id: string; city: string; lat: number; lng: number; band: string; gust_max_24h: number; p_gale: number; base_n: number;
  window_utc: string[]; result?: { gale: boolean; gust_max_window: number };
}
export interface WeatherSummary {
  issued: number; scored: number; hits: number; mean_p: number | null; brier: number | null;
  open: number; awaiting: number; next_issue_utc: string | null;
  open_forecasts: WeatherRow[]; recent_scored: WeatherRow[];
}

const fmt = (s?: string) => (s ? s.replace('T', ' ').slice(0, 16) + ' UTC' : '—');

export function weatherSteps(m: WeatherSummary | null) {
  const mins = m?.next_issue_utc ? Math.max(0, Math.round((Date.parse(m.next_issue_utc) - Date.now()) / 60000)) : null;
  return {
    next: mins === null ? '—' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
    watching: m ? m.open + m.awaiting : 0,
    record: m && m.scored > 0 ? `${Math.round((m.hits / m.scored) * 100)}%` : '—',
    recordSub: m && m.scored > 0 ? `${m.hits} of ${m.scored} windows had a gale` : 'first scores come about 2 days after the first forecast',
  };
}

function Card({ r, scored }: { r: WeatherRow; scored?: boolean }) {
  const p = Math.round(r.p_gale * 100);
  return (
    <div className="mx-3 my-2.5 rounded-lg border border-white/10 bg-[#0d1420] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-white">{r.city}</span>
        <span className="text-[11px] tabular-nums text-[#e4e8ef]">{p}% chance of gale gusts</span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
        <div className="h-1.5 rounded-full bg-[#4dd0e1]" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-2 text-[10px] leading-snug text-[#c3c8d2]">
        highest gust in the last 24 h: {r.gust_max_24h.toFixed(0)} km/h · gale starts at 62 km/h · based on {r.base_n} similar moments
      </div>
      <div className="mt-1 text-[10px] text-[#c3c8d2]">window {fmt(r.window_utc[0])} → {fmt(r.window_utc[1])}</div>
      {scored && r.result && (
        <div className={`mt-2 text-[11px] ${r.result.gale ? 'text-[#00f5c4]' : 'text-[#ffd166]'}`}>
          {r.result.gale ? 'Gale came' : 'No gale'} (highest gust {r.result.gust_max_window.toFixed(0)} km/h in the window)
        </div>
      )}
    </div>
  );
}

export default function WeatherView({ m, err }: { m: WeatherSummary | null; err: string | null }) {
  if (err) return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">{err}</div>;
  if (!m) return <div className="flex h-full items-center justify-center text-[11px] text-[#c3c8d2]">loading…</div>;
  return (
    <div className="pb-4">
      {m.open_forecasts.length === 0 && m.recent_scored.length === 0 && (
        <div className="px-6 py-8 text-center text-[11px] text-[#c3c8d2]">
          A forecast is issued only for cities with gusts of 40 km/h or more in the last 24 h. None qualifies at the moment.
        </div>
      )}
      {m.open_forecasts.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">RUNNING NOW · {m.open_forecasts.length} WINDIEST</div>}
      {m.open_forecasts.map(r => <Card key={r.id} r={r} />)}
      {m.recent_scored.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">SCORED</div>}
      {m.recent_scored.map(r => <Card key={r.id} r={r} scored />)}
      <p className="mx-5 mt-3 text-[10px] leading-relaxed text-[#c3c8d2]">
        Method: over two years and 16 cities, how often gusts reached 62 km/h within 48 h from a similar last 24 h. It does not read weather maps and is not a weather model.
        Values are Open-Meteo model data, not station readings. Cities on the same day share one storm front. {m.brier !== null ? `Brier score ${m.brier.toFixed(3)}.` : ''}
      </p>
    </div>
  );
}
