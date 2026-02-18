import { toPoint } from 'mgrs';

export type Wgs84Coords = { lat: number; lng: number };

const LAT_LNG_MIN = 20;
const LAT_LNG_MAX = 60;


/** Match two decimal numbers in 20–60 with required decimal point and at least 4 digits after it */
const WGS84_NUMBERS = /^\s*((?:2[0-9]|[3-5]\d|60)\.\d{4,})\s*[,;\s]\s*((?:2[0-9]|[3-5]\d|60)\.\d{4,})\s*$/;

function isValidLat(n: number): boolean {
  return Number.isFinite(n) && n >= LAT_LNG_MIN && n <= LAT_LNG_MAX;
}

function isValidLng(n: number): boolean {
  return Number.isFinite(n) && n >= LAT_LNG_MIN && n <= LAT_LNG_MAX;
}

/**
 * Try to parse input as WGS84 decimal degrees (lat,lng or lng,lat).
 */
function parseWgs84Decimal(input: string): Wgs84Coords | null {
  const m = input.trim().match(WGS84_NUMBERS);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // If both fit in lat range, assume (lat, lng)
  if (isValidLat(a) && isValidLng(b)) return { lat: a, lng: b };
  if (isValidLng(a) && isValidLat(b)) return { lat: b, lng: a };
  return null;
}

/**
 * Try to parse input as MGRS.
 */
function parseMgrs(input: string): Wgs84Coords | null {
  const s = input.trim().replace(/\s+/g, '');
  if (s.length < 3) return null;
  // Basic MGRS shape: grid zone:bv + 100km square + numeric easting/northing
  if (!/^[0-9]{1,2}[A-Za-z]{3}[0-9]+$/.test(s)) return null;
  try {
    const [lng, lat] = toPoint(s);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Parse search input as coordinates.
 */
export function parseCoordinateInput(value: string): Wgs84Coords | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseWgs84Decimal(trimmed) ?? parseMgrs(trimmed);
}
