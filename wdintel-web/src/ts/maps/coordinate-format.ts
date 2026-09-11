import { forward } from 'mgrs';
import { tdWgs84ToSk42, tdWgs84ToUsk2000, wgs84ToUtm } from '../utils';

export type CoordFormat = 'mgrs' | 'wgs' | 'dms' | 'sk42' | 'usk2000' | 'utm';

export const COORD_FORMAT_OPTIONS: ReadonlyArray<{ value: CoordFormat; label: string }> = [
  { value: 'mgrs', label: 'MGRS' },
  { value: 'wgs', label: 'WGS-84' },
  { value: 'dms', label: 'WGS-84 DMS' },
  { value: 'sk42', label: 'СК-42' },
  { value: 'usk2000', label: 'УСК-2000' },
  { value: 'utm', label: 'UTM' },
];

export type Wgs84Coords = {
  lat: number;
  lng: number;
};

export function getCoordinateText(
  format: CoordFormat,
  coords: Wgs84Coords,
  mgrsCoords?: string | null,
): string {
  return getCoordinateTextIfAvailable(format, coords, mgrsCoords) ?? formatWgs84(coords);
}

export function getCoordinateTextIfAvailable(
  format: CoordFormat,
  coords: Wgs84Coords,
  mgrsCoords?: string | null,
): string | null {
  if (format === 'wgs') {
    return formatWgs84(coords);
  }

  if (format === 'dms') {
    return `${formatDms(coords.lat)}, ${formatDms(coords.lng)}`;
  }

  if (format === 'sk42') {
    const converted = tdWgs84ToSk42({ x: coords.lng, y: coords.lat });
    return converted ? formatGrid('СК-42', converted.y, converted.x) : null;
  }

  if (format === 'usk2000') {
    const converted = tdWgs84ToUsk2000({ x: coords.lng, y: coords.lat });
    return converted ? formatGrid('УСК-2000', converted.y, converted.x) : null;
  }

  if (format === 'utm') {
    const converted = wgs84ToUtm(coords);
    return converted
      ? `${converted.zone}${converted.band} ${String(Math.round(converted.easting)).padStart(6, '0')} ${String(Math.round(converted.northing)).padStart(7, '0')}`
      : null;
  }

  if (mgrsCoords) {
    return formatMgrs(mgrsCoords);
  }

  return getCoordinateMgrsText(coords, mgrsCoords);
}

export function getCoordinateMgrsText(
  coords: Wgs84Coords,
  mgrsCoords?: string | null,
): string | null {
  if (mgrsCoords) {
    return formatMgrs(mgrsCoords);
  }

  try {
    return formatMgrs(forward([coords.lng, coords.lat]));
  } catch (_error) {
    return null;
  }
}

export function formatWgs84(coords: Wgs84Coords): string {
  return `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
}

function formatDms(value: number): string {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (minutesFloat - minutes) * 60;
  const sign = value < 0 ? '-' : '';
  return `${sign}${degrees}°${minutes}'${seconds.toFixed(2)}`;
}

function formatGrid(label: string, x: number, y: number): string {
  return `${label}: X=${Math.round(x)}, Y=${Math.round(y)}`;
}

function formatMgrs(raw: string): string {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const match = compact.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d+)$/);

  if (!match) {
    return raw.trim().toUpperCase();
  }

  const [, zone, square, digits] = match;
  const half = Math.floor(digits.length / 2);
  const east = digits.slice(0, half);
  const north = digits.slice(half);
  return [zone, square, east, north].filter(Boolean).join(' ');
}
