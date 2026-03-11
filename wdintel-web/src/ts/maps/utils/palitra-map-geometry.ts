import * as L from 'leaflet';

import { Coords, Palitra, PalitraDetails, PalitraPoint } from '../palitra-types';

export function boundsOfSearchResults(
  data: { palitra_id: number; points: PalitraPoint[] }[],
  sampleSize: number,
): L.LatLngBounds | null {
  const total = data.reduce((acc, item) => acc + item.points.length, 0);
  if (total === 0) return null;

  // Sample large result sets to avoid O(n) bound calculations on huge datasets.
  const sampleStep = total <= sampleSize ? 1 : Math.max(1, Math.floor(total / sampleSize));
  const latLngs: L.LatLng[] = [];
  let index = 0;
  for (const { points } of data) {
    for (const point of points) {
      if (index % sampleStep === 0) {
        latLngs.push(L.latLng(point.coords.lat, point.coords.lng));
      }
      index += 1;
    }
  }
  if (latLngs.length === 0) return null;
  return L.latLngBounds(latLngs);
}

export function filterPalitraApiIdsByBounds(
  palitras: PalitraDetails[],
  bounds: L.LatLngBounds,
  toApiId: (palitra: Palitra) => number,
): number[] {
  return Array.from(
    new Set(
      palitras
        .filter((palitraDetails) => {
          const geometry = palitraDetails.palitra.geometry;
          // Palitras without geometry cannot be spatially filtered, keep them in request.
          if (!geometry || !geometry.perimeter_linear_ring) {
            return true;
          }
          const ring = geometry.perimeter_linear_ring;
          if (ring.length === 0) {
            return true;
          }
          const palitraBounds = buildBounds(ring);
          return bounds.intersects(palitraBounds);
        })
        .map((palitraDetails) => toApiId(palitraDetails.palitra)),
    ),
  );
}

export function createPalitraPolygon(palitraDetails: PalitraDetails): L.Polygon | null {
  const palitra = palitraDetails.palitra;

  if (!palitra.geometry || !palitra.geometry.perimeter_linear_ring) {
    return null;
  }

  const latlngs: [number, number][] = palitra.geometry.perimeter_linear_ring.map(
    (coord: Coords) => [coord.lat, coord.lng] as [number, number],
  );

  if (latlngs.length < 3) {
    return null;
  }

  const polygon = L.polygon(latlngs, {
    color: palitra.color_hex,
    fillColor: palitra.color_hex,
    fillOpacity: 0.2,
    weight: 2,
    opacity: 0.8
  });

  const pointsCount = palitra.geometry.perimeter_linear_ring.length;
  const centerLat = palitra.geometry.center.lat.toFixed(4);
  const centerLng = palitra.geometry.center.lng.toFixed(4);

  const popupContent = `
      <div style="padding: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span style="display: inline-block; width: 16px; height: 16px; background-color: ${palitra.color_hex}; border: 1px solid #ccc; border-radius: 3px;"></span>
          <strong style="font-size: 14px;">${palitra.name}</strong>
        </div>
        <div style="font-size: 12px; color: #666;">
          <div>Центр: ${centerLat}, ${centerLng}</div>
          <div>Точок периметру: ${pointsCount}</div>
          ${palitra.source_file_name ? `<div>Файл: ${palitra.source_file_name}</div>` : ''}
        </div>
      </div>
    `;

  polygon.bindPopup(popupContent);
  polygon.bindTooltip(palitra.name, {
    permanent: true,
    direction: 'center',
    className: 'palitra-label'
  });

  return polygon;
}

function buildBounds(coords: Coords[]): L.LatLngBounds {
  let minLat = coords[0].lat;
  let maxLat = coords[0].lat;
  let minLng = coords[0].lng;
  let maxLng = coords[0].lng;

  coords.forEach((coord) => {
    if (coord.lat < minLat) minLat = coord.lat;
    if (coord.lat > maxLat) maxLat = coord.lat;
    if (coord.lng < minLng) minLng = coord.lng;
    if (coord.lng > maxLng) maxLng = coord.lng;
  });

  return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
}
