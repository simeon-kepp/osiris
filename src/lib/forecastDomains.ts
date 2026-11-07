export type ForecastDomainStatus = 'LIVE_SCORED' | 'HISTORICAL_ONLY' | 'BACKTESTED' | 'RESEARCH' | 'OBSERVATION_ONLY';

export interface ForecastDomain {
  id: string;
  label: string;
  question: string;
  status: ForecastDomainStatus;
  evidence: string;
  /** What stands between this lane and a live, scored forecast. */
  next: string;
}

/**
 * The center's domain contract. A lane is shown here only when its evidence
 * boundary is explicit; discovery work must not masquerade as a scored live
 * forecast just to make the dashboard look fuller.
 */
export const FORECAST_DOMAINS: ForecastDomain[] = [
  { id: 'seismic', label: 'SEISMIC', question: 'Will M5+ aftershocks follow the big quakes?', status: 'LIVE_SCORED', evidence: 'USGS ComCat · append-only scoring', next: 'Running. Issued every 6 hours and scored against USGS.' },
  { id: 'wildfire', label: 'WILDFIRE', question: 'Will a burning area keep burning?', status: 'HISTORICAL_ONLY', evidence: 'NASA FIRMS / GDACS · historical record present', next: 'Needs a scoring rule: a detection cluster that persists for N days. The history is already stored.' },
  { id: 'markets', label: 'MARKETS', question: 'Will price swings stay high?', status: 'BACKTESTED', evidence: 'Market history · backtest lane, not live-scored', next: 'Needs live issuing: the backtest runs, nothing is issued or scored yet.' },
  { id: 'weather', label: 'WEATHER', question: 'Will weather disrupt operations?', status: 'RESEARCH', evidence: 'ASOS / live weather · causal research lane', next: 'Needs a cause-and-effect model with an outcome we can check, for example flight delays.' },
  { id: 'space', label: 'SPACE WEATHER', question: 'Will a geomagnetic storm hit?', status: 'OBSERVATION_ONLY', evidence: 'NOAA SWPC · observation feed, scoring pending', next: 'Needs a threshold rule and scoring. The NOAA feed is already read.' },
];

export const FORECAST_STATUS_STYLE: Record<ForecastDomainStatus, { label: string; className: string }> = {
  LIVE_SCORED: { label: 'LIVE · SCORED', className: 'text-[#00f5c4]' },
  HISTORICAL_ONLY: { label: 'HISTORICAL', className: 'text-[#ffd166]' },
  BACKTESTED: { label: 'BACKTESTED', className: 'text-[#7fd4ff]' },
  RESEARCH: { label: 'RESEARCH', className: 'text-[#b388ff]' },
  OBSERVATION_ONLY: { label: 'OBSERVATION', className: 'text-[#aeb4c0]' },
};
