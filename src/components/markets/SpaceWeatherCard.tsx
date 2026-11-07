'use client';

import { AlertTriangle, Radio, Zap } from 'lucide-react';

interface SpaceWeather {
  kp_index?: number | string;
  storm_color?: string;
  storm_level?: string;
  alerts?: unknown[];
  solar_flares?: Array<{ class?: string }>;
}

export default function SpaceWeatherCard({ weather, compact = false }: { weather?: SpaceWeather | null; compact?: boolean }) {
  if (!weather) return null;
  const kp = Number(weather.kp_index);
  const storm = weather.storm_color || '#8b96a6';
  const elevated = Number.isFinite(kp) && kp >= 4;
  const relevance = elevated
    ? 'Elevated geomagnetic activity — check GNSS, HF and satellite dependencies.'
    : 'Low geomagnetic activity — no elevated space-weather signal detected.';
  const flare = weather.solar_flares?.[0];

  // Header chip: space weather is context here, not the headline.
  if (compact) {
    return (
      <span
        className="flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[8px] tracking-wider"
        style={{ borderColor: `${storm}66`, color: storm }}
        title={`${relevance} ${flare?.class ? `${flare.class} flare. ` : ''}${weather.alerts?.length || 0} active feed alerts.`}
      >
        <Zap className="h-2.5 w-2.5" />
        Kp {Number.isFinite(kp) ? kp.toFixed(1) : '—'}
        <span className="uppercase text-[#b7c0ce]">{weather.storm_level || ''}</span>
      </span>
    );
  }

  return (
    <section className="rounded-lg border p-3" style={{ borderColor: `${storm}66`, background: `${storm}0d` }} aria-label="Space weather status">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Zap className="h-3.5 w-3.5" style={{ color: storm }} />
          <div>
            <div className="font-mono text-[10px] font-semibold tracking-[.16em] text-white">SPACE WEATHER</div>
            <div className="mt-0.5 font-mono text-[8px] tracking-wide text-[#b7c0ce]">NOAA SWPC · geomagnetic context</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[14px] font-bold tabular-nums" style={{ color: storm }}>Kp {Number.isFinite(kp) ? kp.toFixed(1) : '—'}</div>
          <div className="font-mono text-[8px] font-semibold uppercase tracking-wider text-white">{weather.storm_level || 'Unknown'}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
          <div className="flex items-center gap-1.5 font-mono text-[8px] tracking-wider text-[#b7c0ce]"><Radio className="h-3 w-3" /> OPERATIONAL RELEVANCE</div>
          <div className="mt-1 font-mono text-[9px] leading-relaxed text-white">{relevance}</div>
        </div>
        <div className="rounded border border-white/10 bg-black/20 px-2 py-1.5">
          <div className="flex items-center gap-1.5 font-mono text-[8px] tracking-wider text-[#b7c0ce]"><AlertTriangle className="h-3 w-3" /> LATEST SOLAR SIGNAL</div>
          <div className="mt-1 font-mono text-[9px] text-white">{flare?.class ? `${flare.class} flare` : 'No recent flare reported'}</div>
          <div className="mt-0.5 font-mono text-[8px] text-[#b7c0ce]">{weather.alerts?.length || 0} active feed alerts</div>
        </div>
      </div>
    </section>
  );
}
