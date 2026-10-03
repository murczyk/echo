/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';

const layer = (kind: string) => ({ kind, bindTooltip: vi.fn() });

vi.mock('leaflet', () => ({
  canvas: vi.fn(() => ({})),
  polygon: vi.fn(() => layer('polygon')),
  polyline: vi.fn(() => layer('line')),
  circleMarker: vi.fn(() => layer('point')),
}));

import { addPreviewLayers, clusterTextColor } from '../KmzAttachmentPreviewMap';

describe('addPreviewLayers', () => {
  it('draws overlapping polygons below lines and points', () => {
    const layers: Array<{ kind: string; bindTooltip: ReturnType<typeof vi.fn> }> = [];
    addPreviewLayers(
      { addLayer: (value: (typeof layers)[number]) => layers.push(value) } as never,
      {
        polygons: [
          {
            rings: [
              [
                { lat: 50, lng: 30 },
                { lat: 51, lng: 30 },
                { lat: 50, lng: 31 },
              ],
              [
                { lat: 50.1, lng: 30.1 },
                { lat: 50.2, lng: 30.1 },
                { lat: 50.1, lng: 30.2 },
              ],
            ],
            label: 'Area',
            strokeColor: '#000000',
            strokeOpacity: 1,
            fillColor: '#ff0000',
            fillOpacity: 1,
          },
        ],
        lineStrings: [
          {
            coords: [
              { lat: 50, lng: 30 },
              { lat: 51, lng: 31 },
            ],
            label: 'Route',
            color: '#00ff00',
            opacity: 1,
          },
        ],
        points: [
          {
            coords: { lat: 50.5, lng: 30.5 },
            label: 'Position',
            color: '#0000ff',
            opacity: 1,
          },
        ],
      },
    );

    expect(layers.map((value) => value.kind)).toEqual(['polygon', 'line', 'point']);
    expect(vi.mocked(L.polygon).mock.calls[0]?.[1]).toMatchObject({ fillOpacity: 0.25 });
    expect(layers[2]?.bindTooltip).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ permanent: true, className: 'palitra-point-label' }),
    );
  });

  it('keeps point counts readable on pale and dark cluster colors', () => {
    expect(clusterTextColor('#ffff00')).toBe('#060606');
    expect(clusterTextColor('#000000')).toBe('#fff');
  });
});
