import { describe, expect, it, vi } from 'vitest';

const leaflet = vi.hoisted(() => ({
  layerGroup: vi.fn((layers) => ({ layers })),
  tileLayer: vi.fn((url, options) => ({ url, options })),
}));

vi.mock('leaflet', () => leaflet);

import { BaseLayerId, DEFAULT_BASE_LAYER_ID } from '../../maps/base-layers';
import { getTileLayers } from './tile-layers';

describe('getTileLayers', () => {
  it('groups global ESRI imagery and reference labels as the default Delta layer', () => {
    const tileLayers = getTileLayers();

    expect(DEFAULT_BASE_LAYER_ID).toBe(BaseLayerId.Delta);
    expect(leaflet.tileLayer).toHaveBeenNthCalledWith(
      3,
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      expect.objectContaining({ maxZoom: 17, zIndex: 0 }),
    );
    expect(leaflet.tileLayer).toHaveBeenNthCalledWith(
      4,
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      expect.objectContaining({ maxZoom: 17, zIndex: 1 }),
    );
    expect(leaflet.layerGroup).toHaveBeenCalledWith([
      expect.objectContaining({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      }),
      expect.objectContaining({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      }),
    ]);
    expect(tileLayers[BaseLayerId.Delta]).toBe(leaflet.layerGroup.mock.results[0].value);
  });
});
