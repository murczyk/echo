/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

const layer = (kind: string) => ({ kind, bindTooltip: vi.fn() });

vi.mock('leaflet', () => ({
  canvas: vi.fn(() => ({})),
  polygon: vi.fn(() => layer('polygon')),
  polyline: vi.fn(() => layer('line')),
  circleMarker: vi.fn(() => layer('point')),
}));

import { addPreviewLayers } from '../KmzAttachmentPreviewMap';

describe('addPreviewLayers', () => {
  it('draws overlapping polygons below lines and points', () => {
    const order: string[] = [];
    addPreviewLayers({ addLayer: (value: { kind: string }) => order.push(value.kind) } as never, {
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
    });

    expect(order).toEqual(['polygon', 'line', 'point']);
  });
});
