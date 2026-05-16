import { inverse } from 'mgrs';

import { td_usk2000_to_wgs84 } from '../../../utils';

export type Dms = {
  deg: number;
  min: number;
  sec: number;
};

export type ImporterCoordinate =
  | { kind: 'wgs84'; lat: number; lng: number }
  | { kind: 'dms'; lat: Dms; lng: Dms }
  | { kind: 'usk2000'; x: number; y: number }
  | { kind: 'mgrs'; value: string };

export type LatLng = {
  lat: number;
  lng: number;
};

function isFiniteLatLng(latLng: LatLng | null | undefined): latLng is LatLng {
  return Number.isFinite(latLng?.lat) && Number.isFinite(latLng?.lng);
}

const monkeyPrefix = '\u{1F648}';

function normalizeMgrsChar(char: string): string {
  switch (char) {
    case 'А':
      return 'A';
    case 'В':
      return 'B';
    case 'С':
      return 'C';
    case 'Е':
      return 'E';
    case 'Н':
      return 'H';
    case 'І':
      return 'I';
    case 'К':
      return 'K';
    case 'М':
      return 'M';
    case 'О':
      return 'O';
    case 'Р':
      return 'P';
    case 'Т':
      return 'T';
    case 'Х':
      return 'X';
    case 'У':
      return 'Y';
    case 'З':
      return 'Z';
    default:
      return char;
  }
}

function normalizeMgrsInput(input: string): string {
  return Array.from(input.toUpperCase()).map(normalizeMgrsChar).join('');
}

export function renderWgsFloat(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function renderDms(dms: Dms): string {
  return `${dms.deg}°${dms.min}'${dms.sec}`;
}

export function dmsToLatLng(dms: Dms): number {
  return dms.deg + dms.min / 60 + dms.sec / 3600;
}

export function renderCoordinate(coord: ImporterCoordinate): string {
  if (coord.kind === 'wgs84') return `${renderWgsFloat(coord.lat)}, ${renderWgsFloat(coord.lng)}`;
  if (coord.kind === 'dms') return `${renderDms(coord.lat)}, ${renderDms(coord.lng)}`;
  if (coord.kind === 'mgrs') return coord.value;

  const xBig = Math.floor(coord.x / 100000);
  const xRem = coord.x - xBig * 100000;
  const yBig = Math.floor(coord.y / 100000);
  const yRem = coord.y - yBig * 100000;
  return `${String(xBig).padStart(2, '0')}-${String(xRem).padStart(5, '0')} ${String(yBig).padStart(2, '0')}-${String(yRem).padStart(5, '0')}`;
}

function removeMatches(input: string, matches: RegExpMatchArray[]): string {
  return matches.reduce((acc, match) => acc.split(match[0]).join(''), input);
}

function toMatches(input: string, regex: RegExp): RegExpMatchArray[] {
  return Array.from(input.matchAll(regex));
}

function normalizeDecimal(value: string): number | null {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDmsSingle(value: string): Dms | null {
  const match = value.match(/(\d+)°(\d+)'(\d+\.?\d?\d?\d?\d?\d?\d?)/);
  if (!match) return null;
  const deg = Number(match[1]);
  const min = Number(match[2]);
  const sec = Number(match[3]);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return { deg, min, sec };
}

function parseLatLngMatches(matches: RegExpMatchArray[]): ImporterCoordinate[] {
  return matches.flatMap((match) => {
    const lat = normalizeDecimal(match[1] ?? '');
    const lng = normalizeDecimal(match[2] ?? '');
    if (lat === null || lng === null) return [];
    return [{ kind: 'wgs84', lat, lng } satisfies ImporterCoordinate];
  });
}

function parseDmsMatches(matches: RegExpMatchArray[]): ImporterCoordinate[] {
  return matches.flatMap((match) => {
    const lat = parseDmsSingle(match[1] ?? '');
    const lng = parseDmsSingle(match[2] ?? '');
    if (!lat || !lng) return [];
    return [{ kind: 'dms', lat, lng } satisfies ImporterCoordinate];
  });
}

function parseUskRegexMatches(matches: RegExpMatchArray[]): ImporterCoordinate[] {
  return matches.flatMap((match) => {
    const x = Number((match[1] ?? '').replace(/\D/g, ''));
    const y = Number((match[2] ?? '').replace(/\D/g, ''));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [{ kind: 'usk2000', x, y } satisfies ImporterCoordinate];
  });
}

function parseMgrsMatches(input: string): ImporterCoordinate[] {
  const matches = toMatches(input, /(\d\d[A-Z] ?[A-Z][A-Z] ?\d\d\d\d\d? ?\d? ?\d? ?\d? ?\d\d\d\d\d? ?\d? ?\d? ?\d?)/g);
  return matches.flatMap((match) => {
    const value = (match[1] ?? '').replaceAll(' ', '');
    return value ? [{ kind: 'mgrs', value } satisfies ImporterCoordinate] : [];
  });
}

type ParsedInt = {
  value: number;
  end: number;
};

function parseIntAt(input: string, index: number): ParsedInt | null {
  const match = input.slice(index).match(/^\d+/);
  if (!match) return null;
  return { value: Number(match[0]), end: index + match[0].length };
}

function parseXyPartAt(input: string, index: number): ParsedInt | null {
  const first = parseIntAt(input, index);
  if (!first) return null;

  if (first.value >= 3000000 && first.value < 9000000) return first;
  if (first.value < 30 || first.value >= 90) return null;

  const separator = input.slice(first.end).match(/^(?:[-\s]*)/);
  const afterSeparator = first.end + (separator?.[0].length ?? 0);
  const second = parseIntAt(input, afterSeparator);
  if (!second || second.value < 10000) return null;

  return {
    value: first.value * 100000 + second.value,
    end: second.end,
  };
}

function parseOneUsk2000(input: string): ImporterCoordinate | null {
  const firstDigitIndex = input.search(/\d/);
  if (firstDigitIndex < 0) return null;

  const x = parseXyPartAt(input, firstDigitIndex);
  if (!x) return null;

  const separator = input.slice(x.end).match(/^(?:\n|\s*)/);
  let yStart = x.end + (separator?.[0].length ?? 0);
  if (input.slice(yStart).startsWith('Y=')) yStart += 2;

  const y = parseXyPartAt(input, yStart);
  if (!y) return null;

  return { kind: 'usk2000', x: x.value, y: y.value };
}

function extractCoordinates1AndLeftover(input: string): [ImporterCoordinate[], string] {
  const s = monkeyPrefix + input;
  const latLngMatches = toMatches(s, /[^\d]([2-5]\d\.\d\d\d+)[^\d]*?([2-5]\d\.\d\d\d+)/g);
  const latLngCoords = parseLatLngMatches(latLngMatches);
  const s2 = removeMatches(s, latLngMatches);

  const dmsMatches = toMatches(s2, /[^\d](\d+°\d+'\d+\.?\d?\d?\d?\d?\d?\d?)[^\d]*(\d+°\d+'\d+\.?\d?\d?\d?\d?\d?\d?)/g);
  const dmsCoords = parseDmsMatches(dmsMatches);
  const s3 = removeMatches(s2, dmsMatches);

  const latLng2Matches = toMatches(s3, /[^\d]([2-5]\d[.,]\d\d\d+)[^\d]*?([2-5]\d[.,]\d\d\d+)/g);
  const latLng2Coords = parseLatLngMatches(latLng2Matches);

  const uskMatches = toMatches(s3, /[^\d]([4-6][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])\D+?([4-7][0-9][-‐–— ]?[0-9][0-9][0-9][0-9][0-9])/g);
  const uskCoords = parseUskRegexMatches(uskMatches);

  const mgrsCoords = parseMgrsMatches(normalizeMgrsInput(s));
  return [uniqueCoordinates([...latLngCoords, ...dmsCoords, ...uskCoords, ...latLng2Coords, ...mgrsCoords]), s3];
}

function coordKey(coord: ImporterCoordinate): string {
  if (coord.kind === 'wgs84') return `wgs84:${coord.lat}:${coord.lng}`;
  if (coord.kind === 'dms') return `dms:${coord.lat.deg}:${coord.lat.min}:${coord.lat.sec}:${coord.lng.deg}:${coord.lng.min}:${coord.lng.sec}`;
  if (coord.kind === 'usk2000') return `usk2000:${coord.x}:${coord.y}`;
  return `mgrs:${coord.value}`;
}

function uniqueCoordinates(coords: ImporterCoordinate[]): ImporterCoordinate[] {
  const seen = new Set<string>();
  const result: ImporterCoordinate[] = [];

  for (const coord of coords) {
    const key = coordKey(coord);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(coord);
  }

  return result;
}

export function extractCoordinates(input: string): ImporterCoordinate[] {
  const parsed = input.split(/\r?\n/).map(extractCoordinates1AndLeftover);
  const coords = parsed.flatMap(([lineCoords]) => lineCoords);
  const leftovers = parsed.map(([, leftover]) =>
    leftover.startsWith(monkeyPrefix) ? leftover.slice(monkeyPrefix.length) : leftover,
  );
  const multilineUsk = leftovers.flatMap((_, index) => {
    const coord = parseOneUsk2000(leftovers.slice(index).join('\n'));
    return coord ? [coord] : [];
  });

  return uniqueCoordinates([...coords, ...multilineUsk]);
}

export function coordinateToLatLng(coord: ImporterCoordinate, converted?: LatLng): LatLng | null {
  const latLng =
    coord.kind === 'wgs84'
      ? { lat: coord.lat, lng: coord.lng }
      : coord.kind === 'dms'
        ? { lat: dmsToLatLng(coord.lat), lng: dmsToLatLng(coord.lng) }
        : converted ?? null;

  return isFiniteLatLng(latLng) ? latLng : null;
}

export function convertCoordinateToWgs84(coord: ImporterCoordinate): LatLng | null {
  try {
    if (coord.kind === 'usk2000') {
      const result = td_usk2000_to_wgs84({ x: coord.x, y: coord.y });
      return coordinateToLatLng({ kind: 'wgs84', lat: result.x, lng: result.y });
    }
    if (coord.kind === 'mgrs') {
      const result = inverse(coord.value);
      return coordinateToLatLng({ kind: 'wgs84', lat: result[1], lng: result[0] });
    }
  } catch (_) {
    return null;
  }
  return coordinateToLatLng(coord);
}
