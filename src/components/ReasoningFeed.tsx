'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Radio, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import { useLocale } from '@/lib/LocaleProvider';

// What DINGIR is currently noticing, readable like an RSS feed.
//
// The design constraint that shapes everything here: an observation and a guess
// must never look alike in a feed somebody is going to act on. So `kind` is not
// a category chip bolted on afterwards, it is the first thing rendered, it has
// its own colour, and PREDICTED entries carry an explicit "hypothesis" marker
// in the body text rather than relying on the reader to remember what the chip
// meant.
//
// Transport is SSE from /api/reasoning/feed, where a single server-side poller
// fans out to every client. bi_api allows 100 requests/hour per token, so a
// per-client poll would lock the whole API out with two tabs open.

type FeedItem = {
  kind: 'ANOMALY' | 'HUB' | 'PREDICTION' | 'CHANGE' | string;
  provenance: 'OBSERVED' | 'DERIVED' | 'PREDICTED' | string;
  score: number;
  title: string;
  detail: string;
  nodes: string[];
  relation?: string;
  epistemic_status?: string;
  timestamp?: string;
};
type Snapshot = {
  items: FeedItem[];
  counts: Record<string, number>;
  graph: { nodes: number; edges: number };
};

const KIND_STYLE: Record<string, { dot: string; label: string; hint: string }> = {
  ANOMALY: {
    dot: '#ff6b6b', label: 'ANOMALY',
    hint: 'This node sits far from the company it keeps. Computed from observed structure.',
  },
  HUB: {
    dot: '#00f5c4', label: 'HUB',
    hint: 'A plain count of observed edges. The one entry type you can take at face value.',
  },
  PREDICTION: {
    dot: '#b388ff', label: 'PREDICTION',
    hint: 'The model expects a relation here that has no edge behind it. A hypothesis, not evidence.',
  },
  CHANGE: {
    dot: '#ffd166', label: 'CHANGE',
    hint: 'A state transition the ingestion pipeline actually recorded.',
  },
};
const FALLBACK_STYLE = { dot: '#8a8aa0', label: 'ENTRY', hint: '' };

interface Props {
  onClose: () => void;
  onInspect?: (nodeId: string) => void;
  /** True while the reasoning panel is open. Both are `fixed right-0`, so the
   *  feed steps aside to sit beside it -- but only from xl up, where 460 + 520
   *  px actually fit. On a narrower screen the panel simply covers the feed,
   *  which stays connected and reappears when the panel closes. */
  shifted?: boolean;
}

export default function ReasoningFeed({ onClose, onInspect, shifted }: Props) {
  const { t: tr } = useLocale();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<Set<string>>(new Set());
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const seenTitles = useRef<Set<string>>(new Set());
  const [freshTitles, setFreshTitles] = useState<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource('/api/reasoning/feed');
    es.addEventListener('status', () => { setConnected(true); setError(null); });
    es.addEventListener('snapshot', (e) => {
      try {
        const s = JSON.parse((e as MessageEvent).data) as Snapshot;
        // Mark what is new since the last snapshot. An unread marker is the
        // difference between a feed and a table that happens to refresh.
        const fresh = new Set<string>();
        for (const item of s.items) {
          if (!seenTitles.current.has(item.title)) fresh.add(item.title);
          seenTitles.current.add(item.title);
        }
        setFreshTitles(fresh);
        setSnapshot(s);
        setLastUpdate(Date.now());
      } catch { /* malformed frame, wait for the next */ }
    });
    es.onerror = () => {
      setConnected(false);
      // EventSource reconnects on its own; saying "lost" would be wrong.
      setError(tr('feed.reconnecting'));
    };
    return () => es.close();
  }, []);

  const kinds = snapshot ? Object.keys(snapshot.counts) : [];
  const shown = snapshot
    ? snapshot.items.filter(i => visibleKinds.size === 0 || visibleKinds.has(i.kind))
    : [];

  const toggleKind = (k: string) => setVisibleKinds(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 500, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 500, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={`fixed top-0 right-0 h-full z-[499] flex flex-col glass-panel ${expanded ? 'w-[900px] max-w-[95vw]' : 'w-[460px] max-w-[92vw]'} ${shifted && !expanded ? 'xl:right-[520px]' : ''}`}
        style={{ borderLeft: '1px solid var(--border-primary)', borderRadius: 0 }}
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div>
            <div className="hud-text text-[13px] text-[var(--text-primary)] flex items-center gap-2">
              <Radio className={`w-3.5 h-3.5 ${connected ? 'text-[var(--cyan-primary)]' : 'text-[var(--text-muted)]'}`} />
              {tr('feed.title')}
            </div>
            <div className="text-[9px] text-[var(--text-muted)] font-mono tracking-wide">
              {snapshot
                ? `${snapshot.graph.nodes} nodes · ${snapshot.graph.edges} edges${lastUpdate ? ` · updated ${new Date(lastUpdate).toLocaleTimeString()}` : ''}`
                : (error || tr('feed.connecting'))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setExpanded(e => !e)} title={expanded ? 'Collapse' : 'Expand'}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              {expanded ? <Minimize2 className="w-4 h-4 text-[var(--text-muted)]" />
                        : <Maximize2 className="w-4 h-4 text-[var(--text-muted)]" />}
            </button>
            <button onClick={onClose} title="Close"
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              <X className="w-4 h-4 text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        {kinds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-white/[0.06] shrink-0">
            {kinds.map(k => {
              const st = KIND_STYLE[k] || FALLBACK_STYLE;
              const on = visibleKinds.size === 0 || visibleKinds.has(k);
              return (
                <button key={k} onClick={() => toggleKind(k)} title={st.hint}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-[9px] font-mono tracking-wide border transition ${
                    on ? 'border-white/20 text-[var(--text-primary)]' : 'border-white/5 text-[var(--text-muted)] line-through'}`}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.dot }} />
                  {st.label} {snapshot?.counts[k]}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {!snapshot ? (
            <div className="flex h-full items-center justify-center gap-2 px-6 text-center text-[11px] text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {tr('feed.waiting')}
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-[var(--text-muted)]">
              {tr('feed.empty')}
            </div>
          ) : shown.map((item, i) => {
            const st = KIND_STYLE[item.kind] || FALLBACK_STYLE;
            const isGuess = item.provenance === 'PREDICTED';
            return (
              <div key={`${item.title}-${i}`}
                className={`px-4 py-2.5 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors ${isGuess ? 'bg-[#b388ff]/[0.04]' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: st.dot }} />
                  <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">{st.label}</span>
                  {freshTitles.has(item.title) && (
                    <span className="text-[7px] font-mono tracking-widest text-[var(--cyan-primary)] border border-[var(--cyan-primary)]/40 rounded px-1">NEW</span>
                  )}
                  <span className="ml-auto text-[8px] font-mono text-[var(--text-muted)]">{item.score}</span>
                </div>
                <button
                  onClick={() => item.nodes[0] && onInspect?.(item.nodes[0])}
                  className="block w-full text-left text-[11px] font-mono text-[var(--text-primary)] leading-snug hover:text-[var(--cyan-primary)] transition-colors">
                  {item.title}
                </button>
                <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">
                  {item.detail}
                </p>
                {isGuess && (
                  // Spelled out on every single entry, not just in the legend.
                  // A reader scrolling a feed does not carry the legend with them.
                  <p className="mt-1 text-[9px] font-mono tracking-wide text-[#b388ff]">
                    {tr('feed.hypothesis')} {item.epistemic_status || 'PLAUSIBLE'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
