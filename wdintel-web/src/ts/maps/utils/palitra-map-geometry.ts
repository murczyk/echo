import * as L from 'leaflet';

import { buildPalitraPopupContent } from '../palitra-popup-content';
import { Coords, Geometry, Palitra, PalitraDetails, PalitraPoint } from '../palitra-types';

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
          if (!geometry) {
            return true;
          }
          const ring = geometry.perimeter_linear_ring;
          if (ring && ring.length > 0) {
            const palitraBounds = buildBounds(ring);
            return bounds.intersects(palitraBounds);
          }
          const lineBounds = buildLineStringsBounds(geometry.line_strings);
          if (!lineBounds) {
            return true;
          }
          return bounds.intersects(lineBounds);
        })
        .map((palitraDetails) => toApiId(palitraDetails.palitra)),
    ),
  );
}

export function createPalitraGeometryLayer(palitraDetails: PalitraDetails): L.Layer | null {
  const palitra = palitraDetails.palitra;
  const geometry = palitra.geometry;

  if (!geometry) {
    return null;
  }

  const perimeter = geometry.perimeter_linear_ring;
  const layers: L.Layer[] = [];
  if (perimeter && perimeter.length >= 3) {
    layers.push(createPalitraPolygon(palitraDetails, perimeter));
  }

  const lineStrings = geometry.line_strings ?? [];
  const validLines = lineStrings.filter((line) => line.length >= 2);
  if (validLines.length > 0) {
    const lineLayers = validLines.map((line) =>
      L.polyline(
        line.map((coord) => [coord.lat, coord.lng] as [number, number]),
        {
          color: palitra.color_hex,
          weight: 2,
          opacity: 0.9,
        },
      ),
    );
    const lineLayer = lineLayers.length === 1 ? lineLayers[0] : L.featureGroup(lineLayers);
    const metaLines = buildLineMetaLines(geometry, palitra, validLines);
    bindPalitraPopup(lineLayer, palitra, metaLines);
    lineLayer.bindTooltip(palitra.name, {
      permanent: true,
      direction: 'center',
      className: 'palitra-label',
    });
    layers.push(lineLayer);
  }

  if (layers.length === 0) {
    return null;
  }

  return layers.length === 1 ? layers[0] : L.featureGroup(layers);
}

function createPalitraPolygon(palitraDetails: PalitraDetails, ring: Coords[]): L.Polygon {
  const palitra = palitraDetails.palitra;
  const geometry = palitra.geometry as Geometry;
  const latlngs: [number, number][] = ring.map(
    (coord: Coords) => [coord.lat, coord.lng] as [number, number],
  );

  const polygon = L.polygon(latlngs, {
    color: palitra.color_hex,
    fillColor: palitra.color_hex,
    fillOpacity: 0.2,
    weight: 2,
    opacity: 0.8,
  });
  const metaLines = buildPolygonMetaLines(geometry, palitra, ring.length);
  bindPalitraPopup(polygon, palitra, metaLines);
  polygon.bindTooltip(palitra.name, {
    permanent: true,
    direction: 'center',
    className: 'palitra-label',
  });
  return polygon;
}

function buildPolygonMetaLines(
  geometry: Geometry,
  palitra: Palitra,
  pointsCount: number,
): string[] {
  const metaLines: Array<string | null> = [
    formatCenterLine(geometry),
    `Точок периметру: ${pointsCount}`,
    palitra.source_file_name ? `Файл: ${palitra.source_file_name}` : null,
  ];
  return metaLines.filter((value): value is string => value !== null);
}

function buildLineMetaLines(
  geometry: Geometry,
  palitra: Palitra,
  lineStrings: Coords[][],
): string[] {
  const totalPoints = lineStrings.reduce((acc, line) => acc + line.length, 0);
  const metaLines: Array<string | null> = [
    formatCenterLine(geometry),
    `Ліній: ${lineStrings.length}`,
    `Точок лінії: ${totalPoints}`,
    palitra.source_file_name ? `Файл: ${palitra.source_file_name}` : null,
  ];
  return metaLines.filter((value): value is string => value !== null);
}

function formatCenterLine(geometry: Geometry): string | null {
  if (!geometry.center) {
    return null;
  }
  const centerLat = geometry.center.lat.toFixed(4);
  const centerLng = geometry.center.lng.toFixed(4);
  return `Центр: ${centerLat}, ${centerLng}`;
}

function bindPalitraPopup(
  layer: L.Layer & { bindPopup: L.Layer['bindPopup'] },
  palitra: Palitra,
  metaLines: string[],
): void {
  layer.bindPopup(
    buildPalitraPopupContent(layer as L.Polygon & L.Layer & { closePopup: () => void }, palitra, {
      emphasisLine: null,
      metaLines,
    }),
    {
      className: 'analysis-map-compact-popup-shell',
      closeButton: false,
    },
  );
}

function buildLineStringsBounds(lineStrings?: Coords[][] | null): L.LatLngBounds | null {
  if (!lineStrings || lineStrings.length === 0) {
    return null;
  }
  const flattened = lineStrings.flat();
  if (flattened.length === 0) {
    return null;
  }
  return buildBounds(flattened);
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
