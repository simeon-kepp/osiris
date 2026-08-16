'use client';

import { useState, useRef, useEffect, useCallback, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, Loader2, Maximize2, Minimize2 } from 'lucide-react';
import NetworkView, { TYPE_SWATCH, type NetworkGraph } from './NetworkView';

// DINGIR Reasoning Panel — a whitebox view into DINGIR's trained graph-node
// embeddings, the same idea as Albert's/Lighthouse's "Mycelium Inspector"
// (PCA-3D + cosine-kNN over a model's own vectors) but pointed at
// kindom/execution/bi_api.py's /reasoning/mycelium instead of a language
// model's token embeddings. Query a node id (e.g. an app, signal, vendor
// tracked in the EvidenceGraph) and see its nearest neighbours in the
// space DINGIR's GCN actually learned, not a canned demo.

interface Neighbor { word: string; type: string; sim: number; x: number; y: number; z: number }
interface MycResp {
  word: string; type: string; center_x: number; center_y: number; center_z: number;
  neighbors: Neighbor[]; vocab_size: number; dims: number; error?: string;
}

const TURBO: [number, number, number][] = [
  [48, 18, 59], [62, 84, 205], [33, 168, 224], [42, 215, 175], [122, 230, 78],
  [219, 220, 42], [246, 154, 34], [225, 79, 28], [122, 4, 3],
];
function turbo(t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t)) * (TURBO.length - 1);
  const i = Math.floor(u), f = u - i;
  const a = TURBO[i], b = TURBO[Math.min(i + 1, TURBO.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function simColor(t: number, depth = 1, alpha = 1): string {
  const [r, g, b] = turbo(t);
  const k = 0.5 + 0.5 * depth;
  return `rgba(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)}, ${alpha})`;
}

function knnEdges(nb: Neighbor[]): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nb.length; i++) {
    const ds: [number, number][] = [];
    for (let j = 0; j < nb.length; j++) {
      if (i === j) continue;
      const dx = nb[i].x - nb[j].x, dy = nb[i].y - nb[j].y, dz = nb[i].z - nb[j].z;
      ds.push([dx * dx + dy * dy + dz * dz, j]);
    }
    ds.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < 3 && k < ds.length; k++) {
      const j = ds[k][1];
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(key)) { seen.add(key); out.push([i, j]); }
    }
  }
  return out;
}

type Screen = { x: number; y: number; r: number; depth: number; word: string };

interface Props { onClose: () => void }

export default function ReasoningPanel({ onClose }: Props) {
  const [input, setInput] = useState('');
  const [node, setNode] = useState('');
  // 'network' is a different renderer, not a different projection: 2d/3d draw
  // one node's neighbourhood on a canvas, network draws the entire graph in
  // WebGL from precomputed embedding coordinates. See NetworkView.tsx for why
  // the canvas renderer cannot be reused at that scale.
  const [mode, setMode] = useState<'2d' | '3d' | 'network'>('3d');
  const [graph, setGraph] = useState<NetworkGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [visibleProv, setVisibleProv] = useState<Set<string>>(new Set(['OBSERVED', 'DERIVED', 'PREDICTED']));
  const [data, setData] = useState<MycResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Node ids are exact strings like "APP:Pokemon GO" across 1026 nodes, so the
  // box needs to suggest rather than expect them typed from memory.
  const [suggestions, setSuggestions] = useState<{ id: string; type: string }[]>([]);
  const [nodeTotal, setNodeTotal] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchNode = useCallback((word: string) => {
    const q = word.trim();
    if (!q) return;
    setLoading(true); setError(null); setSuggestions([]);
    fetch(`/api/reasoning/mycelium?node=${encodeURIComponent(q)}&k=60`)
      .then(async r => {
        // The gate answers 404 with an empty body, so status has to be checked
        // before parsing -- r.json() on an empty body throws a syntax error
        // that would surface as noise instead of "you are signed out".
        if (r.status === 404) throw new Error('Signed out — sign in with GitHub to use the reasoning panel.');
        return r.json() as Promise<MycResp>;
      })
      .then((d: MycResp) => {
        if (d.error) { setError(d.error); setData(null); }
        else { setData(d); setNode(q); }
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Debounced so a fast typist doesn't fire one request per keystroke. The
  // node list is cached server-side, so these are cheap after the first.
  useEffect(() => {
    const q = input.trim();
    if (!q || q === node) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/reasoning/nodes?q=${encodeURIComponent(q)}`)
        .then(r => (r.ok ? r.json() : null))
        .then((d: { nodes?: { id: string; type: string }[]; total?: number } | null) => {
          if (!d) return;
          setSuggestions(d.nodes ?? []);
          if (typeof d.total === 'number') setNodeTotal(d.total);
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [input, node]);

  // Fetched once, on first switch into network mode: the payload is derived
  // from a model trained by a batch job, so re-fetching per open would only add
  // latency. The proxy caches it server-side too.
  useEffect(() => {
    if (mode !== 'network' || graph || graphLoading) return;
    setGraphLoading(true); setGraphError(null);
    fetch('/api/reasoning/graph')
      .then(async r => {
        if (r.status === 404) throw new Error('Signed out — sign in with GitHub to load the network.');
        return r.json() as Promise<NetworkGraph>;
      })
      .then(d => { if (d.error) setGraphError(d.error); else setGraph(d); })
      .catch(e => setGraphError(e instanceof Error ? e.message : String(e)))
      .finally(() => setGraphLoading(false));
  }, [mode, graph, graphLoading]);

  const toggleProv = (p: string) => setVisibleProv(prev => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Enter on a typed prefix should do the obvious thing: take the top match.
    fetchNode(suggestions.length && !suggestions.some(s => s.id === input.trim()) ? suggestions[0].id : input);
  };
  const ok = !!data && !data.error;

  const sims = ok ? data!.neighbors.map(n => n.sim) : [];
  const minS = sims.length ? Math.min(...sims) : 0;
  const maxS = sims.length ? Math.max(...sims) : 0;
  const spanS = Math.max(1e-6, maxS - minS);

  // ── canvas renderer ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef({ angle: 0.6, tilt: 0.42, zoom: 1, panX: 0, panY: 0 });
  const drag = useRef({ on: false, x: 0, y: 0, moved: false });
  const screens = useRef<Screen[]>([]);
  const dataRef = useRef<MycResp | null>(null);
  const modeRef = useRef(mode);
  dataRef.current = data;
  modeRef.current = mode;

  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext('2d')!;
    let raf = 0;

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth, h = wrap.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(wrap);

    const draw = () => {
      const d = dataRef.current;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      ctx.clearRect(0, 0, w, h);
      if (!d || d.error) { raf = requestAnimationFrame(draw); return; }

      const v = view.current;
      const S = Math.min(w, h) * 0.34 * v.zoom;
      const is3d = modeRef.current === '3d';
      let minSim = Infinity, maxSim = -Infinity;
      for (const n of d.neighbors) { if (n.sim < minSim) minSim = n.sim; if (n.sim > maxSim) maxSim = n.sim; }
      const span = Math.max(1e-6, maxSim - minSim);
      const tOf = (s: number) => (s - minSim) / span;

      const proj = (x: number, y: number, z: number): [number, number, number] => {
        if (!is3d) return [w / 2 + x * S + v.panX, h / 2 - y * S + v.panY, 1];
        const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
        let rx = x * ca - z * sa, rz = x * sa + z * ca;
        const ct = Math.cos(v.tilt), st = Math.sin(v.tilt);
        const ry = y * ct - rz * st; rz = y * st + rz * ct;
        const persp = 2.6 / (2.6 + rz);
        return [w / 2 + rx * persp * S + v.panX, h / 2 - ry * persp * S + v.panY, persp];
      };

      if (is3d) {
        const C = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
        const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        const cp = C.map(([x,y,z]) => proj(x*1.15, y*1.15, z*1.15));
        ctx.strokeStyle = 'rgba(148,163,184,0.4)'; ctx.lineWidth = 1;
        for (const [a,b] of E) { ctx.beginPath(); ctx.moveTo(cp[a][0], cp[a][1]); ctx.lineTo(cp[b][0], cp[b][1]); ctx.stroke(); }
      }

      const [ccx, ccy] = proj(0, 0, 0);
      const rel = (n: Neighbor): [number, number, number] => proj(n.x - d.center_x, n.y - d.center_y, n.z - d.center_z);

      const nodes = d.neighbors.map(n => {
        const [x, y, depth] = rel(n);
        return { n, x, y, depth };
      }).sort((a, b) => a.depth - b.depth);

      const edges = knnEdges(d.neighbors);
      const sp = d.neighbors.map(rel);
      for (const [i, j] of edges) {
        const et = (tOf(d.neighbors[i].sim) + tOf(d.neighbors[j].sim)) / 2;
        const ed = is3d ? (sp[i][2] + sp[j][2]) / 2 : 1;
        ctx.strokeStyle = simColor(et, ed, 0.10 + 0.4 * et);
        ctx.lineWidth = 0.5 + 2 * et * et;
        ctx.beginPath(); ctx.moveTo(sp[i][0], sp[i][1]); ctx.lineTo(sp[j][0], sp[j][1]); ctx.stroke();
      }
      for (const { n, x, y, depth } of nodes) {
        const st = tOf(n.sim);
        ctx.strokeStyle = simColor(st, is3d ? depth : 1, 0.08 + 0.28 * st);
        ctx.lineWidth = 0.6 + 1.6 * st * st;
        ctx.beginPath(); ctx.moveTo(ccx, ccy); ctx.lineTo(x, y); ctx.stroke();
      }

      const scr: Screen[] = [];
      for (const { n, x, y, depth } of nodes) {
        const r = (2.5 + tOf(n.sim) * 6) * (is3d ? 0.6 + 0.6 * depth : 1);
        ctx.save();
        ctx.shadowColor = simColor(tOf(n.sim), 1, 0.9);
        ctx.shadowBlur = is3d ? 3 + 6 * depth : 9;
        ctx.fillStyle = simColor(tOf(n.sim), is3d ? depth : 1, 0.95);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        if (tOf(n.sim) > 0.2 || !is3d) {
          ctx.fillStyle = 'rgba(180,190,200,0.7)';
          ctx.globalAlpha = is3d ? 0.35 + 0.55 * depth : 0.8;
          ctx.font = '9px "JetBrains Mono", monospace';
          ctx.fillText(n.word.slice(0, 24), x + r + 3, y + 3);
          ctx.globalAlpha = 1;
        }
        scr.push({ x, y, r: Math.max(r, 7), depth, word: n.word });
      }

      ctx.fillStyle = '#00E5FF';
      ctx.beginPath(); ctx.arc(ccx, ccy, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px "JetBrains Mono", monospace';
      ctx.fillText(d.word, ccx + 12, ccy + 5);
      screens.current = scr;

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onDown = (e: PointerEvent) => { drag.current = { on: true, x: e.clientX, y: e.clientY, moved: false }; cv.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!drag.current.on) return;
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      const v = view.current;
      if (modeRef.current === '3d') { v.angle += dx * 0.01; v.tilt = Math.max(-1.4, Math.min(1.4, v.tilt + dy * 0.01)); }
      else { v.panX += dx; v.panY += dy; }
      drag.current.x = e.clientX; drag.current.y = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag.current.moved;
      drag.current.on = false;
      if (wasDrag) return;
      const rect = cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      let best: Screen | null = null, bestD = 16;
      for (const s of screens.current) {
        const dd = Math.hypot(s.x - px, s.y - py);
        if (dd < Math.max(s.r + 4, bestD)) { bestD = dd; best = s; }
      }
      if (best) { setInput(best.word); fetchNode(best.word); }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      v.zoom = Math.max(0.12, Math.min(60, v.zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
    };
    const onDbl = () => { view.current = { angle: 0.6, tilt: 0.42, zoom: 1, panX: 0, panY: 0 }; };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDbl);

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('dblclick', onDbl);
    };
  // `mode` is a dependency because switching to 'network' unmounts this
  // canvas and switching back mounts a NEW element. Without it the effect
  // keeps a reference to the removed canvas and the 2d/3d view comes back
  // blank.
  }, [fetchNode, mode]);

  useEffect(() => { fetchNode('APP:Pokemon GO'); }, [fetchNode]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 500, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 500, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={`fixed top-0 right-0 h-full z-[500] flex flex-col glass-panel ${expanded ? 'w-screen' : 'w-[520px] max-w-[92vw]'}`}
        style={{ borderLeft: '1px solid var(--border-primary)', borderRight: 'none', borderTop: 'none', borderBottom: 'none', borderRadius: 0 }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div>
            <div className="hud-text text-[13px] text-[var(--text-primary)]">REASONING PANEL</div>
            <div className="text-[9px] text-[var(--text-muted)] font-mono tracking-wide">
              DINGIR graph-embedding inspector {ok && `· ${data!.vocab_size} nodes · dim ${data!.dims} · PCA`}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* The 3D embedding cloud is unreadable at 520px -- labels overlap into
                a smear. Full width is the difference between a decoration and a tool. */}
            <button onClick={() => setExpanded(e => !e)}
              title={expanded ? 'Collapse to side panel' : 'Expand to full screen'}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              {expanded
                ? <Minimize2 className="w-4 h-4 text-[var(--text-muted)]" />
                : <Maximize2 className="w-4 h-4 text-[var(--text-muted)]" />}
            </button>
            <button onClick={onClose} title="Close" className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
              <X className="w-4 h-4 text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] shrink-0">
          <div className="flex rounded-md border border-white/10 bg-black/30 p-0.5">
            {(['2d', '3d', 'network'] as const).map(m => (
              <button key={m} type="button" onClick={() => setMode(m)}
                title={m === 'network' ? 'The entire graph, not one node\'s neighbourhood' : undefined}
                className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider transition ${mode === m ? 'bg-[var(--cyan-primary)]/20 text-[var(--cyan-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                {m === 'network' ? 'ALL' : m}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-0">
            <input value={input} onChange={e => setInput(e.target.value)} autoComplete="off"
              placeholder={nodeTotal ? `Search ${nodeTotal} nodes...` : 'Search a node...'}
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--cyan-primary)]/60" />
            {suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-white/10 bg-[#0a0a0a] shadow-xl">
                {suggestions.map(s => (
                  <button key={s.id} type="button" onClick={() => { setInput(s.id); fetchNode(s.id); }}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[10px] font-mono text-[var(--text-primary)] hover:bg-white/5 transition-colors">
                    <span className="truncate">{s.id}</span>
                    <span className="shrink-0 text-[8px] uppercase tracking-wider text-[var(--text-muted)]">{s.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="submit" className="w-7 h-7 rounded-md border border-white/10 bg-black/30 flex items-center justify-center hover:border-[var(--cyan-primary)]/60 shrink-0">
            <Search className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          </button>
        </form>

        <div className="relative flex-1 min-h-0 p-3">
          {mode === 'network' ? (
            graph ? (
              <NetworkView graph={graph} visibleProvenance={visibleProv}
                onPick={n => { setMode('3d'); setInput(n.id); fetchNode(n.id); }} />
            ) : (
              <div className="relative h-full w-full rounded-lg border border-white/[0.08] bg-black flex items-center justify-center px-6 text-center">
                {graphError
                  ? <span className="text-[11px] text-[var(--alert-red)]">{graphError}</span>
                  : <span className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading the whole network... the first request trains the model, which takes a moment.
                    </span>}
              </div>
            )
          ) : (
          <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg border border-white/[0.08] bg-black">
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing touch-none" />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-[var(--text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading graph embeddings...
              </div>
            )}
            {error && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[11px] text-[var(--alert-red)]">{error}</div>}
            {ok && (
              <div className="pointer-events-none absolute bottom-2 left-3 text-[9px] text-[var(--text-muted)]/70 font-mono">
                drag = rotate · scroll = zoom · double-click = reset · click a node to jump
              </div>
            )}
          </div>
          )}
        </div>

        <div className="shrink-0 max-h-[35%] min-h-0 overflow-y-auto border-t border-white/[0.06] px-3 py-2">
          {mode === 'network' && graph ? (
            /* Provenance is a legend AND a filter, not decoration. An edge
               computed from a hostname must be distinguishable from one that
               came out of an audit finding, or the picture invites being read
               as if all of it were observed. */
            <div className="px-1">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                {graph.node_count} nodes · {graph.edge_count} edges · position = PCA of the learned embedding
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Object.entries(graph.provenance).map(([p, count]) => (
                  <button key={p} onClick={() => toggleProv(p)}
                    title={p === 'OBSERVED' ? 'Came out of an audit finding' : 'Computed from a real field, not observed'}
                    className={`rounded px-2 py-1 text-[9px] font-mono tracking-wide border transition ${
                      visibleProv.has(p)
                        ? 'border-[var(--cyan-primary)]/50 text-[var(--cyan-primary)] bg-[var(--cyan-primary)]/10'
                        : 'border-white/10 text-[var(--text-muted)] line-through'}`}>
                    {p} {count}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {graph.types.map(t => (
                  <span key={t} className="flex items-center gap-1.5 text-[9px] font-mono text-[var(--text-muted)]">
                    <span className="h-2 w-2 rounded-full" style={{ background: TYPE_SWATCH[t] || '#80808c' }} />
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : (<>
          <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1.5 px-1">
            {ok ? `${data!.neighbors.length} nearest neighbours` : 'Neighbours'}
          </div>
          {ok && data!.neighbors.map((n, i) => (
            <button key={i} onClick={() => { setInput(n.word); fetchNode(n.word); }}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-[10px] font-mono text-[var(--text-primary)] hover:bg-white/5 transition-colors">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: simColor((n.sim - minS) / spanS) }} />
                <span className="truncate">{n.word}</span>
              </span>
              <span className="ml-2 shrink-0 text-[var(--text-muted)]">{n.sim.toFixed(3)}</span>
            </button>
          ))}
          </>)}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
