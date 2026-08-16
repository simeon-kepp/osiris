// Which map layers are on, across reloads.
//
// Layers used to live in the URL alone, written with replaceState. That works
// for sharing a view but loses everything the moment the app is opened at a
// bare URL -- which is exactly what the `dingir` launcher does on every start.
// So: URL first (a shared link must win), localStorage as the fallback.

export const LAYER_STORAGE_KEY = 'dingir.activeLayers';

export type LayerFlags = Record<string, boolean>;

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
 * The selection to restore, or null to keep the defaults. URL beats storage;
 * an explicitly empty `?layers=` means "all off" and is honoured, which is why
 * this checks for null rather than falsiness.
 */
export function pickSavedLayers(urlParam: string | null, stored: string | null): string | null {
  if (urlParam !== null) return urlParam;
  if (stored) return stored;
  return null;
}
