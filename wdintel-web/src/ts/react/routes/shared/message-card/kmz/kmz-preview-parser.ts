import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';
import { Unzip, UnzipInflate } from 'fflate';
import type { Feature, Geometry, Position } from 'geojson';

import {
  MAX_KMZ_PREVIEW_COORDINATES,
  MAX_KMZ_PREVIEW_ENTRIES,
  MAX_KMZ_PREVIEW_EXPANDED_BYTES,
  MAX_KMZ_PREVIEW_SOURCE_BYTES,
} from './kmz-preview-utils';
import type { KmzPreview, KmzPreviewCoords } from './kmz-preview-types';

const decoder = new TextDecoder();

function fail(code: string): never {
  throw new Error(code);
}
function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function color(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) ? value : null;
}
function coord(value: Position): KmzPreviewCoords | null {
  const [lng, lat] = value;
  return typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
    ? { lat, lng }
    : null;
}
function appendCoords(values: Position[], coordinates: KmzPreviewCoords[]): KmzPreviewCoords[] {
  const result: KmzPreviewCoords[] = [];
  for (const value of values) {
    const parsed = coord(value);
    if (parsed == null) continue;
    if (coordinates.length + result.length >= MAX_KMZ_PREVIEW_COORDINATES)
      fail('KMZ_TOO_MANY_COORDINATES');
    result.push(parsed);
  }
  coordinates.push(...result);
  return result;
}
function addFeature(
  preview: KmzPreview,
  feature: Feature<Geometry | null>,
  coordinates: KmzPreviewCoords[],
) {
  if (feature.geometry == null) return;
  const properties = feature.properties ?? {};
  const label = typeof properties.name === 'string' ? properties.name : null;
  const strokeColor = color(properties.stroke);
  const fillColor = color(properties.fill);
  const strokeOpacity = number(properties['stroke-opacity'], 1);
  const fillOpacity = number(properties['fill-opacity'], 0.2);
  const pointColor = color(properties['icon-color']) ?? color(properties['marker-color']);
  const addGeometry = (geometry: Geometry) => {
    if (geometry.type === 'Point') {
      const value = coord(geometry.coordinates);
      if (value == null) return;
      coordinates.push(value);
      if (coordinates.length > MAX_KMZ_PREVIEW_COORDINATES) fail('KMZ_TOO_MANY_COORDINATES');
      preview.points.push({
        coords: value,
        label,
        color: pointColor,
        opacity: number(properties['icon-opacity'] ?? properties['marker-opacity'], 1),
      });
    } else if (geometry.type === 'LineString') {
      const values = appendCoords(geometry.coordinates, coordinates);
      if (values.length >= 2)
        preview.lineStrings.push({
          coords: values,
          label,
          color: strokeColor,
          opacity: strokeOpacity,
        });
    } else if (geometry.type === 'Polygon') {
      const coordinateCount = coordinates.length;
      const [outer, ...inner] = geometry.coordinates;
      if (outer == null) return;
      const exterior = appendCoords(outer, coordinates);
      if (exterior.length < 3) {
        coordinates.length = coordinateCount;
        return;
      }
      const rings = [exterior];
      for (const ring of inner) {
        const beforeRing = coordinates.length;
        const values = appendCoords(ring, coordinates);
        if (values.length >= 3) rings.push(values);
        else coordinates.length = beforeRing;
      }
      preview.polygons.push({ rings, label, strokeColor, strokeOpacity, fillColor, fillOpacity });
    } else if (
      geometry.type === 'MultiPoint' ||
      geometry.type === 'MultiLineString' ||
      geometry.type === 'MultiPolygon' ||
      geometry.type === 'GeometryCollection'
    ) {
      const geometries: Geometry[] =
        geometry.type === 'GeometryCollection'
          ? geometry.geometries
          : geometry.type === 'MultiPoint'
            ? geometry.coordinates.map((coordinates) => ({ type: 'Point', coordinates }))
            : geometry.type === 'MultiLineString'
              ? geometry.coordinates.map((coordinates) => ({ type: 'LineString', coordinates }))
              : geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }));
      geometries.forEach(addGeometry);
    }
  };
  addGeometry(feature.geometry);
}
function parseKml(text: string, preview: KmzPreview, coordinates: KmzPreviewCoords[]) {
  let document: Document;
  try {
    document = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    fail('KML_MALFORMED');
  }
  if (document.getElementsByTagName('parsererror').length > 0) fail('KML_MALFORMED');
  for (const feature of kml(document, { skipNullGeometry: true }).features)
    addFeature(preview, feature, coordinates);
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function kmzKmlTexts(bytes: Uint8Array): string[] {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('KMZ_MALFORMED');
  let entries = 0;
  let expanded = 0;
  let limitError: 'KMZ_TOO_MANY_ENTRIES' | 'KMZ_EXPANDED_TOO_LARGE' | null = null;
  const files: Array<{ name: string; chunks: Uint8Array[] }> = [];
  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > MAX_KMZ_PREVIEW_ENTRIES) {
      limitError = 'KMZ_TOO_MANY_ENTRIES';
      return;
    }
    if (!/\.kml$/i.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (error != null) fail('KMZ_MALFORMED');
      if (expanded + data.length > MAX_KMZ_PREVIEW_EXPANDED_BYTES) {
        limitError = 'KMZ_EXPANDED_TOO_LARGE';
        return;
      }
      expanded += data.length;
      chunks.push(data);
      if (final) files.push({ name: file.name, chunks });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof Error && /^KMZ_(TOO_MANY_ENTRIES|EXPANDED_TOO_LARGE)$/.test(error.message))
      throw error;
    fail('KMZ_MALFORMED');
  }
  if (limitError != null) fail(limitError);
  if (files.length === 0) fail('KMZ_NO_KML');
  return files
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ chunks }) => decoder.decode(concat(chunks)));
}

export function parseKmzPreview(buffer: ArrayBuffer, format: 'kml' | 'kmz'): KmzPreview {
  if (buffer.byteLength > MAX_KMZ_PREVIEW_SOURCE_BYTES) fail('KMZ_SOURCE_TOO_LARGE');
  const preview: KmzPreview = { points: [], lineStrings: [], polygons: [] };
  const coordinates: KmzPreviewCoords[] = [];
  const texts = format === 'kml' ? [decoder.decode(buffer)] : kmzKmlTexts(new Uint8Array(buffer));
  texts.forEach((text) => parseKml(text, preview, coordinates));
  return preview;
}
