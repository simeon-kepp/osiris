'use client';

// Wildfire lane of the Prediction Engine. Same loop as the seismic lane
// (issue, watch, score), shown in plain language and as separate cards.

export interface WildfireRow {
  id: string; lat: number; lng: number; detections_24h: number; frp_sum: number;
  p_keeps_burning: number; band?: string; base_n?: number; issued_utc?: string;
  window_utc?: [string, string] | { from: string; to: string } | string[];
  result?: { kept_burning: boolean; detections_in_window: number };
}
export interface WildfireSummary {
  issued: number; scored: number; hits: number; mean_p: number | null; brier: number | null;
  open: number; awaiting: number; next_issue_utc: string | null;
  open_forecasts: WildfireRow[]; recent_scored: WildfireRow[];
}

const fmt = (s?: string) => (s ? s.replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const winText = (w: WildfireRow['window_utc']) => {
  if (!w) return '';
  const a = Array.isArray(w) ? w : [(w as { from: string }).from, (w as { to: string }).to];
  return `${fmt(a[0])} → ${fmt(a[1])}`;
};

export function wildfireSteps(w: WildfireSummary | null) {
  const mins = w?.next_issue_utc ? Math.max(0, Math.round((Date.parse(w.next_issue_utc) - Date.now()) / 60000)) : null;
  return {
    next: mins === null ? '—' : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
    watching: w ? w.open + w.awaiting : 0,
    record: w && w.scored > 0 ? `${Math.round((w.hits / w.scored) * 100)}%` : '—',
    recordSub: w && w.scored > 0 ? `${w.hits} of ${w.scored} kept burning` : 'first scores come about 75 h after the first forecast',
  };
}

function Card({ r, scored }: { r: WildfireRow; scored?: boolean }) {
  const p = Math.round(r.p_keeps_burning * 100);
  return (
    <div className="mx-3 my-2.5 rounded-lg border border-white/10 bg-[#0d1420] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-white tabular-nums">{r.lat.toFixed(2)}°, {r.lng.toFixed(2)}° <span className="ml-2 text-[#ff9f43]">{r.detections_24h} detections · {Math.round(r.frp_sum).toLocaleString('en-US')} MW</span></span>
        <span className="text-[11px] tabular-nums text-[#e4e8ef]">{p}% chance it keeps burning</span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
        <div className="h-1.5 rounded-full bg-[#ff9f43]" style={{ width: `${p}%` }} />
      </div>
      <div className="mt-2 text-[10px] leading-snug text-[#c3c8d2]">
        satellite detections in the last 24 h, grouped with fires of the same size{r.band ? ` (${r.band})` : ''}
        {r.base_n ? ` · based on ${r.base_n} similar fires` : ''}
      </div>
      <div className="mt-1 text-[10px] text-[#c3c8d2]">window {winText(r.window_utc)}</div>
      {scored && r.result && (
        <div className={`mt-2 text-[11px] ${r.result.kept_burning ? 'text-[#00f5c4]' : 'text-[#ffd166]'}`}>
          {r.result.kept_burning ? 'Held: it kept burning' : 'Missed: it burned out'}
          {` (${r.result.detections_in_window} detections in the window)`}
        </div>
      )}
    </div>
  );
}

export default function WildfireView({ w, err }: { w: WildfireSummary | null; err: string | null }) {
  if (err) return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[#ff6b6b]">{err}</div>;
  if (!w) return <div className="flex h-full items-center justify-center text-[11px] text-[#c3c8d2]">loading…</div>;
  return (
    <div className="pb-4">
      {w.open_forecasts.length === 0 && w.recent_scored.length === 0 && (
        <div className="px-6 py-8 text-center text-[11px] text-[#c3c8d2]">
          The first batch is issued a few minutes after the server starts. Nothing to show yet.
        </div>
      )}
      {w.open_forecasts.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">RUNNING NOW · {w.open_forecasts.length} STRONGEST</div>}
      {w.open_forecasts.map(r => <Card key={r.id} r={r} />)}
      {w.recent_scored.length > 0 && <div className="px-5 pt-3 text-[10px] tracking-[.16em] text-white">SCORED</div>}
      {w.recent_scored.map(r => <Card key={r.id} r={r} scored />)}
      <p className="mx-5 mt-3 text-[10px] leading-relaxed text-[#c3c8d2]">
        Method: the chance is the share of comparable fires in the last days of the NASA FIRMS 7-day feed that still burned 24–72 h later.
        It is a base rate, not a trained model. {w.brier !== null ? `Brier score ${w.brier.toFixed(3)}.` : ''}
      </p>
    </div>
  );
}
