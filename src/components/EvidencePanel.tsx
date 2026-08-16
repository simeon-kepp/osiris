'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText, ExternalLink, Loader2, Hash } from 'lucide-react';
import { useLocale } from '@/lib/LocaleProvider';

// Where a claim came from.
//
// The reasoning panel could show a node's nearest neighbours in the learned
// space, which is what the MODEL thinks. Nothing could show what the CORPUS
// records: which edges exist, whether each was observed or computed, by what
// rule, and out of which file with which hash. A picture you cannot trace back
// to a source is a black box with a nicer palette.
//
// So the ordering here is deliberate and is the opposite of what looks
// impressive: sources first, then observed edges, then derived ones with their
// rule spelled out. Predictions do not appear at all -- they are not evidence,
// they live in the feed, and mixing them in here would undo the whole point.

type Edge = {
  relation: string;
  other: string;
  direction: 'in' | 'out';
  provenance: string;
  rule?: string | null;
  source?: string | null;
  url?: string | null;
  sha256?: string | null;
  licence?: string | null;
};

type Evidence = {
  node: string;
  type?: string;
  name?: string;
  attributes: Record<string, unknown>;
  degree: number;
  provenance: Record<string, number>;
  edges_out: Edge[];
  edges_in: Edge[];
  truncated: boolean;
  sources: { source: string; url: string; sha256?: string; licence?: string }[];
  error?: string;
};

const PROV_STYLE: Record<string, { colour: string; note: string }> = {
  OBSERVED: { colour: '#00f5c4', note: 'a source states this' },
  DERIVED: { colour: '#ffd166', note: 'computed from a stated field' },
  PREDICTED: { colour: '#b388ff', note: 'a guess with no evidence' },
};

export default function EvidencePanel({ node, onClose, onOpenNode }: {
  node: string;
  onClose: () => void;
  onOpenNode?: (id: string) => void;
}) {
  const { t: tr } = useLocale();
  const [data, setData] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    fetch(`/api/reasoning/evidence?node=${encodeURIComponent(node)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { if (!cancelled) (d.error ? setError(d.error) : setData(d)); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [node]);

  const edges = data ? [...data.edges_out, ...data.edges_in] : [];
  const observed = edges.filter(e => e.provenance === 'OBSERVED');
  const derived = edges.filter(e => e.provenance === 'DERIVED');

  const row = (e: Edge, i: number) => (
    <button key={`${e.relation}-${e.other}-${i}`}
      onClick={() => onOpenNode?.(e.other)}
      className="w-full text-left px-2 py-1.5 rounded hover:bg-white/[0.04] transition-colors group">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <span className="text-[var(--text-muted)] shrink-0">
          {e.direction === 'out' ? '→' : '←'}
        </span>
        <span className="text-[var(--cyan-primary)] shrink-0">{e.relation}</span>
        <span className="text-[var(--text-primary)] truncate group-hover:text-[var(--cyan-primary)]">
          {e.other}
        </span>
      </div>
      {e.rule && (
        // The rule is what makes a DERIVED edge checkable. Without it a reader
        // knows a computation happened but not which one, which is not much
        // better than not being told at all.
        <div className="mt-0.5 ml-5 text-[10px] text-[#ffd166]/80">rule: {e.rule}</div>
      )}
    </button>
  );

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: 420, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 420, opacity: 0 }}
        transition={{ type: 'spring', damping: 26, stiffness: 210 }}
        className="fixed top-0 right-0 h-full z-[520] w-[440px] max-w-[92vw] flex flex-col glass-panel"
        style={{ borderLeft: '1px solid var(--border-primary)', borderRadius: 0 }}
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div className="min-w-0">
            <div className="hud-text text-[13px] text-[var(--text-primary)] flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-[var(--cyan-primary)]" />
              {tr('evidence.title')}
            </div>
            <div className="text-[10px] font-mono text-[var(--text-muted)] truncate" title={node}>
              {node}
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto styled-scrollbar px-3 py-3 space-y-4">
          {error && <div className="text-[12px] text-[var(--alert-red)]">{error}</div>}
          {!data && !error && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {tr('evidence.reading')}
            </div>
          )}

          {data && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(data.provenance).map(([p, n]) => {
                  const st = PROV_STYLE[p] || { colour: '#8a8aa0', note: '' };
                  return (
                    <span key={p} title={st.note}
                      className="rounded px-2 py-1 text-[9px] font-mono tracking-wide border"
                      style={{ borderColor: `${st.colour}55`, color: st.colour, background: `${st.colour}12` }}>
                      {p} {n}
                    </span>
                  );
                })}
                <span className="rounded px-2 py-1 text-[9px] font-mono text-[var(--text-muted)] border border-white/10">
                  {tr('evidence.degree', String(data.degree))}
                </span>
              </div>

              {/* SOURCES FIRST. The most-linked-to thing in the panel should be
                  the one a person can open and check. */}
              {data.sources.length > 0 && (
                <section>
                  <div className="hud-label mb-1.5" style={{ fontSize: '9px' }}>{tr('evidence.sources')}</div>
                  <div className="space-y-1.5">
                    {data.sources.map(s => (
                      <div key={s.source} className="rounded-lg border border-white/[0.07] p-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono text-[var(--text-primary)] truncate">{s.source}</span>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noopener noreferrer"
                               className="ml-auto shrink-0 text-[var(--cyan-primary)] hover:underline"
                               title={s.url}>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                        {s.licence && (
                          <div className="mt-1 text-[10px] text-[var(--text-muted)]">{s.licence}</div>
                        )}
                        {s.sha256 && (
                          // The hash is the difference between "this came from
                          // NOAA" and "this came from these exact bytes".
                          <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-[var(--text-muted)]" title={s.sha256}>
                            <Hash className="w-3 h-3 shrink-0" />
                            <span className="truncate">{s.sha256.slice(0, 24)}…</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {Object.keys(data.attributes).length > 0 && (
                <section>
                  <div className="hud-label mb-1.5" style={{ fontSize: '9px' }}>{tr('evidence.recorded')}</div>
                  <div className="rounded-lg border border-white/[0.07] divide-y divide-white/[0.05]">
                    {Object.entries(data.attributes).map(([k, v]) => (
                      <div key={k} className="flex items-baseline gap-3 px-2 py-1.5">
                        <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0 w-[110px] truncate">{k}</span>
                        <span className="text-[11px] font-mono text-[var(--text-primary)] break-all">
                          {v === null || v === undefined
                            // A field the source did not state stays visibly
                            // unstated rather than rendering as an empty cell
                            // that reads like a zero.
                            ? <em className="text-[var(--text-muted)]">{tr('evidence.notStated')}</em>
                            : String(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {observed.length > 0 && (
                <section>
                  <div className="hud-label mb-1" style={{ fontSize: '9px', color: PROV_STYLE.OBSERVED.colour }}>
                    {tr('evidence.observed')} · {observed.length}
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] mb-1">{tr('evidence.observedNote')}</p>
                  <div>{observed.map(row)}</div>
                </section>
              )}

              {derived.length > 0 && (
                <section>
                  <div className="hud-label mb-1" style={{ fontSize: '9px', color: PROV_STYLE.DERIVED.colour }}>
                    {tr('evidence.derived')} · {derived.length}
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)] mb-1">
                    {tr('evidence.derivedNote')}
                  </p>
                  <div>{derived.map(row)}</div>
                </section>
              )}

              {data.truncated && (
                <p className="text-[10px] text-[var(--text-muted)]">
                  {tr('evidence.truncated')}
                </p>
              )}
              {edges.length === 0 && (
                <p className="text-[12px] text-[var(--text-muted)]">
                  {tr('evidence.noEdges')}
                </p>
              )}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
