import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useTheme } from '@mui/material/styles';
import { useCallback, useRef } from 'react';

import type { Coords, SignalMediaKmzPreviewRsp } from '../../../../../Bindings';
import type { BaseLayerId } from '../../../../maps/base-layers';
import { fitGeometryLayers } from '../../rer-palitra-neo/components/PalitraPreviewDialog.layers';
import { MessageCardMapPreview } from './MessageCardMapPreview';

const FALLBACK_GEOMETRY_COLOR = '#060606';

function validCoords(coords: Coords): coords is Coords {
  return (
    Number.isFinite(coords.lat) &&
    Number.isFinite(coords.lng) &&
    coords.lat >= -90 &&
    coords.lat <= 90 &&
    coords.lng >= -180 &&
    coords.lng <= 180
  );
}

function geometryColor(color: string | null): string {
  return color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color : FALLBACK_GEOMETRY_COLOR;
}

function addPreviewLayers(
  layerGroup: L.FeatureGroup,
  preview: SignalMediaKmzPreviewRsp,
  pointColor: string,
): void {
  const renderer = L.canvas({ padding: 0.25 });
  for (const line of preview.lineStrings) {
    const coords = line.coords.filter(validCoords);
    if (coords.length < 2) continue;
    layerGroup.addLayer(
      L.polyline(
        coords.map(({ lat, lng }) => [lat, lng] as [number, number]),
        {
          renderer,
          interactive: false,
          color: geometryColor(line.color),
          weight: 2,
          opacity: 0.9,
          lineJoin: 'round',
          lineCap: 'round',
        },
      ),
    );
  }
  for (const point of preview.points) {
    if (!validCoords(point.coords)) continue;
    const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
      renderer,
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: pointColor,
      fillOpacity: 1,
    });
    if (point.label?.trim()) {
      const label = document.createElement('span');
      label.textContent = point.label;
      marker.bindTooltip(label);
    }
    layerGroup.addLayer(marker);
  }
}

export function KmzAttachmentPreviewMap({
  preview,
  baseLayerId,
}: {
  preview: SignalMediaKmzPreviewRsp;
  baseLayerId: BaseLayerId;
}) {
  const theme = useTheme();
  const layersRef = useRef<L.FeatureGroup | null>(null);
  const initializeMap = useCallback(
    (map: L.Map) => {
      const layers = L.featureGroup().addTo(map);
      addPreviewLayers(layers, preview, theme.palette.primary.main);
      layersRef.current = layers;
      fitGeometryLayers(map, layers);
      return () => {
        layers.remove();
        layersRef.current = null;
      };
    },
    [preview, theme.palette.primary.main],
  );
  const resizeMap = useCallback((map: L.Map) => {
    if (layersRef.current != null) fitGeometryLayers(map, layersRef.current);
  }, []);

  return (
    <MessageCardMapPreview
      baseLayerId={baseLayerId}
      className="coordinate-fullscreen-map"
      dataAttributes={{ 'data-kmz-preview-map': 'true' }}
      onMapReady={initializeMap}
      onMapResize={resizeMap}
    />
  );
}
