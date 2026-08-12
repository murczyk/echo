import {
  convertCoordinateToWgs84,
  extractCoordinates,
  renderCoordinate,
  type ImporterCoordinate,
} from '../react/routes/importer-beta/coordinates';
import { td_sk42_to_wgs84 } from '../utils';
import { parseCoordinateInput } from './coordinate-search';

export type CoordinateInputFormat = 'wgs84' | 'dms' | 'mgrs' | 'utm' | 'sk42' | 'usk2000';

export type ParsedCoordinate = {
  lat: number;
  lng: number;
  format: CoordinateInputFormat;
  source: string;
};

const GRID_VALUE = String.raw`(?:\d{7}(?:\.\d+)?|\d{2}[-‐–— ]\d{5}(?:\.\d+)?)`;
const SK42_PATTERN = new RegExp(
  String.raw`(?:МСК|СК|SK)\s*[-‑]?\s*42\s*:?\s*(?:[XХxх]\s*=?\s*)?(?<x>${GRID_VALUE})\s*[,;/\s]+\s*(?:[YУyу]\s*=?\s*)?(?<y>${GRID_VALUE})`,
  'giu',
);
const USK2000_FULL_PATTERN = new RegExp(
  String.raw`^(?:УСК\s*[-‑]?\s*2000\s*:?\s*)?(?:[XХxх]\s*=?\s*)?${GRID_VALUE}\s*[,;/\s]+\s*(?:[YУyу]\s*=?\s*)?${GRID_VALUE}$`,
  'iu',
);
const DMS_VALUE = String.raw`-?\d{1,3}°\d{1,2}'\d+(?:\.\d+)?["″”]?`;
const DMS_FULL_PATTERN = new RegExp(
  String.raw`^${DMS_VALUE}\s*[NSEWСЮВЗ]?\s*[,;/\s]+\s*${DMS_VALUE}\s*[NSEWСЮВЗ]?$`,
  'iu',
);

function parseGridValue(value: string): number | null {
  const parsed = Number(value.replace(/[-‐–—\s]/g, ''));
  return Number.isFinite(parsed) && parsed >= 3000000 && parsed < 9000000 ? parsed : null;
}

function validLatLng(coords: { lat: number; lng: number } | null): coords is {
  lat: number;
  lng: number;
} {
  return (
    coords != null &&
    Number.isFinite(coords.lat) &&
    Number.isFinite(coords.lng) &&
    coords.lat >= -90 &&
    coords.lat <= 90 &&
    coords.lng >= -180 &&
    coords.lng <= 180
  );
}

function importerFormat(coord: ImporterCoordinate): CoordinateInputFormat {
  return coord.kind === 'wgs84' ? 'wgs84' : coord.kind;
}

function pointKey(coords: { lat: number; lng: number }): string {
  return `${coords.lat.toFixed(7)}:${coords.lng.toFixed(7)}`;
}

function coordinateSourcePosition(input: string, coord: ImporterCoordinate): number {
  const rendered = renderCoordinate(coord);
  const renderedPosition = input.indexOf(rendered);
  if (renderedPosition >= 0) return renderedPosition;

  if (coord.kind === 'usk2000') {
    const rawPosition = input.indexOf(String(coord.x));
    if (rawPosition >= 0) return rawPosition;
    const splitPosition = input.indexOf(rendered.split(/\s/)[0] ?? '');
    if (splitPosition >= 0) return splitPosition;
  }

  return -1;
}

export function parseCoordinateBlock(value: string): ParsedCoordinate[] {
  const input = value.replace(/\r\n?/g, '\n').trim();
  if (!input) return [];

  const candidates: Array<{ coords: ParsedCoordinate; position: number; order: number }> = [];
  let order = 0;
  const add = (coords: ParsedCoordinate, position: number) => {
    if (!validLatLng(coords)) return;
    candidates.push({ coords, position, order });
    order += 1;
  };

  const masked = Array.from(input.matchAll(SK42_PATTERN)).reduce((text, match) => {
    const x = parseGridValue(match.groups?.x ?? '');
    const y = parseGridValue(match.groups?.y ?? '');
    if (x == null || y == null) return text;
    const converted = td_sk42_to_wgs84({ x, y });
    if (converted) {
      add(
        {
          lat: converted.x,
          lng: converted.y,
          format: 'sk42',
          source: match[0].trim(),
        },
        match.index ?? 0,
      );
    }
    const start = match.index ?? 0;
    return `${text.slice(0, start)}${match[0].replace(/[^\n]/g, ' ')}${text.slice(start + match[0].length)}`;
  }, input);

  let lineOffset = 0;
  for (const line of masked.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      lineOffset += line.length + 1;
      continue;
    }
    const contentOffset = lineOffset + line.indexOf(trimmed);

    const direct = parseCoordinateInput(trimmed);
    if (direct) {
      const format = /^\d{1,2}[C-HJ-NP-X]\s+\d{6}\s+\d{7}$/i.test(trimmed)
        ? 'utm'
        : /[A-Z]{3}/i.test(trimmed.replace(/\s+/g, ''))
          ? 'mgrs'
          : 'wgs84';
      add({ ...direct, format, source: trimmed }, contentOffset);
      lineOffset += line.length + 1;
      continue;
    }

    for (const [index, coord] of extractCoordinates(trimmed).entries()) {
      const converted = convertCoordinateToWgs84(coord);
      if (!validLatLng(converted)) continue;
      const sourcePosition = coordinateSourcePosition(trimmed, coord);
      add(
        {
          ...converted,
          format: importerFormat(coord),
          source: renderCoordinate(coord),
        },
        contentOffset + (sourcePosition >= 0 ? sourcePosition : index / 1000),
      );
    }
    lineOffset += line.length + 1;
  }

  for (const coord of extractCoordinates(masked)) {
    if (coord.kind !== 'usk2000') continue;
    const converted = convertCoordinateToWgs84(coord);
    if (!validLatLng(converted)) continue;
    add(
      {
        ...converted,
        format: 'usk2000',
        source: renderCoordinate(coord),
      },
      Math.max(0, coordinateSourcePosition(masked, coord)),
    );
  }

  const seen = new Set<string>();
  return candidates
    .sort((left, right) => left.position - right.position || left.order - right.order)
    .flatMap(({ coords }) => {
      const key = pointKey(coords);
      if (seen.has(key)) return [];
      seen.add(key);
      return [coords];
    });
}

function isWholeCoordinateEntry(value: string): boolean {
  const input = value.trim();
  if (!input) return false;
  if (parseCoordinateInput(input)) return true;

  const points = parseCoordinateBlock(input);
  const [point] = points;
  if (points.length === 1 && point) {
    if (point.format === 'sk42' && point.source === input) return true;
    if (point.format === 'dms' && DMS_FULL_PATTERN.test(input)) return true;
    if (point.format === 'usk2000' && USK2000_FULL_PATTERN.test(input)) return true;
  }

  const entries = input.split(';').map((entry) => entry.trim());
  return entries.length > 1 && entries.every(isWholeCoordinateEntry);
}

export function isCoordinateBlockFullyParsed(value: string): boolean {
  const entries = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;

  for (let index = 0; index < entries.length; index += 1) {
    if (isWholeCoordinateEntry(entries[index])) continue;

    const nextEntry = entries[index + 1];
    if (nextEntry && isWholeCoordinateEntry(`${entries[index]}\n${nextEntry}`)) {
      index += 1;
      continue;
    }

    return false;
  }

  return true;
}
