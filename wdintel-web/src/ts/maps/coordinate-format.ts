import { forward } from 'mgrs';

export type CoordFormat = 'mgrs' | 'wgs';

export type Wgs84Coords = {
  lat: number;
  lng: number;
};

export function getCoordinateText(format: CoordFormat, coords: Wgs84Coords, mgrsCoords?: string | null): string {
  if (format === 'wgs') {
    return formatWgs84(coords);
  }

  if (mgrsCoords) {
    return formatMgrs(mgrsCoords);
  }

  try {
    return formatMgrs(forward([coords.lng, coords.lat]));
  } catch (_error) {
    return formatWgs84(coords);
  }
}

function formatWgs84(coords: Wgs84Coords): string {
  return `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
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
