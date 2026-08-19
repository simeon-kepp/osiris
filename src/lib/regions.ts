/**
 * Region scoping for map layers.
 *
 * WHY. Several layers load the whole world -- every tracked aircraft, every
 * satellite, every ship -- and rendering all of it at once is what makes the
 * dashboard stutter and what trips the detail cap that hides labels. Scoping
 * is not a filter for convenience; it is the difference between a map that
 * responds and one that does not.
 *
 * WHERE IT IS APPLIED. In `setGeo`, the single point in OsirisMap through
 * which every layer's features reach the map. Filtering there means one
 * implementation covers all thirty-odd sources and none of them can forget it.
 *
 * WHAT IT DOES NOT DO. It filters what is RENDERED, not what is fetched. The
 * network cost is unchanged for global endpoints; only the browser's work
 * drops. The one layer that is genuinely fetch-scoped is road traffic, because
 * TomTom rejects a continental bounding box outright.
 *
 * BOUNDING BOXES ARE COARSE ON PURPOSE. A continent is not a rectangle, so
 * these overlap and they clip. Europe's box includes western Russia and part
 * of North Africa. That is stated rather than fixed: a polygon test per feature
 * per frame would cost more than the rendering it saves, and an operator who
 * needs an exact border uses "current view".
 */

export type RegionId =
  | 'global' | 'view'
  | 'europe' | 'north_america' | 'south_america'
  | 'africa' | 'asia' | 'oceania' | 'middle_east';

export type BBox = { west: number; south: number; east: number; north: number };

export const REGIONS: Array<{ id: RegionId; label: string; bbox: BBox | null }> = [
  { id: 'global', label: 'Global', bbox: null },
  // Resolved against the live map bounds by the caller, so it has no fixed box.
  { id: 'view', label: 'Current view', bbox: null },
  { id: 'europe', label: 'Europe', bbox: { west: -25, south: 34, east: 45, north: 72 } },
  { id: 'north_america', label: 'North America', bbox: { west: -170, south: 12, east: -50, north: 72 } },
  { id: 'south_america', label: 'South America', bbox: { west: -82, south: -56, east: -34, north: 13 } },
  { id: 'africa', label: 'Africa', bbox: { west: -18, south: -35, east: 52, north: 38 } },
  { id: 'asia', label: 'Asia', bbox: { west: 45, south: -11, east: 150, north: 78 } },
  { id: 'middle_east', label: 'Middle East', bbox: { west: 25, south: 12, east: 63, north: 42 } },
  { id: 'oceania', label: 'Oceania', bbox: { west: 110, south: -50, east: 180, north: 0 } },
];

export const REGION_LABEL: Record<RegionId, string> =
  Object.fromEntries(REGIONS.map(r => [r.id, r.label])) as Record<RegionId, string>;

/** Longitude difference normalised to [-180, 180], so a box that crosses the
 *  antimeridian does not silently exclude everything. */
function lonInRange(lon: number, west: number, east: number): boolean {
  if (west <= east) return lon >= west && lon <= east;
  return lon >= west || lon <= east;     // wraps the 180th meridian
}

export function inBBox(lng: number, lat: number, b: BBox): boolean {
  return lat >= b.south && lat <= b.north && lonInRange(lng, b.west, b.east);
}

/**
 * Filter GeoJSON features to a bbox.
 *
 * A feature is kept if ANY of its coordinates falls inside, not only the first.
 * A flight path or a road closure is a LineString spanning hundreds of
 * kilometres; testing only its head would drop a closure whose marker sits
 * just outside the box while the closure itself runs through it.
 */
export function filterFeaturesToBBox<T extends { geometry?: { type?: string; coordinates?: unknown } }>(
  features: T[], bbox: BBox | null,
): T[] {
  if (!bbox) return features;
  return features.filter(f => {
    const c = f.geometry?.coordinates as unknown;
    if (!Array.isArray(c)) return true;   // no geometry to test: keep, do not guess
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      return inBBox(c[0] as number, c[1] as number, bbox);
    }
    // Nested coordinate arrays of any depth. Recursion rather than a shape
    // assumption, because Polygon, MultiLineString and MultiPolygon each nest
    // one level deeper than the last.
    const anyInside = (arr: unknown): boolean => {
      if (!Array.isArray(arr)) return false;
      if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
        return inBBox(arr[0] as number, arr[1] as number, bbox);
      }
      return arr.some(anyInside);
    };
    return anyInside(c);
  });
}

/**
 * Map a map SOURCE id to the layer key its scope setting lives under.
 *
 * Most sources are named after their layer already; this table is only the
 * exceptions. Anything absent falls back to the source name, so a new layer
 * gets scoping for free as long as it follows the convention.
 */
export const SOURCE_TO_LAYER_KEY: Record<string, string> = {
  'private-fl': 'private',
  'maritime-choke': 'maritime',
  'maritime-ships': 'maritime',
  'gdelt-events': 'gdelt',
  'sigint-news': 'news_intel',
  'live-news': 'live_news',
  'gps-jamming': 'gps_jamming',
  'day-night': 'day_night',
  'war-alerts-targets': 'war_alerts',
  'war-alerts-lines': 'war_alerts',
  'conflict-zones': 'conflicts',
  'cf-outages': 'cloudflare',
  'cf-attacks': 'cloudflare',
  'ip-sweep-devices': 'ip_sweep',
  'ip-sweep-pulse': 'ip_sweep',
  'ip-sweep-connections': 'ip_sweep',
  'cyber-arcs': 'cyber',
  'cyber-heads': 'cyber',
  'cyber-impacts': 'cyber',
  'malware-nodes': 'malware',
  'network-mesh': 'network',
  'sdk-entities': 'sdk',
  'sdk-links': 'sdk',
  'scan-targets': 'scanner',
};
