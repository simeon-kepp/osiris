'use client';

import { memo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plane, Satellite, Sun, AlertTriangle, Camera,
  CloudLightning, Ship, Network, Database, Ghost,
  Flame, Tv, Radio, Mountain, Anchor, TrainFront,
  Cable, ShieldAlert, Car,
} from 'lucide-react';
import { REGIONS, type RegionId } from '@/lib/regions';

interface LayerPanelProps {
  data: any;
  activeLayers: any;
  setActiveLayers: React.Dispatch<React.SetStateAction<any>>;
  isMobile?: boolean;
  theme?: 'core' | 'ghost';
  setTheme?: (theme: 'core' | 'ghost') => void;
  /** Server-side capabilities, e.g. { cloudflare: true }. Layers declaring a
   *  `requires` key stay hidden until the matching capability is present. */
  capabilities?: Record<string, boolean>;
  /** Imported ArcGIS layers. They used to be switchable only from inside the
   *  ArcGIS import panel, which meant the place you turn a layer on depended on
   *  where the layer came from -- pipelines in one panel, everything else in
   *  this one. A layer is a layer. */
  arcgisLayers?: Array<{ id: string; title: string; color: string; visible: boolean }>;
  onToggleArcgis?: (id: string) => void;
  onRemoveArcgis?: (id: string) => void;
  /** Per-layer region scope. Rendering the whole world at once is what makes
   *  the map stutter and what trips the label detail cap, so each layer can be
   *  narrowed independently. Absent key means 'global'. */
  regionScope?: Record<string, RegionId>;
  onRegionScope?: (layerKey: string, region: RegionId) => void;
}

interface LayerDef {
  key: string;
  label: string;
  dataKey: string;
  /** Reads a bucket out of data.category_counts instead of a top-level array. */
  catKey?: string;
  /** Capability that must be configured server-side for this layer to appear. */
  requires?: string;
}

interface LayerGroupDef {
  label: string;
  fullLabel: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  layers: LayerDef[];
}

const LAYER_GROUPS: LayerGroupDef[] = [
  {
    // Was "SDK" -- meant nothing to anyone reading it cold, and the single
    // layer underneath it is submarine cable ROUTES, not "SDK" of any kind.
    // Named for what it actually shows.
    label: 'CABLES',
    fullLabel: 'SUBMARINE CABLES',
    icon: Cable,
    layers: [
      { key: 'sdk_sea', label: 'Cable Routes', dataKey: 'sdk_entities' },
    ],
  },
  {
    label: 'AVIATION',
    fullLabel: 'AVIATION',
    icon: Plane,
    layers: [
      { key: 'flights', label: 'Commercial', dataKey: 'commercial_flights' },
      { key: 'private', label: 'Private', dataKey: 'private_flights' },
      { key: 'jets', label: 'Private Jets', dataKey: 'private_jets' },
      { key: 'military', label: 'Military', dataKey: 'military_flights' },
    ],
  },
  {
    label: 'MARITIME',
    fullLabel: 'MARITIME',
    icon: Ship,
    layers: [
      { key: 'maritime', label: 'Maritime / Naval', dataKey: 'maritime_ships,maritime_ports,maritime_chokepoints' },
    ],
  },
  {
    label: 'ROAD',
    fullLabel: 'ROAD TRAFFIC',
    icon: Car,
    layers: [
      { key: 'traffic', label: 'Incidents & Closures', dataKey: 'traffic_incidents' },
    ],
  },
  {
    label: 'SPACE',
    fullLabel: 'SPACE TRACKING',
    icon: Satellite,
    layers: [
      { key: 'satellites', label: 'All Satellites', dataKey: 'satellites' },
      { key: 'sat_comms', label: 'Starlink / Comms', dataKey: 'satellites', catKey: 'comms' },
      { key: 'sat_military', label: 'Military / Intel', dataKey: 'satellites', catKey: 'military' },
      { key: 'sat_navigation', label: 'GPS / Navigation', dataKey: 'satellites', catKey: 'navigation' },
      { key: 'sat_earth', label: 'Earth Observation', dataKey: 'satellites', catKey: 'earth_obs' },
      { key: 'sat_science', label: 'Stations / Telescopes', dataKey: 'satellites', catKey: 'science' },
    ],
  },
  {
    label: 'SURVEIL',
    fullLabel: 'SURVEILLANCE',
    icon: Camera,
    layers: [
      { key: 'cctv', label: 'CCTV Cameras', dataKey: 'cameras' },
      { key: 'live_news', label: 'Live News Feeds', dataKey: 'live_feeds' },
      { key: 'news_intel', label: 'SIGINT News', dataKey: 'sigint_news' },
    ],
  },
  {
    label: 'HAZARD',
    fullLabel: 'NATURAL HAZARDS',
    icon: CloudLightning,
    layers: [
      { key: 'earthquakes', label: 'Earthquakes', dataKey: 'earthquakes' },
      { key: 'buoys', label: 'Ocean Buoys', dataKey: 'buoys' },
      { key: 'fires', label: 'Active Fires', dataKey: 'fires' },
      { key: 'weather', label: 'Severe Weather', dataKey: 'weather_events' },
      // No dataKey: this is an animated particle overlay, not a discrete
      // feature list, so there is no "N features" count to show.
      { key: 'wind', label: 'Wind Streams', dataKey: '' },
    ],
  },
  {
    // Was three groups (THREAT / NETWORK / NETINTEL) with no clear line
    // between them -- Global Incidents and GDELT Events are both GDELT-
    // sourced world-event data (different endpoints, same domain to a
    // reader), split across two groups for no reason a user could see.
    // This is the physical/world-event half; CYBER below is the other.
    label: 'THREAT',
    fullLabel: 'THREATS & INCIDENTS',
    icon: AlertTriangle,
    layers: [
      { key: 'infrastructure', label: 'Nuclear Facilities', dataKey: 'infrastructure' },
      { key: 'global_incidents', label: 'Global Incidents', dataKey: 'gdelt' },
      { key: 'gdelt_events', label: 'GDELT Events', dataKey: 'gdelt_events' },
      { key: 'gps_jamming', label: 'GPS Jamming', dataKey: 'gps_jamming' },
    ],
  },
  {
    // The other half of the old THREAT/NETWORK/NETINTEL split: everything
    // here is a network/cyber signal, not a physical-world one. ShieldAlert
    // instead of reusing Network's icon, which CABLES also used to share.
    label: 'CYBER',
    fullLabel: 'CYBER THREATS',
    icon: ShieldAlert,
    layers: [
      { key: 'malware', label: 'Live Malware', dataKey: 'malware_threats' },
      { key: 'cyber_attacks', label: 'Live Attacks', dataKey: 'cyber_attacks' },
      { key: 'cf_outages', label: 'Internet Outages', dataKey: 'cf_outages', requires: 'cloudflare' },
      { key: 'cf_attacks', label: 'Attack Origins', dataKey: 'cf_attack_origins', requires: 'cloudflare' },
    ],
  },
  {
    label: 'DISPLAY',
    fullLabel: 'DISPLAY',
    icon: Sun,
    layers: [
      { key: 'day_night', label: 'Day / Night Cycle', dataKey: '' },
      { key: 'terrain_3d', label: '3D Terrain & Buildings', dataKey: '' },
    ],
  },
];

/* ── Minimal Toggle Switch ── */
function ToggleSwitch({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative flex-shrink-0 cursor-pointer"
      style={{ width: 28, height: 14 }}
    >
      <div
        className="absolute inset-0 rounded-full transition-all duration-300"
        style={{
          background: active ? 'rgba(255,255,255,0.2)' : 'transparent',
          border: active ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(255,255,255,0.12)',
          boxShadow: active ? '0 0 8px rgba(255,255,255,0.1)' : 'none',
        }}
      />
      <motion.div
        className="absolute top-[2px] rounded-full"
        style={{
          width: 10,
          height: 10,
          background: active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
          boxShadow: active ? '0 0 6px rgba(255,255,255,0.4)' : 'none',
        }}
        animate={{ left: active ? 16 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  );
}

function LayerPanel({ data, activeLayers, setActiveLayers, isMobile, theme = 'core', setTheme, capabilities = {}, arcgisLayers, onToggleArcgis, onRemoveArcgis, regionScope, onRegionScope }: LayerPanelProps) {
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  const toggle = (key: string) => setActiveLayers((prev: any) => ({ ...prev, [key]: !prev[key] }));

  /* Drop layers whose backing capability is not configured, then drop any group
     left with nothing to show. */
  const visibleGroups = LAYER_GROUPS.map(g => ({
    ...g,
    layers: g.layers.filter(l => !l.requires || capabilities[l.requires]),
  })).filter(g => g.layers.length > 0);

  const getCount = (dk: string, catKey?: string): number | null => {
    if (!dk) return null;
    if (catKey && data.category_counts) {
      return data.category_counts[catKey] || 0;
    }
    let total = 0;
    let found = false;
    for (const k of dk.split(',')) {
      if (data[k] && Array.isArray(data[k])) {
        total += data[k].length;
        found = true;
      }
    }
    return found ? total : null;
  };

  /* Imported ArcGIS layers, shown alongside the built-in ones. */
  const arcgisBlock = arcgisLayers && arcgisLayers.length > 0 ? (
    <div className="flex flex-col gap-2">
      <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-white/30 border-b border-white/[0.06] pb-1.5">
        IMPORTED · ARCGIS
      </div>
      <div className="flex flex-col gap-1">
        {arcgisLayers.map((l) => (
          <div key={l.id} className="flex items-center gap-3 px-1 py-1.5 group/arc">
            <ToggleSwitch active={l.visible} onClick={() => onToggleArcgis?.(l.id)} />
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
            <span className={`text-[10px] font-mono uppercase tracking-wider flex-1 truncate transition-colors ${l.visible ? 'text-white/80' : 'text-white/40'}`}
                  title={l.title}>
              {l.title}
            </span>
            {onRemoveArcgis && (
              <button onClick={() => onRemoveArcgis(l.id)} title="Remove this layer"
                className="text-[9px] font-mono text-white/20 hover:text-[var(--alert-red)] opacity-0 group-hover/arc:opacity-100 transition">
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  ) : null;

  /* ── MOBILE ── */
  if (isMobile) {
    return (
      <div className="flex flex-col gap-5 py-2">
        {visibleGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-2">
            <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-white/30 border-b border-white/[0.06] pb-1.5">
              {group.fullLabel}
            </div>
            <div className="flex flex-col gap-1">
              {group.layers.map((layer) => {
                const isLayerActive = activeLayers[layer.key];
                const count = getCount(layer.dataKey, layer.catKey);
                return (
                  <div key={layer.key} className="flex items-center gap-3 px-1 py-1.5">
                    <ToggleSwitch
                      active={!!isLayerActive}
                      onClick={() => toggle(layer.key)}
                    />
                    <span className={`text-[10px] font-mono uppercase tracking-wider flex-1 transition-colors ${isLayerActive ? 'text-white/80' : 'text-white/40'}`}>
                      {layer.label}
                    </span>
                    {count !== null && (
                      <span className="text-[8px] font-mono tabular-nums text-white/20">
                        {count.toLocaleString()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {arcgisBlock}

        {/* MOBILE GHOST TOGGLE */}
        {setTheme && (
          <div className="flex items-center justify-between mt-2 pt-3 border-t border-white/[0.06] px-1">
            <span className="text-[9px] font-mono tracking-[0.2em] text-white/25 uppercase">Ghost Protocol</span>
            <button
              onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
              className="w-8 h-8 rounded-full flex items-center justify-center transition-all"
              style={{
                background: theme === 'ghost' ? 'rgba(179, 136, 255, 0.15)' : 'transparent',
                boxShadow: theme === 'ghost' ? '0 0 12px rgba(179, 136, 255, 0.3)' : 'none',
              }}
            >
              <Ghost className="w-4 h-4" style={{ color: theme === 'ghost' ? '#B388FF' : 'rgba(255,255,255,0.25)' }} />
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ── DESKTOP ── */
  return (
    <motion.div
      initial={{ x: -60, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', damping: 30, stiffness: 200, delay: 2.8 }}
      className="absolute top-0 left-0 h-full w-[48px] flex flex-col items-center pt-24 pb-6 z-50 pointer-events-auto"
      style={{
        background: 'rgba(0,0,0,0.15)',
        backdropFilter: 'blur(24px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.2)',
      }}
    >
      <div className="flex-1 flex flex-col items-center gap-1">
        {(() => {
          const rail = arcgisLayers?.find(l => l.id === 'gogf-railways-14');
          if (!rail) return null;
          return (
            <button
              key="railways"
              onClick={() => onToggleArcgis?.(rail.id)}
              title={rail.visible ? 'Hide Railways' : 'Show Railways'}
              className="w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-300 cursor-pointer"
              style={{ background: 'transparent' }}>
              <TrainFront
                className="transition-all duration-300"
                style={{
                  width: 16, height: 16,
                  color: rail.visible ? rail.color : 'rgba(255,255,255,0.2)',
                  filter: rail.visible ? `drop-shadow(0 0 4px ${rail.color}80)` : 'none',
                }}
              />
            </button>
          );
        })()}
        {visibleGroups.map((group) => {
          const groupActive = group.layers.some(l => activeLayers[l.key]);
          const isHovered = hoveredGroup === group.label;
          const Icon = group.icon;

          return (
            <div
              key={group.label}
              className="relative flex items-center justify-center"
              onMouseEnter={() => setHoveredGroup(group.label)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              {/* Icon Button */}
              <div
                className="w-10 h-10 flex items-center justify-center cursor-pointer rounded-lg transition-all duration-300"
                style={{
                  background: isHovered ? 'rgba(255,255,255,0.05)' : 'transparent',
                }}
              >
                <Icon
                  className="transition-all duration-300"
                  style={{
                    width: 16,
                    height: 16,
                    color: groupActive
                      ? 'rgba(255,255,255,0.7)'
                      : isHovered
                        ? 'rgba(255,255,255,0.4)'
                        : 'rgba(255,255,255,0.2)',
                    filter: groupActive ? 'drop-shadow(0 0 4px rgba(255,255,255,0.3))' : 'none',
                  }}
                />
              </div>

              {/* Flyout (LEFT side) */}
              <AnimatePresence>
                {isHovered && (
                  <motion.div
                    initial={{ opacity: 0, x: -8, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, x: -4, filter: 'blur(2px)' }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="absolute left-[52px] top-1/2 -translate-y-1/2 min-w-[220px] rounded-xl p-3 z-[100] pointer-events-auto"
                    style={{
                      background: 'rgba(0,0,0,0.6)',
                      backdropFilter: 'blur(40px) saturate(1.5)',
                      WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    }}
                  >
                    <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-white/30 mb-2.5 pb-1.5 border-b border-white/[0.04]">
                      {group.fullLabel}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {group.layers.map((layer) => {
                        const isLayerActive = activeLayers[layer.key];
                        const count = getCount(layer.dataKey, layer.catKey);

                        return (
                          <div
                            key={layer.key}
                            className="flex items-center gap-3 px-1 py-[5px] rounded-md hover:bg-white/[0.03] transition-colors cursor-pointer"
                            onClick={() => toggle(layer.key)}
                          >
                            <ToggleSwitch active={!!isLayerActive} onClick={() => {}} />
                            <span className={`text-[10px] font-mono uppercase tracking-wider flex-1 transition-colors duration-200 ${isLayerActive ? 'text-white/70' : 'text-white/35'}`}>
                              {layer.label}
                            </span>
                            {count !== null && (
                              <span className="text-[9px] font-mono tabular-nums text-white/20">
                                {count.toLocaleString()}
                              </span>
                            )}
                            {/* Region scope. stopPropagation on both the click
                                and the change: the whole row is a toggle, so
                                without it choosing a region would also switch
                                the layer off, which is the opposite of what
                                someone narrowing a busy layer wants. Only
                                shown while the layer is on, because scoping
                                something invisible is noise. */}
                            {isLayerActive && onRegionScope && (
                              <select
                                value={regionScope?.[layer.key] ?? 'global'}
                                onClick={e => e.stopPropagation()}
                                onChange={e => {
                                  e.stopPropagation();
                                  onRegionScope(layer.key, e.target.value as RegionId);
                                }}
                                title="Limit what this layer renders"
                                className="text-[9px] tabular-nums bg-transparent border border-white/10 rounded px-1 py-[1px] text-white/45 hover:text-white/80 hover:border-white/25 cursor-pointer outline-none"
                              >
                                {REGIONS.map(r => (
                                  <option key={r.id} value={r.id} className="bg-black text-white">
                                    {r.label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {/* Imported ArcGIS layers, in the same rail as everything else. They
            used to be switchable only from inside the import panel, so where
            you turned a layer on depended on where the layer came from. */}
        {arcgisLayers && arcgisLayers.length > 0 && (
          <div
            className="relative flex items-center justify-center"
            onMouseEnter={() => setHoveredGroup('__arcgis__')}
            onMouseLeave={() => setHoveredGroup(null)}
          >
            <div className="w-10 h-10 flex items-center justify-center cursor-pointer rounded-lg transition-all duration-300"
                 style={{ background: hoveredGroup === '__arcgis__' ? 'rgba(255,255,255,0.05)' : 'transparent' }}>
              <Database
                className="transition-all duration-300"
                style={{
                  width: 16, height: 16,
                  color: arcgisLayers.some(l => l.visible)
                    ? 'rgba(212,175,55,0.85)'
                    : hoveredGroup === '__arcgis__' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.2)',
                  filter: arcgisLayers.some(l => l.visible)
                    ? 'drop-shadow(0 0 4px rgba(212,175,55,0.35))' : 'none',
                }}
              />
            </div>
            <AnimatePresence>
              {hoveredGroup === '__arcgis__' && (
                <motion.div
                  initial={{ opacity: 0, x: -8, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: -4, filter: 'blur(2px)' }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  className="absolute left-[52px] top-1/2 -translate-y-1/2 min-w-[260px] max-w-[340px] max-h-[70vh] overflow-y-auto styled-scrollbar rounded-xl p-3 z-[100] pointer-events-auto"
                  style={{
                    background: 'rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(40px) saturate(1.5)',
                    WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                  }}
                >
                  <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-white/30 mb-2.5 pb-1.5 border-b border-white/[0.04]">
                    IMPORTED · ARCGIS · {arcgisLayers.length}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {arcgisLayers.map((l) => (
                      <div key={l.id}
                           className="flex items-center gap-2.5 px-1 py-[5px] rounded-md hover:bg-white/[0.03] transition-colors cursor-pointer group/arc"
                           onClick={() => onToggleArcgis?.(l.id)}>
                        <ToggleSwitch active={l.visible} onClick={() => {}} />
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
                        <span className={`text-[10px] font-mono uppercase tracking-wider flex-1 truncate transition-colors ${l.visible ? 'text-white/70' : 'text-white/35'}`}
                              title={l.title}>
                          {l.title}
                        </span>
                        {onRemoveArcgis && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemoveArcgis(l.id); }}
                            title="Remove this layer"
                            className="text-[10px] font-mono text-white/20 hover:text-[var(--alert-red)] opacity-0 group-hover/arc:opacity-100 transition">
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Subtle separator */}
      <div className="w-5 h-px bg-white/[0.06] my-2" />

      {/* Ghost Protocol Toggle */}
      {setTheme && (
        <button
          onClick={() => setTheme(theme === 'core' ? 'ghost' : 'core')}
          className="w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-500 cursor-pointer"
          style={{
            background: theme === 'ghost' ? 'rgba(179, 136, 255, 0.1)' : 'transparent',
          }}
          title="Ghost Protocol"
        >
          <Ghost
            className="transition-all duration-500"
            style={{
              width: 15,
              height: 15,
              color: theme === 'ghost' ? '#B388FF' : 'rgba(255,255,255,0.15)',
              filter: theme === 'ghost' ? 'drop-shadow(0 0 6px rgba(179, 136, 255, 0.5))' : 'none',
            }}
          />
        </button>
      )}
    </motion.div>
  );
}

export default memo(LayerPanel);
