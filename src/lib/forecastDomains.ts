export type ForecastDomainStatus = 'LIVE_SCORED' | 'HISTORICAL_ONLY' | 'BACKTESTED' | 'RESEARCH' | 'OBSERVATION_ONLY';

export interface ForecastDomain {
  id: string;
  label: string;
  question: string;
  status: ForecastDomainStatus;
  evidence: string;
}

/**
 * The center's domain contract. A lane is shown here only when its evidence
 * boundary is explicit; discovery work must not masquerade as a scored live
 * forecast just to make the dashboard look fuller.
 */
export const FORECAST_DOMAINS: ForecastDomain[] = [
  { id: 'seismic', label: 'SEISMIC', question: 'M5+ activity / aftershock count', status: 'LIVE_SCORED', evidence: 'USGS ComCat · append-only scoring' },
  { id: 'wildfire', label: 'WILDFIRE', question: 'Persistence of active fire detections', status: 'HISTORICAL_ONLY', evidence: 'NASA FIRMS / GDACS · historical record present' },
  { id: 'markets', label: 'MARKETS', question: 'Volatility regime persistence', status: 'BACKTESTED', evidence: 'Market history · backtest lane, not live-scored' },
  { id: 'weather', label: 'WEATHER', question: 'Weather-linked operational disruption', status: 'RESEARCH', evidence: 'ASOS / live weather · causal research lane' },
  { id: 'space', label: 'SPACE WEATHER', question: 'Geomagnetic activity threshold', status: 'OBSERVATION_ONLY', evidence: 'NOAA SWPC · observation feed, scoring pending' },
];

export const FORECAST_STATUS_STYLE: Record<ForecastDomainStatus, { label: string; className: string }> = {
  LIVE_SCORED: { label: 'LIVE · SCORED', className: 'text-[#00f5c4]' },
  HISTORICAL_ONLY: { label: 'HISTORICAL', className: 'text-[#ffd166]' },
  BACKTESTED: { label: 'BACKTESTED', className: 'text-[#7fd4ff]' },
  RESEARCH: { label: 'RESEARCH', className: 'text-[#b388ff]' },
  OBSERVATION_ONLY: { label: 'OBSERVATION', className: 'text-[#aeb4c0]' },
};
