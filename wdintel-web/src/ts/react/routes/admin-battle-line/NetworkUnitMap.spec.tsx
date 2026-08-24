/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkUnitMap } from './NetworkUnitMap';

const leaflet = vi.hoisted(() => {
  const addTo = vi.fn().mockReturnThis();
  const bindTooltip = vi.fn().mockReturnThis();
  const circleMarker = vi.fn(() => ({ addTo, bindTooltip }));
  const fitBounds = vi.fn();
  const setView = vi.fn();
  const remove = vi.fn();
  const invalidateSize = vi.fn();
  const map = vi.fn(() => ({ fitBounds, invalidateSize, remove, setView }));
  const layer = { getLayers: vi.fn(() => []), addTo: vi.fn().mockReturnThis() };
  return {
    addTo,
    bindTooltip,
    circleMarker,
    fitBounds,
    invalidateSize,
    layer,
    map,
    remove,
    setView,
  };
});

vi.mock('../../../maps/leaflet-markercluster', () => ({
  L: {
    circleMarker: leaflet.circleMarker,
    featureGroup: () => ({ getBounds: () => ({ isValid: () => false }) }),
    layerGroup: () => leaflet.layer,
    map: leaflet.map,
  },
}));
vi.mock('../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: () => ({ googleHybrid: { addTo: vi.fn() } }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('NetworkUnitMap', () => {
  it('renders settlements in blue and pelengs in red', async () => {
    await act(async () =>
      root.render(
        <NetworkUnitMap
          item={{
            unitId: 17,
            unitName: '17 підрозділ',
            settlementPoints: [{ lat: 48.1, lon: 35.2 }],
            pelengPoints: [{ lat: 48.3, lon: 35.4 }],
          }}
        />,
      ),
    );

    expect(container.textContent).toContain('17 підрозділ');
    expect(container.textContent).toContain('Населені пункти: 1');
    expect(container.textContent).toContain('Пеленги: 1');
    expect(leaflet.circleMarker).toHaveBeenNthCalledWith(
      1,
      [48.1, 35.2],
      expect.objectContaining({ fillColor: '#2196f3' }),
    );
    expect(leaflet.circleMarker).toHaveBeenNthCalledWith(
      2,
      [48.3, 35.4],
      expect.objectContaining({ fillColor: '#f44336' }),
    );
  });
});
