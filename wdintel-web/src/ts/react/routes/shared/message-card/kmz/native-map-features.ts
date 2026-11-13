import { DOMParser } from '@xmldom/xmldom';
import { gpx } from '@tmcw/togeojson';
import type { Feature, Geometry } from 'geojson';

import {
  MAX_KMZ_PREVIEW_COORDINATES,
  MAX_MAP_PREVIEW_FEATURES,
  MAX_MAP_PREVIEW_GEOMETRY_DEPTH,
} from './kmz-preview-utils';

function malformed(): never {
  throw new Error('MAP_MALFORMED');
}

function record(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as Record<string, unknown>;
}

function validateCoordinates(value: unknown, depth: number, count: { value: number }) {
  if (!Array.isArray(value)) malformed();
  if (depth > 0) {
    for (const child of value) validateCoordinates(child, depth - 1, count);
    return;
  }
  if (
    value.length < 2 ||
    !value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) ||
    Math.abs(value[0]) > 180 ||
    Math.abs(value[1]) > 90
  )
    malformed();
  if (++count.value > MAX_KMZ_PREVIEW_COORDINATES) throw new Error('KMZ_TOO_MANY_COORDINATES');
}

function validateGeometry(value: unknown, count: { value: number; geometries: number }, depth = 0) {
  if (depth > MAX_MAP_PREVIEW_GEOMETRY_DEPTH) malformed();
  if (++count.geometries > MAX_MAP_PREVIEW_FEATURES) throw new Error('MAP_TOO_MANY_FEATURES');
  const geometry = record(value);
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries)) malformed();
    for (const child of geometry.geometries) validateGeometry(child, count, depth + 1);
    return;
  }
  const coordinateDepth =
    geometry.type === 'Point'
      ? 0
      : geometry.type === 'MultiPoint' || geometry.type === 'LineString'
        ? 1
        : geometry.type === 'MultiLineString' || geometry.type === 'Polygon'
          ? 2
          : geometry.type === 'MultiPolygon'
            ? 3
            : null;
  if (coordinateDepth == null) malformed();
  validateCoordinates(geometry.coordinates, coordinateDepth, count);
}

function checkedFeatures(value: unknown): Array<Feature<Geometry | null>> {
  const document = record(value);
  const values =
    document.type === 'FeatureCollection'
      ? document.features
      : [document.type === 'Feature' ? document : { type: 'Feature', geometry: document }];
  if (!Array.isArray(values)) malformed();
  if (values.length > MAX_MAP_PREVIEW_FEATURES) throw new Error('MAP_TOO_MANY_FEATURES');
  const count = { value: 0, geometries: 0 };
  return values.map((value) => {
    const feature = record(value);
    if (feature.type !== 'Feature' || !('geometry' in feature)) malformed();
    if (feature.properties != null) record(feature.properties);
    if (feature.geometry != null) validateGeometry(feature.geometry, count);
    return feature as Feature<Geometry | null>;
  });
}

export function nativeMapFeatures(text: string, format: 'gpx' | 'geojson') {
  if (format === 'geojson') {
    let value: unknown;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      malformed();
    }
    return checkedFeatures(value);
  }
  let document: Document;
  try {
    document = new DOMParser({ onError: () => malformed() }).parseFromString(
      text,
      'application/xml',
    );
  } catch {
    malformed();
  }
  if (document.doctype != null || document.documentElement?.localName !== 'gpx') malformed();
  return checkedFeatures(gpx(document));
}
