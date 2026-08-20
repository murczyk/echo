/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BattleLineState } from '../../../../Bindings';

const leaflet = vi.hoisted(() => {
  const map = {
    fitBounds: vi.fn(),
    invalidateSize: vi.fn(),
    remove: vi.fn(),
    setView: vi.fn(),
  };
  map.setView.mockReturnValue(map);
  const layer = {
    addTo: vi.fn(),
    clearLayers: vi.fn(),
    getLayers: vi.fn(() => []),
  };
  layer.addTo.mockReturnValue(layer);
  return { layer, map };
});

vi.mock('../../../maps/leaflet-markercluster', () => ({
  L: {
    circleMarker: vi.fn(() => ({ addTo: vi.fn(), bindTooltip: vi.fn() })),
    featureGroup: vi.fn(() => ({ getBounds: () => ({ isValid: () => false }) })),
    layerGroup: vi.fn(() => leaflet.layer),
    map: vi.fn(() => leaflet.map),
    polyline: vi.fn(() => ({ addTo: vi.fn() })),
  },
}));

vi.mock('../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: () => ({ googleHybrid: { addTo: vi.fn() } }),
}));

import { aorColor, BattleLineMap, reconcileVisibleAorIds } from './BattleLineMap';

describe('BattleLineMap', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('assigns stable distinct AOR colors', () => {
    expect(aorColor(17)).toBe(aorColor(17));
    expect(aorColor(17)).not.toBe(aorColor(18));
  });

  it('preserves hidden AORs and shows newly received segments', () => {
    expect(reconcileVisibleAorIds(new Set([1]), new Set([1, 2]), [1, 2, 3])).toEqual(
      new Set([1, 3]),
    );
  });

  it('toggles AORs independently and with show-all/hide-all controls', async () => {
    const state: BattleLineState = {
      activeVersion: null,
      activeFeatures: [],
      previousVersions: [],
      aorGeometries: [
        {
          aorId: 1,
          aorName: 'AOR 1',
          features: [],
          snappedStart: { lat: 49, lon: 36 },
          snappedEnd: { lat: 49, lon: 37 },
        },
        {
          aorId: 2,
          aorName: 'AOR 2',
          features: [],
          snappedStart: { lat: 48, lon: 36 },
          snappedEnd: { lat: 48, lon: 37 },
        },
      ],
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(BattleLineMap, { state })));
    await vi.waitFor(() => {
      expect(
        [...container.querySelectorAll('input[type="checkbox"]')].map(
          (input) => (input as HTMLInputElement).checked,
        ),
      ).toEqual([true, true]);
    });

    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    await act(async () => (checkboxes[0] as HTMLInputElement).click());
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);

    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent === 'Сховати всі')?.click());
    expect(checkboxes.map((input) => (input as HTMLInputElement).checked)).toEqual([false, false]);

    await act(async () => buttons.find((button) => button.textContent === 'Показати всі')?.click());
    expect(checkboxes.map((input) => (input as HTMLInputElement).checked)).toEqual([true, true]);
    act(() => root.unmount());
  });
});
