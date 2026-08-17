import { describe, it, expect } from 'vitest';
import { serializeLayers, applyLayers, applyStoredLayers, pickSavedLayers } from './layerState';

const DEFAULTS = { flights: false, fires: false, cctv: false, maritime: true };
// buoys mirrors the real page.tsx shape: a layer introduced at version 2
// whose own default is true -- the exact case applyStoredLayers exists for.
const DEFAULTS_WITH_BUOYS = { ...DEFAULTS, buoys: true };

describe('serializeLayers', () => {
  it('lists only the enabled layers', () => {
    expect(serializeLayers({ ...DEFAULTS, flights: true, fires: true, maritime: false }))
      .toBe('flights,fires');
  });

  it('produces an empty string when everything is off', () => {
    expect(serializeLayers({ a: false, b: false })).toBe('');
  });
});

describe('applyLayers', () => {
  it('turns on exactly the saved layers and off everything else', () => {
    expect(applyLayers(DEFAULTS, 'flights,cctv')).toEqual({
      flights: true, fires: false, cctv: true, maritime: false,
    });
  });

  it('ignores keys the current build does not know', () => {
    // A stale URL or an old localStorage entry must not inject a layer.
    expect(applyLayers(DEFAULTS, 'flights,layer_from_2024')).toEqual({
      flights: true, fires: false, cctv: false, maritime: false,
    });
  });

  it('treats an empty string as all-off', () => {
    expect(applyLayers(DEFAULTS, '')).toEqual({
      flights: false, fires: false, cctv: false, maritime: false,
    });
  });

  it('tolerates stray whitespace and doubled commas', () => {
    expect(applyLayers(DEFAULTS, ' flights , , cctv ')).toEqual({
      flights: true, fires: false, cctv: true, maritime: false,
    });
  });
});

describe('applyStoredLayers', () => {
  it('behaves exactly like applyLayers when the save already knows every key', () => {
    // versionAtSave === CURRENT_LAYERS_VERSION: no migration needed.
    expect(applyStoredLayers(DEFAULTS_WITH_BUOYS, 'flights,cctv', 2)).toEqual({
      flights: true, fires: false, cctv: true, maritime: false, buoys: false,
    });
  });

  it('turns on a new default-ON layer that predates the saved version, instead of forcing it off', () => {
    // The exact bug this exists for: a save from before buoys shipped
    // (version 1) is silent on buoys, which must not read as "user disabled
    // it" -- it means the layer did not exist yet.
    expect(applyStoredLayers(DEFAULTS_WITH_BUOYS, 'flights,cctv', 1)).toEqual({
      flights: true, fires: false, cctv: true, maritime: false, buoys: true,
    });
  });

  it('still respects an explicit user override of a new default-ON layer', () => {
    // The user DID toggle buoys off after upgrading -- their save now
    // includes it explicitly, so silence no longer applies.
    expect(applyStoredLayers(DEFAULTS_WITH_BUOYS, 'flights', 2)).toEqual({
      flights: true, fires: false, cctv: false, maritime: false, buoys: false,
    });
  });

  it('treats a save with no version at all (versionAtSave: null) as version 1', () => {
    expect(applyStoredLayers(DEFAULTS_WITH_BUOYS, 'flights', null)).toEqual({
      flights: true, fires: false, cctv: false, maritime: false, buoys: true,
    });
  });

  it('does not resurrect a default-OFF layer just because it is new', () => {
    // fires defaults to false and was never given a LAYER_INTRODUCED_AT
    // entry -- its absence from an old save stays unambiguous either way.
    expect(applyStoredLayers(DEFAULTS_WITH_BUOYS, '', 1)).toEqual({
      flights: false, fires: false, cctv: false, maritime: false, buoys: true,
    });
  });
});

describe('pickSavedLayers', () => {
  it('prefers the URL, so a shared link wins over local state', () => {
    expect(pickSavedLayers('flights', 'cctv')).toBe('flights');
  });

  it('honours an explicitly empty URL param as "all off"', () => {
    expect(pickSavedLayers('', 'cctv')).toBe('');
  });

  it('falls back to storage when the URL says nothing', () => {
    expect(pickSavedLayers(null, 'cctv')).toBe('cctv');
  });

  it('returns null when neither has anything, keeping the defaults', () => {
    expect(pickSavedLayers(null, null)).toBeNull();
    expect(pickSavedLayers(null, '')).toBeNull();
  });
});
