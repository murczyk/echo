/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import { PalitraManager, shouldShowPalitrasControl } from './palitra-manager';
import type { PalitraDetails } from './palitra-types';

function createPalitraDetails(overrides?: Partial<PalitraDetails>): PalitraDetails {
  return {
    palitra: {
      id: 1,
      name: 'Test',
      color_hex: '#ff0000',
      geometry: {
        perimeter_linear_ring: [
          { lat: 47.1, lng: 35.1 },
          { lat: 47.2, lng: 35.1 },
          { lat: 47.2, lng: 35.2 },
        ],
      },
      ...overrides?.palitra,
    },
    points: [],
    ...overrides,
  };
}

function createLinePalitraDetails(overrides?: Partial<PalitraDetails>): PalitraDetails {
  return createPalitraDetails({
    palitra: {
      id: 2,
      name: 'Line',
      color_hex: '#00ff00',
      geometry: {
        line_strings: [
          [
            { lat: 47.1, lng: 35.1 },
            { lat: 47.2, lng: 35.2 },
          ],
        ],
      },
      ...overrides?.palitra,
    },
    ...overrides,
  });
}

function createManager(overrides?: Partial<PalitraManager>) {
  const manager = Object.create(PalitraManager.prototype) as PalitraManager & {
    map: { fitBounds: ReturnType<typeof vi.fn> };
    layerGroup: { clearLayers: ReturnType<typeof vi.fn>; addLayer: ReturnType<typeof vi.fn> };
    pointsController: {
      updatePoints: ReturnType<typeof vi.fn>;
      onEnabledChanged: ReturnType<typeof vi.fn>;
    };
    control: null;
    palitras: PalitraDetails[];
    visibleIds: number[];
    enabled: boolean;
    loadState: 'idle' | 'loading' | 'success' | 'error';
    interactionDisabled: boolean;
  };

  manager.map = {
    fitBounds: vi.fn(),
  };
  manager.layerGroup = {
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
  };
  manager.pointsController = {
    updatePoints: vi.fn(),
    onEnabledChanged: vi.fn(),
  };
  manager.control = null;
  manager.palitras = [];
  manager.visibleIds = [];
  manager.enabled = true;
  manager.loadState = 'idle';
  manager.interactionDisabled = false;

  Object.assign(manager, overrides);
  return manager;
}

describe('shouldShowPalitrasControl', () => {
  it('keeps the palitras control visible after an empty successful load', () => {
    expect(
      shouldShowPalitrasControl({ enabled: true, loadState: 'success', palitrasCount: 0 }),
    ).toBe(true);
  });

  it('hides the palitras control while idle without data', () => {
    expect(shouldShowPalitrasControl({ enabled: true, loadState: 'idle', palitrasCount: 0 })).toBe(
      false,
    );
  });
});

describe('PalitraManager viewport actions', () => {
  it('does not fit bounds when visible ids change', () => {
    const manager = createManager({
      enabled: true,
      palitras: [createPalitraDetails()],
    });

    manager.updateVisibleIds([1]);

    expect(manager.map.fitBounds).not.toHaveBeenCalled();
  });

  it('does not fit bounds when enabling the palette layer', () => {
    const manager = createManager({
      enabled: false,
      palitras: [createPalitraDetails()],
      visibleIds: [1],
    });

    manager.setEnabled(true);

    expect(manager.map.fitBounds).not.toHaveBeenCalled();
  });

  it('fits bounds for the currently visible palette geometries', () => {
    const manager = createManager({
      enabled: true,
      palitras: [createPalitraDetails()],
      visibleIds: [1],
    });

    manager.fitPalitras([1]);

    expect(manager.map.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, options] = manager.map.fitBounds.mock.calls[0];
    expect(options).toEqual({ padding: [50, 50], maxZoom: 10 });
    expect(bounds.isValid()).toBe(true);
  });

  it('fits bounds for visible selected polygon and line geometries while ignoring duplicates and stale ids', () => {
    const manager = createManager({
      enabled: true,
      palitras: [
        createPalitraDetails(),
        createLinePalitraDetails(),
        createPalitraDetails({
          palitra: {
            id: 3,
            name: 'Center only',
            color_hex: '#0000ff',
            geometry: {
              center: { lat: 47.15, lng: 35.15 },
            },
          },
        }),
      ],
      visibleIds: [1, 2, 3],
    });

    manager.fitPalitras([1, 1, 2, 3, 999]);

    expect(manager.map.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, options] = manager.map.fitBounds.mock.calls[0];
    expect(options).toEqual({ padding: [50, 50], maxZoom: 10 });
    expect(bounds.isValid()).toBe(true);
  });

  it('does nothing when focus ids are unknown, deselected, or non-renderable', () => {
    const manager = createManager({
      enabled: true,
      palitras: [
        createPalitraDetails(),
        createPalitraDetails({
          palitra: {
            id: 4,
            name: 'Center only',
            color_hex: '#00ff00',
            geometry: {
              center: { lat: 47.15, lng: 35.15 },
            },
          },
        }),
      ],
      visibleIds: [1],
    });

    manager.fitPalitras([4, 999]);

    expect(manager.map.fitBounds).not.toHaveBeenCalled();
  });

  it('does nothing when the visible palettes have no geometry', () => {
    const manager = createManager({
      enabled: true,
      palitras: [
        createPalitraDetails({
          palitra: {
            id: 2,
            name: 'No geometry',
            color_hex: '#00ff00',
            geometry: null,
          },
        }),
      ],
      visibleIds: [2],
    });

    manager.fitPalitras([2]);

    expect(manager.map.fitBounds).not.toHaveBeenCalled();
  });

  it('does nothing when the visible palettes have non-renderable geometry', () => {
    const manager = createManager({
      enabled: true,
      palitras: [
        createPalitraDetails({
          palitra: {
            id: 3,
            name: 'Center only',
            color_hex: '#0000ff',
            geometry: {
              center: { lat: 47.15, lng: 35.15 },
            },
          },
        }),
      ],
      visibleIds: [3],
    });

    manager.fitPalitras([3]);

    expect(manager.map.fitBounds).not.toHaveBeenCalled();
  });
});
