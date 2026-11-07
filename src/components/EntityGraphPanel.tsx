'use client';

import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import {
  X, Maximize2, Minimize2, Loader2, AlertTriangle,
  Plane, Ship, Building2, User, Globe, Newspaper, ShieldAlert,
  RefreshCw, Network, Wifi, Search, ChevronDown } from 'lucide-react';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

// The force-graph canvas draws its own text per node/link per frame, so a
// literal "'JetBrains Mono'" string in ctx.font only works when that font
// happens to be installed on the visitor's OS -- otherwise it silently
// falls through to plain monospace instead of the self-hosted webfont
// next/font already loaded for the rest of the page. Cached after the first
// real read since this runs inside a per-node paint callback, not once.
let cachedHudFont: string | null = null;
function hudFont(): string {
  if (cachedHudFont) return cachedHudFont;
  if (typeof document === 'undefined') return "'Inter', sans-serif";
  cachedHudFont = getComputedStyle(document.documentElement).getPropertyValue('--font-hud').trim()
    || "'Inter', sans-serif";
  return cachedHudFont;
}

// ── TYPES ──

interface EntityNode {
  id: string;
  label: string;
  type: 'aircraft' | 'vessel' | 'company' | 'person' | 'country' | 'event' | 'sanction' | 'ip';
  properties?: Record<string, any>;
  x?: number; y?: number;
}

interface EntityLink {
  source: string | EntityNode;
  target: string | EntityNode;
  label: string;
}

interface GraphData { nodes: EntityNode[]; links: EntityLink[]; }

// ── PALETTE ──

const TYPE_COLORS: Record<string, string> = {
  aircraft: '#00E5FF', vessel: '#00BCD4', company: '#D4AF37',
  person: '#B388FF', country: '#76FF03', event: '#FF9500', sanction: '#FF1744',
  ip: '#FF6D00',
};

const TYPE_ICONS: Record<string, typeof Plane> = {
  aircraft: Plane, vessel: Ship, company: Building2,
  person: User, country: Globe, event: Newspaper, sanction: ShieldAlert,
  ip: Wifi,
};

// ── TARGET PICKER ──
// The rail button opens this panel without a map click, so the panel must be able to start on its own.

const TARGET_TYPES = ['country', 'ip', 'aircraft', 'vessel', 'company', 'person'] as const;
const SUGGESTIONS: { type: string; id: string }[] = [
  { type: 'country', id: 'Ukraine' }, { type: 'country', id: 'Russia' }, { type: 'country', id: 'Iran' },
  { type: 'country', id: 'China' }, { type: 'country', id: 'Israel' }, { type: 'country', id: 'United States' },
];

// ── PROPS ──

interface Props {
  entity: { type: string; id: string; label?: string; properties?: Record<string, any> } | null;
  onClose: () => void;
}

function EntityGraphPanel({ entity, onClose }: Props) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<EntityNode | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Push nodes apart and let the camera fit them: the default forces packed a country and its 14 neighbours into a corner.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.d3Force('charge')?.strength(-380);
    g.d3Force('link')?.distance(95);
    g.d3ReheatSimulation?.();
  }, [graphData.nodes.length]);
  /** What the graph is built around: the map click that opened the panel, or whatever was typed here. */
  const [target, setTarget] = useState(entity);
  useEffect(() => { setTarget(entity); }, [entity]);
  const [draftType, setDraftType] = useState<string>('country');
  const [draftId, setDraftId] = useState('');
  const [typeOpen, setTypeOpen] = useState(false);
  useEffect(() => {
    if (!typeOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setTypeOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [typeOpen]);
  // Live starting points for the empty state; the static list below is only the fallback.
  const [groups, setGroups] = useState<{ title: string; items: { type: string; id: string; note: string }[] }[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/entity/suggest').then(r => (r.ok ? r.json() : null)).then(j => { if (alive && j?.groups) setGroups(j.groups); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const lockTarget = useCallback((type: string, id: string) => {
    const clean = id.trim();
    if (clean) setTarget({ type, id: clean, label: clean, properties: {} });
  }, []);
  /** The canvas has to be told its size; it does not follow the CSS box when the panel grows. */
  const [size, setSize] = useState({ w: 480, h: 400 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 480, h: el.clientHeight || 400 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mergeGraph = useCallback((existing: GraphData, incoming: GraphData): GraphData => {
    const nodeMap = new Map<string, EntityNode>();
    for (const n of existing.nodes) nodeMap.set(n.id, n);
    for (const n of incoming.nodes) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    const linkSet = new Set(existing.links.map(l => {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      return `${s}→${t}→${l.label}`;
    }));
    const merged = [...existing.links];
    for (const l of incoming.links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      const k = `${s}→${t}→${l.label}`;
      if (!linkSet.has(k)) { linkSet.add(k); merged.push(l); }
    }
    return { nodes: Array.from(nodeMap.values()), links: merged };
  }, []);

  // Every new target starts a new generation. A response that comes back after the
  // user has locked something else belongs to the old graph and must not be merged in.
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // `force` is for a fresh lock: expandedIds in this closure still holds the PREVIOUS
  // graph's keys until the reset below renders, so re-locking an entity that was
  // already expanded used to return here and leave a lone root node.
  const expandEntity = useCallback(async (type: string, id: string, properties?: Record<string, any>, force = false) => {
    const key = `${type}:${id}`;
    if (!force && expandedIds.has(key)) return;
    const gen = genRef.current;
    const signal = abortRef.current?.signal;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ type, id });
      // Forward extra properties for aircraft/vessel resolution
      if (properties?.registration) params.set('registration', properties.registration);
      if (properties?.model) params.set('model', properties.model);
      if (properties?.icao24) params.set('icao24', properties.icao24);
      const res = await fetch(`/api/entity/expand?${params}`, { cache: 'no-store', signal });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
      const data = await res.json();
      if (gen !== genRef.current) return;
      setGraphData(prev => mergeGraph(prev, { nodes: data.nodes || [], links: data.links || [] }));
      setExpandedIds(prev => new Set([...prev, key]));
    } catch (e) {
      if (gen === genRef.current) setError(e instanceof Error ? e.message : 'Expansion failed');
    }
    finally { if (gen === genRef.current) setLoading(false); }
  }, [expandedIds, mergeGraph]);

  useEffect(() => {
    if (!target) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    genRef.current++;
    const root: EntityNode = {
      id: `${target.type}:${target.id}`, label: target.label || target.id,
      type: target.type as EntityNode['type'], properties: target.properties,
    };
    setGraphData({ nodes: [root], links: [] });
    setExpandedIds(new Set());
    setSelectedNode(root);
    setError(null);
    expandEntity(target.type, target.id, target.properties, true);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeClick = useCallback((node: any) => {
    const n = node as EntityNode;
    setSelectedNode(n);
    const rawId = n.id.includes(':') ? n.id.split(':').slice(1).join(':') : n.id;
    if (!expandedIds.has(`${n.type}:${rawId}`)) expandEntity(n.type, rawId);
  }, [expandedIds, expandEntity]);

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as EntityNode;
    const isSelected = n === selectedNode;
    const color = TYPE_COLORS[n.type] || '#888';
    const size = isSelected ? 5 : 3.5;
    
    // Clean, precise circle
    ctx.beginPath();
    ctx.arc(n.x!, n.y!, size, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#fff' : 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Subtle target bracket for selected node (static, no pulsing)
    if (isSelected) {
      const bSize = size + 4;
      const bLen = 3;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // TL
      ctx.moveTo(n.x! - bSize, n.y! - bSize + bLen); ctx.lineTo(n.x! - bSize, n.y! - bSize); ctx.lineTo(n.x! - bSize + bLen, n.y! - bSize);
      // TR
      ctx.moveTo(n.x! + bSize - bLen, n.y! - bSize); ctx.lineTo(n.x! + bSize, n.y! - bSize); ctx.lineTo(n.x! + bSize, n.y! - bSize + bLen);
      // BL
      ctx.moveTo(n.x! - bSize, n.y! + bSize - bLen); ctx.lineTo(n.x! - bSize, n.y! + bSize); ctx.lineTo(n.x! - bSize + bLen, n.y! + bSize);
      // BR
      ctx.moveTo(n.x! + bSize - bLen, n.y! + bSize); ctx.lineTo(n.x! + bSize, n.y! + bSize); ctx.lineTo(n.x! + bSize, n.y! + bSize - bLen);
      ctx.stroke();
      
      // Faint outer ring
      ctx.beginPath(); ctx.arc(n.x!, n.y!, bSize + 2, 0, 2*Math.PI);
      ctx.strokeStyle = `${color}30`; ctx.lineWidth = 1; ctx.stroke();
    }

    // Clean label rendering
    const fontSize = Math.max(10 / globalScale, 3);
    if (fontSize > 3.5 || isSelected) {
      ctx.font = `${isSelected ? 'bold ' : ''}${fontSize}px ${hudFont()}`;
      ctx.fillStyle = isSelected ? '#fff' : `${color}cc`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      // Black background for text readability
      const label = n.label.length > 22 ? n.label.slice(0, 20) + '…' : n.label;
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(n.x! - textWidth/2 - 2, n.y! + size + 3, textWidth + 4, fontSize + 2);
      ctx.fillStyle = isSelected ? '#fff' : color;
      ctx.fillText(label, n.x!, n.y! + size + 4);
    }
  }, [selectedNode]);

  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const { source: s, target: t } = link;
    if (!s.x || !t.x) return;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
    // Smooth, thin, non-dashed lines
    ctx.strokeStyle = 'rgba(212,175,55,0.15)'; // faint gold
    ctx.lineWidth = Math.max(0.5, 1 / globalScale); 
    ctx.stroke();
    
    const fs = Math.max(8 / globalScale, 2);
    if (fs > 3) {
      ctx.font = `${fs}px ${hudFont()}`;
      ctx.fillStyle = 'rgba(212,175,55,0.4)';
      ctx.textAlign = 'center'; ctx.fillText(link.label || '', (s.x + t.x) / 2, (s.y + t.y) / 2);
    }
  }, []);

  // Removed early return to allow rendering empty panel

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 500, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 500, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed top-0 right-0 h-full z-[500] flex flex-col glass-panel"
        style={{
          width: expanded ? 'calc(100vw - 56px)' : '480px', maxWidth: 'calc(100vw - 56px)',
          transition: 'width 0.38s cubic-bezier(0.2, 0.8, 0.2, 1), right 0.38s cubic-bezier(0.2, 0.8, 0.2, 1)',
          borderLeft: '1px solid var(--border-primary)',
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          borderRadius: 0
        }}
      >
        <style>{`
          .scanline {
            position: absolute; inset: 0; pointer-events: none;
            background: linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0) 50%, rgba(212,175,55,0.03) 50%, rgba(212,175,55,0.03));
            background-size: 100% 4px;
            z-index: 10;
          }
          .hud-corner {
            position: absolute; width: 16px; height: 16px; border-color: rgba(212,175,55,0.4); border-style: solid; z-index: 20; pointer-events: none;
          }
          .hud-tl { top: 12px; left: 12px; border-width: 2px 0 0 2px; }
          .hud-tr { top: 12px; right: 12px; border-width: 2px 2px 0 0; }
          .hud-bl { bottom: 12px; left: 12px; border-width: 0 0 2px 2px; }
          .hud-br { bottom: 12px; right: 12px; border-width: 0 2px 2px 0; }
          
          .typewriter {
            display: inline-block; overflow: hidden; white-space: nowrap; border-right: 2px solid var(--gold-primary);
            animation: typing 0.8s steps(30, end) forwards, blink-caret 0.5s step-end 2, caret-off 0s 1s forwards;
          }
          @keyframes typing { from { width: 0 } to { width: 100% } }
          @keyframes caret-off { to { border-color: transparent } }
          @keyframes blink-caret { from, to { border-color: transparent } 50% { border-color: var(--gold-primary) } }
        `}</style>
        
        <div className="scanline" />
        <div className="hud-corner hud-tl" />
        <div className="hud-corner hud-tr" />
        <div className="hud-corner hud-bl" />
        <div className="hud-corner hud-br" />
        {/* HEADER */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-primary)] bg-[var(--gold-primary)]/5 relative z-20">
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-1.5 bg-[var(--gold-primary)] animate-osiris-pulse shadow-[0_0_8px_var(--gold-primary)]" />
            <span className="text-[12px] font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)]">[ DINGIR // ENTITY INTEL ]</span>
            {loading && <Loader2 className="w-3.5 h-3.5 text-[var(--gold-primary)] animate-spin" />}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setExpanded(!expanded)} className="p-1 hover:bg-[var(--gold-primary)]/20 rounded transition-colors border border-transparent hover:border-[var(--gold-primary)]/40">
              {expanded ? <Minimize2 className="w-3.5 h-3.5 text-[var(--gold-primary)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--gold-primary)]" />}
            </button>
            <button onClick={onClose} className="p-1 hover:bg-[#FF1744]/20 rounded transition-colors border border-transparent hover:border-[#FF1744]/40">
              <X className="w-3.5 h-3.5 text-[#FF1744]" />
            </button>
          </div>
        </div>

        {/* TARGET */}
        <form
          onSubmit={e => { e.preventDefault(); lockTarget(draftType, draftId); }}
          className="px-6 py-2 border-b border-[var(--border-primary)] flex items-center gap-2 bg-black/20 relative z-20"
        >
          {(() => { const t = target?.type ?? draftType; const I = TYPE_ICONS[t] || Network; return <I className="w-4 h-4 shrink-0" style={{ color: TYPE_COLORS[t] || 'var(--gold-primary)' }} />; })()}
          <div className="relative shrink-0">
            <button type="button" onClick={() => setTypeOpen(o => !o)}
              className="flex items-center gap-1 bg-black/40 border border-[var(--border-primary)] rounded px-2 py-1 text-[11px] font-mono text-white/90 uppercase hover:border-[var(--gold-primary)]/60">
              {draftType} <ChevronDown className="w-3 h-3 text-[var(--gold-primary)]" />
            </button>
            {typeOpen && (<>
              <div className="fixed inset-0 z-30" onClick={() => setTypeOpen(false)} />
              {/* Opens flush under the bar, not in the middle of the panel like the native list did. */}
              <div className="absolute left-0 top-full z-40 mt-2 w-40 overflow-hidden rounded border border-[var(--gold-primary)]/40 bg-[#0a0d14] shadow-lg">
                {TARGET_TYPES.map(t => { const I = TYPE_ICONS[t] || Network; return (
                  <button key={t} type="button" onClick={() => { setDraftType(t); setTypeOpen(false); }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-mono uppercase hover:bg-[var(--gold-primary)]/15 ${t === draftType ? 'text-[var(--gold-primary)]' : 'text-white/90'}`}>
                    <I className="w-3.5 h-3.5" style={{ color: TYPE_COLORS[t] }} />{t}
                  </button>); })}
              </div>
            </>)}
          </div>
          <input
            value={draftId} onChange={e => setDraftId(e.target.value)}
            placeholder={target ? `${target.label || target.id} — type another target` : 'Country, IP, callsign, vessel…'}
            className="min-w-0 flex-1 bg-black/40 border border-[var(--border-primary)] rounded px-2 py-1 text-[12px] font-mono text-white placeholder:text-white/50 outline-none focus:border-[var(--gold-primary)]/60"
          />
          <button type="submit" className="flex items-center gap-1 rounded border border-[var(--gold-primary)]/40 bg-[var(--gold-primary)]/10 px-2 py-1 text-[10px] font-mono tracking-widest text-[var(--gold-primary)] hover:bg-[var(--gold-primary)]/20 transition-colors">
            <Search className="w-3 h-3" /> LOCK
          </button>
          <span className="hidden sm:block text-[10px] font-mono text-[var(--gold-primary)]/80 tracking-widest whitespace-nowrap">{graphData.nodes.length} NODES // {graphData.links.length} LINKS</span>
        </form>

        {/* ERROR */}
        {error && (
          <div className="px-6 py-2 bg-[#FF1744]/10 border-b border-[#FF1744]/30 flex items-center gap-2 relative z-20 shadow-[inset_0_0_15px_rgba(255,23,68,0.2)]">
            <AlertTriangle className="w-3.5 h-3.5 text-[#FF1744]" />
            <span className="text-[10px] font-mono font-bold tracking-widest text-[#FF1744] uppercase">[ ERR: {error} ]</span>
          </div>
        )}

        {/* GRAPH */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden" style={{ minHeight: 300 }}>
          {graphData.nodes.length > 0 && (
              <ForceGraph2D
              ref={graphRef} graphData={graphData} nodeId="id"
              nodeCanvasObject={paintNode} linkCanvasObject={paintLink}
              onNodeClick={handleNodeClick} backgroundColor="rgba(0,0,0,0)"
              nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, 9, 0, 2 * Math.PI); ctx.fill();
              }}
              onNodeHover={(node: any) => { if (containerRef.current) containerRef.current.style.cursor = node ? 'pointer' : 'default'; }}
              width={size.w}
              height={size.h}
              d3AlphaDecay={0.03} d3VelocityDecay={0.35} cooldownTicks={220}
              onEngineStop={() => graphRef.current?.zoomToFit(500, 60)}
              linkDirectionalParticles={1} linkDirectionalParticleWidth={1.5}
              linkDirectionalParticleSpeed={0.003}
              linkDirectionalParticleColor={() => 'rgba(212,175,55,0.6)'}
            />
          )}
          {graphData.nodes.length === 0 && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              <Network className="w-8 h-8 text-[var(--gold-primary)]/60" />
              <p className="text-[12px] font-mono text-white/80 leading-relaxed max-w-[340px]">
                Pick a target above, or start from what is happening right now. Click any node afterwards to open it and pull in what is linked to it.
              </p>
              {(() => {
                // Few chips on purpose: the two hottest conflict zones and the two most attacked countries.
                const live = groups.length ? [...(groups[0]?.items ?? []).slice(0, 3), ...(groups[1]?.items ?? []).slice(0, 2)] : SUGGESTIONS.slice(0, 4).map(x => ({ ...x, note: '' }));
                return (
                  <div className="flex flex-wrap justify-center gap-2">
                    {live.map(sg => (
                      <button key={`${sg.type}:${sg.id}`} onClick={() => { setDraftType(sg.type); setDraftId(''); lockTarget(sg.type, sg.id); }}
                        className="rounded-full border border-[var(--gold-primary)]/40 bg-[var(--gold-primary)]/10 px-3 py-1 text-[11px] font-mono text-[var(--gold-primary)] hover:bg-[var(--gold-primary)]/20">
                        {sg.id}{sg.note ? <span className="ml-1.5 text-white/60">{sg.note}</span> : null}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* SELECTED NODE */}
        <AnimatePresence>
          {selectedNode && (
            <motion.div initial={{ y: 20, opacity: 0, filter: 'blur(10px)' }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }} exit={{ y: 20, opacity: 0, filter: 'blur(10px)' }}
              transition={{ duration: 0.3 }}
              className="border-t border-[var(--border-primary)] px-6 py-4 max-h-[40%] overflow-y-auto relative z-20 glass-panel-sm m-4"
            >
              <div className="flex items-center justify-between mb-3 border-b border-[var(--border-secondary)] pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-[var(--gold-primary)] animate-osiris-pulse shadow-[0_0_8px_var(--gold-primary)]" />
                  {(() => { const I = TYPE_ICONS[selectedNode.type] || Globe; return <I className="w-4 h-4" style={{ color: TYPE_COLORS[selectedNode.type] }} />; })()}
                  <span className="text-[13px] font-mono font-bold text-white tracking-[0.1em] uppercase">{selectedNode.label}</span>
                </div>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 border"
                  style={{ color: TYPE_COLORS[selectedNode.type], borderColor: `${TYPE_COLORS[selectedNode.type]}80`, background: `${TYPE_COLORS[selectedNode.type]}15`, textShadow: `0 0 5px ${TYPE_COLORS[selectedNode.type]}` }}>
                  [{selectedNode.type.toUpperCase()}]
                </span>
              </div>
              {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-2">
                  {Object.entries(selectedNode.properties).map(([k, v], i) => (
                    <div key={`${selectedNode.id}-${k}`}>
                      <span className="text-[9px] font-mono text-[var(--gold-primary)]/70 uppercase tracking-widest">{k.replace(/_/g, ' ')}</span>
                      <div className="text-[11px] font-mono text-white/90 truncate flex items-center gap-1 mt-0.5">
                        <span className="w-1 h-1 bg-[var(--gold-primary)]/40 inline-block" />
                        <span className="typewriter" style={{ animationDelay: `${i * 0.1}s` }}>
                          {typeof v === 'boolean' ? (v ? 'YES' : 'NO') : String(v || '—')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!expandedIds.has(`${selectedNode.type}:${selectedNode.id.includes(':') ? selectedNode.id.split(':').slice(1).join(':') : selectedNode.id}`) && (
                <button onClick={() => {
                  const rawId = selectedNode.id.includes(':') ? selectedNode.id.split(':').slice(1).join(':') : selectedNode.id;
                  expandEntity(selectedNode.type, rawId);
                }} className="btn-tactical w-full mt-4 flex items-center justify-center gap-2" disabled={loading}>
                  {loading ? <Loader2 className="w-3.5 h-3.5 text-[var(--gold-primary)] animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 text-[var(--gold-primary)]" />}
                  <span className="text-[11px] font-mono font-bold text-[var(--gold-primary)] tracking-[0.2em]">[ ACQUIRE TARGET DATA ]</span>
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* LEGEND */}
        <div className="px-4 py-2 border-t border-white/5 flex items-center gap-3 flex-wrap">
          {Object.entries(TYPE_COLORS).map(([t, c]) => (
            <div key={t} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ background: c }} />
              <span className="text-[8px] font-mono text-white/70 uppercase">{t}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default memo(EntityGraphPanel);
