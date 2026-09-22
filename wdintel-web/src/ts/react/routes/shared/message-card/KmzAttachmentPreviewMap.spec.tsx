/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseLayerId } from '../../../../maps/base-layers';
import { KmzAttachmentPreviewMap } from './KmzAttachmentPreviewMap';

const leaflet = vi.hoisted(() => {
  const layerGroup = {
    addTo: vi.fn(),
    addLayer: vi.fn(),
    remove: vi.fn(),
  };
  layerGroup.addTo.mockReturnValue(layerGroup);
  const marker = { bindTooltip: vi.fn() };
  marker.bindTooltip.mockReturnValue(marker);
  return {
    map: {},
    layerGroup,
    marker,
    canvas: vi.fn(() => ({})),
    circleMarker: vi.fn(() => marker),
    featureGroup: vi.fn(() => layerGroup),
    polyline: vi.fn(() => ({})),
  };
});

const fitGeometryLayers = vi.hoisted(() => vi.fn());

vi.mock('leaflet', () => ({
  canvas: leaflet.canvas,
  circleMarker: leaflet.circleMarker,
  featureGroup: leaflet.featureGroup,
  polyline: leaflet.polyline,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ palette: { primary: { main: '#1976d2' } } }),
}));

vi.mock('../../rer-palitra-neo/components/PalitraPreviewDialog.layers', () => ({
  fitGeometryLayers,
}));

vi.mock('./MessageCardMapPreview', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    MessageCardMapPreview: ({
      baseLayerId,
      onMapReady,
    }: {
      baseLayerId: BaseLayerId;
      onMapReady: (map: never) => void | (() => void);
    }) => {
      useEffect(() => onMapReady(leaflet.map as never), [onMapReady]);
      return <div data-shared-map-layer={baseLayerId} />;
    },
  };
});

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  leaflet.layerGroup.addTo.mockReturnValue(leaflet.layerGroup);
  leaflet.marker.bindTooltip.mockReturnValue(leaflet.marker);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('KmzAttachmentPreviewMap', () => {
  it('uses the shared coordinate map shell and MUI primary blue for KMZ points', async () => {
    await act(async () => {
      root?.render(
        <KmzAttachmentPreviewMap
          baseLayerId={BaseLayerId.Delta}
          preview={{
            points: [
              {
                coords: { lat: 50.45, lng: 30.52 },
                label: 'Точка',
                color: '#060606',
              },
            ],
            lineStrings: [
              {
                coords: [
                  { lat: 50.45, lng: 30.52 },
                  { lat: 50.46, lng: 30.53 },
                ],
                color: '#123456',
              },
            ],
          }}
        />,
      );
    });

    expect(
      document.body.querySelector('[data-shared-map-layer="esriWorldImagery"]'),
    ).not.toBeNull();
    expect(leaflet.circleMarker).toHaveBeenCalledWith(
      [50.45, 30.52],
      expect.objectContaining({
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#1976d2',
      }),
    );
    expect(leaflet.polyline).toHaveBeenCalledWith(
      [
        [50.45, 30.52],
        [50.46, 30.53],
      ],
      expect.objectContaining({ color: '#123456' }),
    );
    expect(fitGeometryLayers).toHaveBeenCalledWith(leaflet.map, leaflet.layerGroup);
  });
});
