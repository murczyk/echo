import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Box } from '@mui/material';
import { useLayoutEffect, useRef } from 'react';

import type { Coords, SignalMediaKmzPreviewRsp } from '../../../../../Bindings';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import { fitGeometryLayers } from '../../rer-palitra-neo/components/PalitraPreviewDialog.layers';
import { getPreviewShellSx } from '../../rer-palitra-neo/components/PalitraPreviewDialog.styles';
import {
  DEFAULT_PREVIEW_CENTER,
  DEFAULT_PREVIEW_ZOOM,
  PREVIEW_MAX_ZOOM,
} from '../../rer-palitra-neo/components/PalitraPreviewDialog.types';

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

function addPreviewLayers(layerGroup: L.FeatureGroup, preview: SignalMediaKmzPreviewRsp): void {
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
    const color = geometryColor(point.color);
    const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
      renderer,
      radius: 4,
      color,
      weight: 1,
      fillColor: color,
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
  fill = false,
}: {
  preview: SignalMediaKmzPreviewRsp;
  fill?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = L.map(container, {
      attributionControl: false,
      minZoom: 2,
      maxZoom: PREVIEW_MAX_ZOOM,
    }).setView(DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM);
    getTileLayers().openStreetMap.addTo(map);
    const layers = L.featureGroup().addTo(map);
    addPreviewLayers(layers, preview);

    const fit = () => {
      map.invalidateSize();
      fitGeometryLayers(map, layers);
    };
    const frame = window.requestAnimationFrame(fit);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit());
    resizeObserver?.observe(container);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      map.remove();
    };
  }, [preview]);

  return (
    <Box
      ref={containerRef}
      className="palitra-map-surface"
      sx={
        fill
          ? {
              ...getPreviewShellSx(),
              flex: '1 1 auto',
              height: '100%',
              minHeight: 0,
              border: 0,
              borderRadius: 0,
            }
          : getPreviewShellSx()
      }
    />
  );
}
