import * as L from 'leaflet';

import type { PalitraDetails } from '../../../../maps/palitra-types';
import {
  DEFAULT_PREVIEW_CENTER,
  DEFAULT_PREVIEW_ZOOM,
  PREVIEW_MAX_ZOOM,
} from './PalitraPreviewDialog.types';

function createPolygonLayer(palitraDetails: PalitraDetails) {
  const perimeter = palitraDetails.palitra.geometry?.perimeter_linear_ring;
  if (!Array.isArray(perimeter) || perimeter.length < 3) {
    return null;
  }

  return L.polygon(
    perimeter.map((coords) => [coords.lat, coords.lng] as [number, number]),
    {
      interactive: false,
      color: palitraDetails.palitra.color_hex,
      weight: 2,
      fillColor: palitraDetails.palitra.color_hex,
      fillOpacity: 0.14,
      lineJoin: 'round',
      lineCap: 'round',
    },
  );
}

function createPolylineLayers(palitraDetails: PalitraDetails) {
  const lineStrings = palitraDetails.palitra.geometry?.line_strings;
  if (!Array.isArray(lineStrings) || lineStrings.length === 0) {
    return [];
  }

  return lineStrings
    .filter((lineString) => Array.isArray(lineString) && lineString.length >= 2)
    .map((lineString) =>
      L.polyline(
        lineString.map((coords) => [coords.lat, coords.lng] as [number, number]),
        {
          interactive: false,
          color: palitraDetails.palitra.color_hex,
          weight: 2,
          opacity: 0.9,
          lineJoin: 'round',
          lineCap: 'round',
        },
      ),
    );
}

function createCenterLayer(palitraDetails: PalitraDetails) {
  const center = palitraDetails.palitra.geometry?.center;
  if (!center) {
    return null;
  }

  return L.circleMarker([center.lat, center.lng], {
    interactive: false,
    radius: 4,
    color: palitraDetails.palitra.color_hex,
    weight: 1,
    fillColor: palitraDetails.palitra.color_hex,
    fillOpacity: 1,
  });
}

export function addPreviewGeometryLayers(
  layerGroup: L.FeatureGroup,
  palitraDetailsList: PalitraDetails[],
) {
  palitraDetailsList.forEach((palitraDetails) => {
    const polygon = createPolygonLayer(palitraDetails);
    if (polygon) {
      layerGroup.addLayer(polygon);
    }

    for (const line of createPolylineLayers(palitraDetails)) {
      layerGroup.addLayer(line);
    }

    const center = createCenterLayer(palitraDetails);
    if (center) {
      layerGroup.addLayer(center);
    }
  });
}

export function fitGeometryLayers(map: L.Map, layerGroup: L.FeatureGroup) {
  const bounds = layerGroup.getBounds();
  if (!bounds.isValid()) {
    map.setView(DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM, { animate: false });
    return;
  }

  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(bounds.getCenter(), PREVIEW_MAX_ZOOM, { animate: false });
    return;
  }

  map.fitBounds(bounds.pad(0.14), {
    animate: false,
    maxZoom: PREVIEW_MAX_ZOOM,
  });
}
