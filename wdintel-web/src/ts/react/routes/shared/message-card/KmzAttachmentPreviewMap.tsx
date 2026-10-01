import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useRef } from 'react';

import type { KmzPreview, KmzPreviewCoords } from './kmz/kmz-preview-types';
import type { BaseLayerId } from '../../../../maps/base-layers';
import { fitGeometryLayers } from '../../rer-palitra-neo/components/PalitraPreviewDialog.layers';
import { MessageCardMapPreview } from './MessageCardMapPreview';

const FALLBACK_GEOMETRY_COLOR = '#060606';

function validCoords(coords: KmzPreviewCoords): coords is KmzPreviewCoords {
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

export function addPreviewLayers(layerGroup: L.FeatureGroup, preview: KmzPreview): void {
  const renderer = L.canvas({ padding: 0.25 });
  const pointRadius = preview.points.length > 500 ? 2 : 4;
  for (const polygon of preview.polygons) {
    const [outer, ...inner] = polygon.rings;
    const outerRing = outer
      ?.filter(validCoords)
      .map(({ lat, lng }) => [lat, lng] as [number, number]);
    if (outerRing == null || outerRing.length < 3) continue;
    const rings = [
      outerRing,
      ...inner
        .map((ring) =>
          ring.filter(validCoords).map(({ lat, lng }) => [lat, lng] as [number, number]),
        )
        .filter((ring) => ring.length >= 3),
    ];
    const layer = L.polygon(rings, {
      renderer,
      interactive: false,
      color: geometryColor(polygon.strokeColor),
      opacity: polygon.strokeOpacity,
      fillColor: geometryColor(polygon.fillColor),
      fillOpacity: polygon.fillOpacity,
      weight: 2,
      lineJoin: 'round',
    });
    if (polygon.label?.trim()) {
      const label = document.createElement('span');
      label.textContent = polygon.label;
      layer.bindTooltip(label);
    }
    layerGroup.addLayer(layer);
  }
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
          opacity: line.opacity,
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
      radius: pointRadius,
      color: geometryColor(point.color),
      weight: 1,
      fillColor: geometryColor(point.color),
      fillOpacity: point.opacity,
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
  preview: KmzPreview;
  baseLayerId: BaseLayerId;
}) {
  const layersRef = useRef<L.FeatureGroup | null>(null);
  const initializeMap = useCallback(
    (map: L.Map) => {
      const layers = L.featureGroup().addTo(map);
      addPreviewLayers(layers, preview);
      layersRef.current = layers;
      fitGeometryLayers(map, layers);
      return () => {
        layers.remove();
        layersRef.current = null;
      };
    },
    [preview],
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
