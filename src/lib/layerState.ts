// Which map layers are on, across reloads.
//
// Layers used to live in the URL alone, written with replaceState. That works
// for sharing a view but loses everything the moment the app is opened at a
// bare URL -- which is exactly what the `dingir` launcher does on every start.
// So: URL first (a shared link must win), localStorage as the fallback.

export const LAYER_STORAGE_KEY = 'dingir.activeLayers';
export const LAYER_VERSION_STORAGE_KEY = 'dingir.layersVersion';

export type LayerFlags = Record<string, boolean>;

// Bump CURRENT_LAYERS_VERSION and add an entry here whenever a layer that
// defaults to ON ships. Anything not listed is assumed to predate versioning
// (version 1) -- only a flip-to-true-by-default needs tracking, since a
// default-OFF layer missing from an old save is unambiguous either way (off
// is the safe reading whether the layer is new or the user left it alone).
export const LAYER_INTRODUCED_AT: Record<string, number> = {
  buoys: 2,
};
export const CURRENT_LAYERS_VERSION = 2;

/** The comma-separated form used in both the URL and localStorage. */
export function serializeLayers(layers: LayerFlags): string {
  return Object.entries(layers)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(',');
}

/**
 * Applies a saved selection onto the default shape. Keys absent from the
 * defaults are ignored -- a stale key from an older build (or a hand-edited
 * URL) must not add a layer the app no longer knows how to render.
 */
export function applyLayers(defaults: LayerFlags, saved: string): LayerFlags {
  const on = new Set(saved.split(',').map(s => s.trim()).filter(Boolean));
  const next: LayerFlags = {};
  for (const key of Object.keys(defaults)) next[key] = on.has(key);
  return next;
}

/**
 * Same restoration as applyLayers, but for localStorage specifically -- never
 * for an explicit `?layers=` URL, where silence on a key stays a decision to
 * honour (a shared link must reproduce exactly, forever, on principle).
 * localStorage is different: it is this browser's ongoing preference, not a
 * frozen snapshot someone meant to share, so a key missing because it did not
 * exist yet the last time this browser saved should not read the same as a
 * key the person actually turned off.
 *
 * versionAtSave is the CURRENT_LAYERS_VERSION this save was written under
 * (null for any save from before this versioning existed, which is treated
 * as version 1). A default-ON layer introduced after that version gets its
 * own default instead of being forced off by its mere absence from the old
 * save -- everything else behaves exactly like applyLayers.
 */
export function applyStoredLayers(defaults: LayerFlags, saved: string, versionAtSave: number | null): LayerFlags {
  const savedVersion = versionAtSave ?? 1;
  const on = new Set(saved.split(',').map(s => s.trim()).filter(Boolean));
  const next: LayerFlags = {};
  for (const key of Object.keys(defaults)) {
    const introducedAt = LAYER_INTRODUCED_AT[key] ?? 1;
    next[key] = defaults[key] && introducedAt > savedVersion ? true : on.has(key);
  }
  return next;
}

/**
 * The selection to restore, or null to keep the defaults. URL beats storage;
 * an explicitly empty `?layers=` means "all off" and is honoured, which is why
 * this checks for null rather than falsiness.
 */
export function pickSavedLayers(urlParam: string | null, stored: string | null): string | null {
  if (urlParam !== null) return urlParam;
  if (stored) return stored;
  return null;
}
