'use client';

// Space weather lane of the Prediction Engine: will Kp reach 5+ (a G1 geomagnetic storm) within 72 h?

export interface SpaceRow {
  id: string; issued_utc: string; band: string; kp_now: number; kp_max_24h: number; p_storm: number; base_n: number;
  window_utc: string[]; result?: { storm: boolean; kp_max_window: number };
}
export interface SpaceSummary {
  issued: number; scored: number; hits: number; mean_p: number | null; brier: number | null;
  open: number; awaiting: number; next_issue_utc: string | null;
  open_forecasts: SpaceRow[]; recent_scored: SpaceRow[];
}

const fmt = (s?: string) => (s ? s.replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const BAND: Record<string, string> = { quiet: 'quiet last 24 h', active: 'active last 24 h', storm: 'storm in the last 24 h' };

export function spaceSteps(m: SpaceSummary | null) {
  const mins = m?.next_issue_utc ? Math.max(0, Math.round((Date.parse(m.next_issue_utc) - Date.now()) / 60000)) : null;
  return {
    next: mins === null ? '—' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
    watching: m ? m.open + m.awaiting : 0,
    record: m && m.scored > 0 ? `${Math.round((m.hits / m.scored) * 100)}%` : '—',
    recordSub: m && m.scored > 0 ? `${m.hits} of ${m.scored} windows had a storm` : 'first scores come about 3 days after the first forecast',
  };
}

function Card({ r, scored }: { r: SpaceRow; scored?: boolean }) {
  const p = Math.round(r.p_storm * 100);
  return (
    <div className="mx-3 my-2.5 rounded-lg border border-white/10 bg-[#0d1420] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-white">Issued {fmt(r.issued_utc)}</span>
        <span className="text-[11px] tabular-nums text-[#e4e8ef]">{p}% chance of a storm</span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
        <div className="h-1.5 rounded-full bg-[#b388ff]" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-2 text-[10px] leading-snug text-[#c3c8d2]">
        {BAND[r.band] ?? r.band} · Kp now {r.kp_now.toFixed(1)}, highest in 24 h {r.kp_max_24h.toFixed(1)} · based on {r.base_n} similar moments
      </div>
      <div className="mt-1 text-[10px] text-[#c3c8d2]">window {fmt(r.window_utc[0])} → {fmt(r.window_utc[1])}</div>
      {scored && r.result && (
        <div className={`mt-2 text-[11px] ${r.result.storm ? 'text-[#00f5c4]' : 'text-[#ffd166]'}`}>
          {r.result.storm ? 'Storm came' : 'No storm'} (highest Kp {r.result.kp_max_window.toFixed(1)} in the window)
        </div>
      )}
    </div>
  );
}

export default function SpaceView({ m, err }: { m: SpaceSummary | null; err: string | null }) {
  if (err) return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">{err}</div>;
  if (!m) return <div className="flex h-full items-center justify-center text-[11px] text-[#c3c8d2]">loading…</div>;
  return (
    <div className="pb-4">
      {m.open_forecasts.length === 0 && m.recent_scored.length === 0 && (
        <div className="px-6 py-8 text-center text-[11px] text-[#c3c8d2]">The first forecast is issued a few minutes after the server starts.</div>
      )}
      {m.open_forecasts.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">RUNNING NOW</div>}
      {m.open_forecasts.map(r => <Card key={r.id} r={r} />)}
      {m.recent_scored.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">SCORED</div>}
      {m.recent_scored.map(r => <Card key={r.id} r={r} scored />)}
      <p className="mx-5 mt-3 text-[10px] leading-relaxed text-[#c3c8d2]">
        Method: how often, over the past 3 years, a Kp of 5 or more followed within 72 h from a similar last 24 h. Forecasts come every 6 h and their windows overlap, so neighbours are not independent.
        It is a base rate, not a trained model. {m.brier !== null ? `Brier score ${m.brier.toFixed(3)}.` : ''}
      </p>
    </div>
  );
}
