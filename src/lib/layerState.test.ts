import { describe, it, expect } from 'vitest';
import { serializeLayers, applyLayers, pickSavedLayers } from './layerState';

const DEFAULTS = { flights: false, fires: false, cctv: false, maritime: true };

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
