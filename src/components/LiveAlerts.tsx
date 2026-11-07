'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MapPin, ExternalLink, AlertTriangle, X,
  Newspaper, Clock, Radio, Maximize2, Minimize2, Search
} from 'lucide-react';
import AiOverview from './AiOverview';

interface LiveAlertsProps {
  data: any;
  onLocate: (lat: number, lng: number) => void;
  onWatchFeed?: (url: string, name: string) => void;
  onClose?: () => void;
}

const RISK_COLORS: Record<string, string> = {
  HIGH: '#FF3D3D',
  CRITICAL: '#FF1744',
  ELEVATED: '#FF9500',
  MODERATE: '#FFD700',
  LOW: '#00E676',
};

const SEVERITY_RANK: Record<string, number> = { LOW: 0, MODERATE: 1, ELEVATED: 2, HIGH: 3, CRITICAL: 4 };
/** Minimum level shown; "ELEVATED" means elevated and everything above it. */
const SEVERITY_CHIPS = [
  { key: 'all', label: 'ALL', min: 0 },
  { key: 'elevated', label: 'ELEVATED +', min: 2 },
  { key: 'high', label: 'HIGH +', min: 3 },
  { key: 'critical', label: 'CRITICAL', min: 4 },
] as const;
const FEED_REGIONS = [
  { key: 'all', label: 'ALL REGIONS' }, { key: 'europe', label: 'EUROPE' }, { key: 'americas', label: 'AMERICAS' },
  { key: 'middleeast', label: 'MIDDLE EAST' }, { key: 'asia', label: 'ASIA PACIFIC' }, { key: 'africa', label: 'AFRICA' },
] as const;

export default function LiveAlerts({ data, onLocate, onWatchFeed, onClose }: LiveAlertsProps) {
  const [expanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [filter, setFilter] = useState<'all' | 'news' | 'quakes' | 'feeds'>('all');
  const [minSeverity, setMinSeverity] = useState<(typeof SEVERITY_CHIPS)[number]['key']>('all');
  const [feedRegion, setFeedRegion] = useState<(typeof FEED_REGIONS)[number]['key']>('all');
  const [query, setQuery] = useState('');

  // Built-in live feeds — verified video IDs (synced with /api/live-news)
  const BUILTIN_FEEDS = [
    // ── North America ──
    { name: 'NBC News NOW', city: 'New York', country: 'US', lat: 40.759, lng: -73.980, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCeY0bbntWzzVIaj2z3QigXg&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'CBS News 24/7', city: 'New York', country: 'US', lat: 40.764, lng: -73.973, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC8p1vwvWtl6T73JiExfWs1g&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'ABC News Live', city: 'New York', country: 'US', lat: 40.763, lng: -73.979, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCBi2mrWuNuyYy4gbM6fU18Q&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    { name: 'Bloomberg TV', city: 'New York', country: 'US', lat: 40.756, lng: -73.988, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC_vQ72b7v5n2938v9d5c80w&autoplay=1&mute=1', category: 'finance', region: 'americas' },
    { name: 'C-SPAN', city: 'Washington DC', country: 'US', lat: 38.897, lng: -77.036, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCb--64Gl51jIEVE-GLDAVTg&autoplay=1&mute=1', category: 'government', region: 'americas' },
    { name: 'CBC News', city: 'Toronto', country: 'CA', lat: 43.644, lng: -79.387, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCKy1dAqELon0zgzZPOz9SVw&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
    // ── Europe ──
    { name: 'Sky News', city: 'London', country: 'GB', lat: 51.500, lng: -0.118, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCoMdktPbSTixAyNGwb-UYkQ&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'France 24 EN', city: 'Paris', country: 'FR', lat: 48.830, lng: 2.280, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCQfwfsi5VrQ8yKZ-UWmAEFg&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'DW News', city: 'Berlin', country: 'DE', lat: 52.508, lng: 13.376, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'Euronews', city: 'Lyon', country: 'FR', lat: 45.764, lng: 4.836, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCtUbOIRGKZkW7555n6x6q6g&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'TRT World', city: 'Istanbul', country: 'TR', lat: 41.008, lng: 28.978, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC7fWeaHZQg1p9-4v98L1D1A&autoplay=1&mute=1', category: 'mainstream', region: 'europe' },
    { name: 'UKRINFORM', city: 'Kyiv', country: 'UA', lat: 50.450, lng: 30.523, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCaDkCK6iFHPE0lmpaYL-WxQ&autoplay=1&mute=1', category: 'conflict', region: 'europe' },
    // ── Middle East ──
    { name: 'Al Jazeera EN', city: 'Doha', country: 'QA', lat: 25.286, lng: 51.534, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCNye-wNBqNL5ZzHSJj3l8Bg&autoplay=1&mute=1', category: 'mainstream', region: 'middleeast' },
    { name: 'Al Mayadeen', city: 'Beirut', country: 'LB', lat: 33.8886, lng: 35.4955, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCZCFHCU-2eGF7V5ciMkoPHw&autoplay=1&mute=1', category: 'conflict', region: 'middleeast' },
    { name: 'LBCI Lebanon', city: 'Beirut', country: 'LB', lat: 33.8930, lng: 35.5018, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCpE6gpKewomi17XDyPfpFjA&autoplay=1&mute=1', category: 'mainstream', region: 'middleeast' },
    // ── Asia Pacific ──
    { name: 'NHK World', city: 'Tokyo', country: 'JP', lat: 35.690, lng: 139.692, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCSPEjw8F2nQDtmUKPFNF7_A&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'CNA 24/7', city: 'Singapore', country: 'SG', lat: 1.290, lng: 103.852, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC83jt4dlz1Gjl58fzQrrKZg&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'WION', city: 'New Delhi', country: 'IN', lat: 28.614, lng: 77.209, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC_gUM8rL-Lrg6O3adPW9K1g&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'Arirang', city: 'Seoul', country: 'KR', lat: 37.566, lng: 126.978, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCw9-5Y1CjW7Qy1Yf5q1y2-Q&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    { name: 'ABC AU', city: 'Sydney', country: 'AU', lat: -33.868, lng: 151.209, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC5iLnYoF4Ryb63YdGD9RfWQ&autoplay=1&mute=1', category: 'mainstream', region: 'asia' },
    // ── Africa ──
    { name: 'Africanews', city: 'Pointe-Noire', country: 'CG', lat: -4.778, lng: 11.865, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC5T2fB_W0Z31T0c8yN36a8A&autoplay=1&mute=1', category: 'mainstream', region: 'africa' },
    { name: 'SABC News', city: 'Johannesburg', country: 'ZA', lat: -26.204, lng: 28.047, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UC8yH-uI81UUtEMDsowQyx1g&autoplay=1&mute=1', category: 'mainstream', region: 'africa' },
    // ── Latin America ──
    { name: 'teleSUR EN', city: 'Caracas', country: 'VE', lat: 10.491, lng: -66.902, url: 'https://www.youtube-nocookie.com/embed/live_stream?channel=UCmuTmpLY35O3csvhyA6vrkg&autoplay=1&mute=1', category: 'mainstream', region: 'americas' },
  ];

  // Build unified alert feed
  const alerts: any[] = [];

  // OSINT Telegram News Feed (from /api/news)
  if (data.news) {
    data.news.forEach((a: any) => {
      alerts.push({
        type: 'news', title: a.title, description: a.description, source: a.source,
        lat: a.coords?.[0], lng: a.coords?.[1], time: a.published,
        severity: (a.risk_score ?? 1) >= 8 ? 'CRITICAL' : (a.risk_score ?? 1) >= 6 ? 'HIGH' : (a.risk_score ?? 1) >= 4 ? 'ELEVATED' : 'LOW',
        url: a.link,
      });
    });
  }

  // Earthquakes
  if (data.earthquakes) {
    data.earthquakes.slice(0, 5).forEach((eq: any) => {
      alerts.push({
        type: 'quake', title: `M${eq.magnitude} - ${eq.place}`, source: 'USGS',
        lat: eq.lat, lng: eq.lng, time: eq.time,
        severity: eq.magnitude >= 6 ? 'CRITICAL' : eq.magnitude >= 4.5 ? 'HIGH' : 'MODERATE',
      });
    });
  }

  // Built-in live feeds (always present)
  BUILTIN_FEEDS.forEach(f => {
    alerts.push({
      type: 'feed', title: f.name,
      source: `${f.city}, ${f.country}`,
      lat: f.lat, lng: f.lng,
      feedUrl: f.url, severity: 'LOW', category: f.category, region: f.region,
    });
  });

  const byType = filter === 'all' ? alerts.filter(a => a.type !== 'feed') :
    filter === 'news' ? alerts.filter(a => a.type === 'news') :
    filter === 'quakes' ? alerts.filter(a => a.type === 'quake') :
    alerts.filter(a => a.type === 'feed');
  const minRank = SEVERITY_CHIPS.find(c => c.key === minSeverity)?.min ?? 0;
  const q = query.trim().toLowerCase();
  const filtered = byType.filter(a =>
    (a.type === 'feed' ? (feedRegion === 'all' || a.region === feedRegion) : (SEVERITY_RANK[a.severity] ?? 0) >= minRank) &&
    (!q || `${a.title ?? ''} ${a.description ?? ''} ${a.source ?? ''}`.toLowerCase().includes(q)));
  const typeCounts = {
    all: alerts.filter(a => a.type !== 'feed').length,
    news: alerts.filter(a => a.type === 'news').length,
    quakes: alerts.filter(a => a.type === 'quake').length,
    feeds: alerts.filter(a => a.type === 'feed').length,
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'news': return Newspaper;
      case 'quake': return AlertTriangle;
      case 'feed': return Radio;
      default: return Newspaper;
    }
  };

  // Ensure portal only renders on client
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const content = (
    <motion.div
      layout
      initial={maximized ? { opacity: 0, scale: 0.97 } : { opacity: 0, x: 20 }}
      animate={maximized ? { opacity: 1, scale: 1 } : { opacity: 1, x: 0 }}
      transition={{ delay: maximized ? 0 : 0.5, duration: maximized ? 0.28 : 0.6, layout: { type: 'tween', duration: 0.38, ease: [0.2, 0.8, 0.2, 1] } }}
      className={`glass-panel flex flex-col overflow-hidden pointer-events-auto transition-all duration-300 h-full min-h-0 ${maximized ? 'fixed inset-4 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl' : ''}`}
    >
      {/* Header - Fixed Height, Never Shrinks */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.05)] bg-[#0a0f19]"
      >
        <div className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-[#FF4081]" />
          <span className="hud-text text-[10px] text-[var(--text-primary)]">LIVE ALERTS</span>
          <span className="gotham-tag gotham-tag--high" style={{ fontSize: '7px', padding: '1px 5px' }}>{alerts.filter(a => a.type === 'news' || a.type === 'quake').length}</span>
          <span className="gotham-tag gotham-tag--info" style={{ fontSize: '7px', padding: '1px 4px' }}>{BUILTIN_FEEDS.length} FEEDS</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#FF4081] animate-osiris-pulse" />
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); }} className="hover:text-white transition-colors" title={maximized ? "Restore" : "Maximize"}>
            {maximized ? <Minimize2 className="w-3 h-3 text-[var(--text-muted)]" /> : <Maximize2 className="w-3 h-3 text-[var(--text-muted)]" />}
          </button>
          {onClose && <button onClick={onClose} className="rounded p-1 hover:bg-white/10" title="Close"><X className="h-3.5 w-3.5 text-[#c3c8d2]" /></button>}
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={`flex flex-col flex-1 min-h-0 ${maximized ? 'bg-[#0a0a09]' : 'bg-transparent'}`}
          >
            {/* Filters: what kind, how serious, and a text search */}
            <div className={`flex-shrink-0 flex flex-col gap-2 border-b border-white/5 ${maximized ? 'px-8 py-4 bg-[#0d1117]' : 'px-3 py-2'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-full border border-white/10 bg-black/30 p-0.5">
                  {(['all', 'news', 'quakes', 'feeds'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${filter === f ? 'bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)]' : 'text-[#C9CED8] hover:bg-white/10 hover:text-white'}`}
                    >
                      {f.toUpperCase()}
                      <span className={`tabular-nums text-[9px] ${filter === f ? 'text-[var(--cyan-primary)]' : 'text-[#A3ABBA]'}`}>{typeCounts[f]}</span>
                    </button>
                  ))}
                </div>
                <div className="relative ml-auto min-w-[120px] max-w-[260px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[#A3ABBA]" />
                  <input
                    value={query} onChange={e => setQuery(e.target.value)} placeholder="Search alerts"
                    className="w-full rounded-full border border-white/10 bg-black/30 py-1 pl-7 pr-3 text-[11px] font-mono text-white placeholder:text-[#A3ABBA] outline-none focus:border-[var(--cyan-primary)]/50"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {filter === 'feeds'
                  ? FEED_REGIONS.map(r => (
                      <button key={r.key} onClick={() => setFeedRegion(r.key)}
                        className={`rounded-full border px-2.5 py-0.5 text-[9px] font-mono tracking-wider transition-colors ${feedRegion === r.key ? 'border-[var(--cyan-primary)]/60 bg-[var(--cyan-primary)]/15 text-[var(--cyan-primary)]' : 'border-white/10 text-[#C9CED8] hover:bg-white/10'}`}>
                        {r.label}
                      </button>
                    ))
                  : SEVERITY_CHIPS.map(c => (
                      <button key={c.key} onClick={() => setMinSeverity(c.key)}
                        className={`rounded-full border px-2.5 py-0.5 text-[9px] font-mono tracking-wider transition-colors ${minSeverity === c.key ? 'border-[#FF4081]/60 bg-[#FF4081]/15 text-[#FF8FB3]' : 'border-white/10 text-[#C9CED8] hover:bg-white/10'}`}>
                        {c.label}
                      </button>
                    ))}
              </div>
            </div>

            {/* One-click AI overview of the current alert picture */}
            <div className={`flex-shrink-0 ${maximized ? 'mx-auto w-full max-w-6xl px-8 pt-4' : 'px-3 pt-2'}`}>
              <AiOverview mode="alerts" payload={data} accent="#FF4081" />
            </div>

            {/* Alert List - Internally Scrolling */}
            <div className={`flex-1 overflow-y-auto styled-scrollbar ${maximized ? 'px-8 py-6' : 'p-3'}`}>
              <div className={maximized ? 'mx-auto grid w-full max-w-6xl grid-cols-1 gap-3 xl:grid-cols-2' : 'space-y-2'}>
                {filtered.map((alert, i) => {
                  const Icon = getIcon(alert.type);
                const sevColor = RISK_COLORS[alert.severity] || '#FFD700';
                return (
                  <div
                    key={i}
                    onClick={() => {
                      if (alert.lat !== undefined && alert.lng !== undefined) {
                        onLocate(alert.lat, alert.lng);
                      }
                      if (alert.feedUrl && onWatchFeed) {
                        onWatchFeed(alert.feedUrl, alert.title);
                      }
                    }}
                    className="w-full text-left p-2.5 rounded-lg bg-[#111111]/60 border border-[#2A2A28] hover:bg-[#1A1A1A] transition-all hover:border-[#3A3A38] group cursor-pointer"
                  >
                    <div className="flex items-start gap-2.5">
                      {/* Severity indicator */}
                      <div className="flex-shrink-0 mt-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: sevColor, boxShadow: `0 0 6px ${sevColor}60` }} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-1.5 mb-2">
                          <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-[2px]" style={{ color: sevColor }} />
                          {/* Prose, not data. This was font-mono at 10px, i.e. a
                              HUD typeface set at a size meant for a timestamp,
                              carrying three lines of running text. Mono stays on
                              the labels, sources and timestamps below, where the
                              character grid is the point; the sentence a human
                              actually reads gets the body face and two more
                              pixels (live feedback 2026-08-16). */}
                          <span className={`${maximized ? 'text-[14px]' : 'text-[12px]'} text-[#E8E6E0] leading-relaxed ${alert.type === 'news' ? 'line-clamp-3' : 'truncate'}`}>
                            {(alert.description || alert.title || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}
                          </span>
                        </div>
                        <div className="flex items-center justify-between border-t border-[#2A2A28]/50 pt-1.5 mt-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] font-mono text-[#B8BFCB] uppercase tracking-wider">{alert.source}</span>
                            {alert.time && (
                              <span className="text-[9px] font-mono text-[#A9B1BF] flex items-center gap-1 border-l border-[#2A2A28] pl-2">
                                <Clock className="w-2.5 h-2.5" />
                                {new Date(alert.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                          {alert.url && (
                            <a 
                              href={alert.url} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              className="text-[8px] font-mono text-[var(--cyan-primary)] hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              SOURCE
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Fly-to icon */}
                      {alert.lat !== undefined && (
                        <MapPin className="w-3 h-3 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
              {filtered.length === 0 && (
                <div className="text-center py-4 text-[10px] font-mono text-[var(--text-muted)]">
                  No alerts for this filter
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );

  if (maximized && mounted && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
