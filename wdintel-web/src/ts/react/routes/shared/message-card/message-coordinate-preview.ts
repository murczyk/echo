import type {
  InboxMessage,
  LocalityDetails,
  MediaSummaryCoordinate,
  PalitraReadV2,
  Tag,
} from '../../../../../Bindings';

import {
  renderWgsFloat,
  extractCoordinates,
  convertCoordinateToWgs84,
  isValidUsk2000Component,
} from '../../importer-beta/coordinates';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';
import { parseCoordinateBlock } from '../../../../maps/coordinate-parser';
import { getPointEtalonsFromMessage } from '../../rer-duty-neo/utils';
import { getMediaSummaryCoordinates } from '../../../services/api/media-summary';
import { listMapPalitrasV2, searchPalitraPoints } from '../../../services/api/palitra';

export type CoordinatePreviewSource = 'direct' | 'palitra' | 'document';

export type CoordinatePreviewPoint = {
  source: CoordinatePreviewSource;
  lat: number;
  lng: number;
  label: string;
  description?: string;
  plannedMeans?: string | null;
  locality?: LocalityDetails | null;
};

export function formatCoordinatePreviewPointCount(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastDigit === 1 && lastTwoDigits !== 11) {
    return `${count} точка`;
  }

  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} точки`;
  }

  return `${count} точок`;
}

export type CoordinatePreviewInput = {
  message: InboxMessage;
  tagsMap?: Record<number, Tag>;
};

export type CoordinatePreviewLookupErrorKind =
  'palette-list' | 'point-search' | 'document-coordinates';

export class CoordinatePreviewLookupError extends Error {
  readonly kind: CoordinatePreviewLookupErrorKind;

  readonly cause: unknown;

  constructor(kind: CoordinatePreviewLookupErrorKind, cause: unknown) {
    super('Не вдалося завантажити точку мапи');
    this.name = 'CoordinatePreviewLookupError';
    this.kind = kind;
    this.cause = cause;
  }
}

export type CoordinatePreviewResult = {
  points: CoordinatePreviewPoint[];
  etalons: string[];
  lookupError: CoordinatePreviewLookupError | null;
};

const AVAILABLE_PALITRA_IDS_KEY = 'coordinate-preview-available-palitras';
const UTM_CANDIDATE_PATTERN =
  /(^|[^A-Za-z0-9])((?:[1-9]|[1-5]\d|60)[C-HJ-NP-X]\s+\d{6}\s+\d{7})(?=$|[^A-Za-z0-9])/g;
const PREVIEW_USK_VALUE_PATTERN = '(?:\\d{7}|\\d{2}[-‐–— ]\\d{5})';
const PREVIEW_USK_LABELLED_PAIR_PATTERN = new RegExp(
  String.raw`(^|[^A-Za-z0-9])([XХxх])\s*(?:[:=\-]\s*)?(?<x>${PREVIEW_USK_VALUE_PATTERN})[\s/,;]+([YУyу])\s*(?:[:=\-]\s*)?(?<y>${PREVIEW_USK_VALUE_PATTERN})(?=$|[^A-Za-z0-9])`,
  'g',
);
const PREVIEW_USK_VALUE_REGEX = new RegExp(PREVIEW_USK_VALUE_PATTERN, 'g');

let availablePalitraIds: number[] | null = null;
let availablePalitraIdsPromise: Promise<{
  palitraIds: number[];
  lookupError: CoordinatePreviewLookupError | null;
}> | null = null;
const directCoordinateCache = new Map<string, CoordinatePreviewPoint[] | null>();
const resolvedPointCache = new Map<string, CoordinatePreviewPoint | null>();
const pendingResolvedPointRequests = new Map<string, Promise<ResolvePointResult>>();

type ResolvePointResult = {
  point: CoordinatePreviewPoint | null;
  lookupError: CoordinatePreviewLookupError | null;
};

function normalizeEtalon(value: string): string {
  return value.trim();
}

function normalizeEtalons(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeEtalon).filter((value) => value !== '')));
}

function normalizePalitraIds(palitras: number[]): number[] {
  return Array.from(
    new Set(palitras.filter((value) => Number.isInteger(value)).map((value) => Number(value))),
  ).sort((left, right) => left - right);
}

function getAvailablePalitraIdsKey(palitraIds: number[]): string {
  return `${AVAILABLE_PALITRA_IDS_KEY}:${normalizePalitraIds(palitraIds).join(',')}`;
}

export function primeCoordinatePreviewPalitraIds(palitras: PalitraReadV2[]): void {
  availablePalitraIds = normalizePalitraIds(palitras.map((palitraRead) => palitraRead.palitra.id));
  availablePalitraIdsPromise = Promise.resolve({
    palitraIds: availablePalitraIds,
    lookupError: null,
  });
}

export function resetCoordinatePreviewStateForTests(): void {
  availablePalitraIds = null;
  availablePalitraIdsPromise = null;
  directCoordinateCache.clear();
  resolvedPointCache.clear();
  pendingResolvedPointRequests.clear();
}

function normalizeCoordinateSourceText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/(^|[\s\r\n])([хx])=/giu, '$1X=')
    .replace(/(^|[\s\r\n])([уy])=/giu, '$1Y=')
    .trim();
}

type PreviewUskPair = {
  x: number;
  y: number;
  sourceKey: string;
  startIndex: number;
  endIndex: number;
};

type SourceRange = {
  start: number;
  end: number;
};

function parsePreviewUskValue(valueText: string): number | null {
  const compact = valueText.replace(/\s+/g, '');
  if (/^\d{7}$/.test(compact)) {
    const value = Number(compact);
    return isValidUsk2000Component(value) ? value : null;
  }

  const compactMatch = compact.match(/^(\d{2})[-‐–—]?(\d{5})$/);
  if (!compactMatch) {
    return null;
  }

  const value = Number(`${compactMatch[1]}${compactMatch[2]}`);
  return isValidUsk2000Component(value) ? value : null;
}

function isRangeConsumed(range: SourceRange, consumedRanges: SourceRange[]): boolean {
  return consumedRanges.some(
    (consumedRange) => range.start < consumedRange.end && range.end > consumedRange.start,
  );
}

function extractPreviewUskPairs(text: string): PreviewUskPair[] {
  const normalizedText = normalizeCoordinateSourceText(text);
  if (normalizedText === '') {
    return [];
  }

  const candidatePairs: PreviewUskPair[] = [];
  const consumedRanges: SourceRange[] = [];

  for (const match of normalizedText.matchAll(PREVIEW_USK_LABELLED_PAIR_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const prefixLength = match[1]?.length ?? 0;
    const startIndex = matchIndex + prefixLength;
    const endIndex = matchIndex + match[0].length;
    const xValue = parsePreviewUskValue(match.groups?.x ?? '');
    const yValue = parsePreviewUskValue(match.groups?.y ?? '');
    if (xValue == null || yValue == null) {
      continue;
    }

    consumedRanges.push({ start: startIndex, end: endIndex });
    candidatePairs.push({
      x: xValue,
      y: yValue,
      sourceKey: `usk:${xValue}:${yValue}`,
      startIndex,
      endIndex,
    });
  }

  const remainingValues: Array<{ value: number; startIndex: number; endIndex: number }> = [];
  for (const match of normalizedText.matchAll(PREVIEW_USK_VALUE_REGEX)) {
    const startIndex = match.index ?? 0;
    const endIndex = startIndex + match[0].length;
    if (isRangeConsumed({ start: startIndex, end: endIndex }, consumedRanges)) {
      continue;
    }

    const value = parsePreviewUskValue(match[0]);
    if (value == null) {
      continue;
    }

    remainingValues.push({ value, startIndex, endIndex });
  }

  for (let index = 0; index < remainingValues.length - 1; index += 1) {
    const left = remainingValues[index];
    const right = remainingValues[index + 1];
    if (!/^\s+$/.test(normalizedText.slice(left.endIndex, right.startIndex))) {
      continue;
    }

    candidatePairs.push({
      x: left.value,
      y: right.value,
      sourceKey: `usk:${left.value}:${right.value}`,
      startIndex: left.startIndex,
      endIndex: right.endIndex,
    });
    index += 1;
  }

  const result: PreviewUskPair[] = [];
  const seenSourceKeys = new Set<string>();
  for (const pair of candidatePairs.sort((left, right) => left.startIndex - right.startIndex)) {
    if (seenSourceKeys.has(pair.sourceKey)) {
      continue;
    }

    seenSourceKeys.add(pair.sourceKey);
    result.push(pair);
  }

  return result;
}

function coordinatePointKey(point: { lat: number; lng: number }): string {
  return `${renderWgsFloat(point.lat)}:${renderWgsFloat(point.lng)}`;
}

function createDirectCoordinatePoint(
  lat: number,
  lng: number,
  locality?: LocalityDetails | null,
): CoordinatePreviewPoint {
  return {
    source: 'direct',
    lat,
    lng,
    label: formatDirectCoordinateLabel(lat, lng),
    locality,
  };
}

function resolveDirectCoordinatesFromCoordinateText(rawText: string): CoordinatePreviewPoint[] {
  const normalizedText = normalizeCoordinateSourceText(rawText);
  if (normalizedText === '') {
    return [];
  }

  const points: CoordinatePreviewPoint[] = [];
  const seen = new Set<string>();

  if (directCoordinateCache.has(normalizedText)) {
    const cached = directCoordinateCache.get(normalizedText);
    if (cached != null) {
      return cached;
    }

    return [];
  }

  const parsed = parseCoordinateInput(normalizedText);
  if (parsed) {
    const point = createDirectCoordinatePoint(parsed.lat, parsed.lng);
    const key = coordinatePointKey(point);
    seen.add(key);
    points.push(point);
  }

  for (const coord of extractCoordinates(normalizedText)) {
    if (coord.kind === 'usk2000') {
      continue;
    }

    if (coord.kind === 'dms' && !isValidPreviewDmsCoordinate(coord)) {
      continue;
    }

    const latLng = convertCoordinateToWgs84(coord);
    if (!latLng) {
      continue;
    }

    const point = createDirectCoordinatePoint(latLng.lat, latLng.lng);
    const key = coordinatePointKey(point);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    points.push(point);
  }

  for (const match of normalizedText.matchAll(UTM_CANDIDATE_PATTERN)) {
    const parsedUtm = parseCoordinateInput(match[2]);
    if (!parsedUtm) {
      continue;
    }

    const point = createDirectCoordinatePoint(parsedUtm.lat, parsedUtm.lng);
    const key = coordinatePointKey(point);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    points.push(point);
  }

  for (const uskPair of extractPreviewUskPairs(normalizedText)) {
    const latLng = convertCoordinateToWgs84({ kind: 'usk2000', x: uskPair.x, y: uskPair.y });
    if (!latLng) {
      continue;
    }

    const point = createDirectCoordinatePoint(latLng.lat, latLng.lng);
    const key = coordinatePointKey(point);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    points.push(point);
  }

  directCoordinateCache.set(normalizedText, points.length > 0 ? points : null);

  return points;
}

function isValidPreviewDmsValue(value: { deg: number; min: number; sec: number }, maxDeg: number) {
  return (
    Number.isFinite(value.deg) &&
    Number.isFinite(value.min) &&
    Number.isFinite(value.sec) &&
    value.deg >= 0 &&
    value.deg <= maxDeg &&
    value.min >= 0 &&
    value.min < 60 &&
    value.sec >= 0 &&
    value.sec < 60
  );
}

function isValidPreviewDmsCoordinate(coord: {
  lat: { deg: number; min: number; sec: number };
  lng: { deg: number; min: number; sec: number };
}) {
  return isValidPreviewDmsValue(coord.lat, 90) && isValidPreviewDmsValue(coord.lng, 180);
}

function formatDirectCoordinateLabel(lat: number, lng: number): string {
  return `${renderWgsFloat(lat)}, ${renderWgsFloat(lng)}`;
}

export function resolveDirectMessageCoordinatePreviewPoints(
  message: InboxMessage,
): CoordinatePreviewPoint[] {
  if ((message.coordsWithLocality?.length ?? 0) > 0) {
    return message.coordsWithLocality.map(({ coords, locality }) =>
      createDirectCoordinatePoint(coords.lat, coords.lon, locality),
    );
  }

  const textPoints = resolveDirectCoordinatesFromCoordinateText(message.text ?? '');
  if (textPoints.length > 0) {
    return textPoints;
  }

  return resolveDirectCoordinatesFromCoordinateText(message.coords ?? '');
}

function resolveCoordinateSummaryMediaCount(message: InboxMessage): number {
  return new Set(
    (message.media ?? []).flatMap((media) =>
      media.id != null && media.summary?.state === 'completed' && media.summary.hasCoordinates
        ? [String(media.id)]
        : [],
    ),
  ).size;
}

export function resolveMessageCoordinatePreviewSummaryCount(
  message: InboxMessage,
  tagsMap: Record<number, Tag> = {},
): number {
  const directPoints = resolveDirectMessageCoordinatePreviewPoints(message);
  if (directPoints.length > 0) return directPoints.length;

  const summaryMediaCount = resolveCoordinateSummaryMediaCount(message);
  if (summaryMediaCount > 0) return summaryMediaCount;

  return collectCoordinatePreviewEtalons(message, tagsMap).length;
}

export function hasCoordinatePreviewCandidate(
  message: InboxMessage,
  tagsMap: Record<number, Tag> = {},
): boolean {
  if ((message.coordsWithLocality?.length ?? 0) > 0) {
    return true;
  }

  if (resolveDirectCoordinatesFromCoordinateText(message.text ?? '').length > 0) {
    return true;
  }

  if (resolveDirectCoordinatesFromCoordinateText(message.coords ?? '').length > 0) {
    return true;
  }

  if (
    (message.media ?? []).some(
      (media) =>
        media.id != null && media.summary?.state === 'completed' && media.summary.hasCoordinates,
    )
  ) {
    return true;
  }

  return collectCoordinatePreviewEtalons(message, tagsMap).length > 0;
}

async function loadAvailablePalitraIds(): Promise<{
  palitraIds: number[];
  lookupError: CoordinatePreviewLookupError | null;
}> {
  if (availablePalitraIds != null) {
    return {
      palitraIds: availablePalitraIds,
      lookupError: null,
    };
  }

  if (availablePalitraIdsPromise != null) {
    return availablePalitraIdsPromise;
  }

  availablePalitraIdsPromise = listMapPalitrasV2()
    .then((palitras) => {
      availablePalitraIds = normalizePalitraIds(
        palitras.map((palitraRead) => palitraRead.palitra.id),
      );
      return {
        palitraIds: availablePalitraIds,
        lookupError: null,
      };
    })
    .catch((error) => {
      console.error(error);
      availablePalitraIds = null;
      return {
        palitraIds: [],
        lookupError: new CoordinatePreviewLookupError('palette-list', error),
      };
    })
    .finally(() => {
      availablePalitraIdsPromise = null;
    });

  return availablePalitraIdsPromise;
}

async function resolvePointForEtalon(
  etalon: string,
  palitraIds: number[],
): Promise<ResolvePointResult> {
  const cacheKey = `${getAvailablePalitraIdsKey(palitraIds)}:${normalizeEtalon(etalon).toLowerCase()}`;
  if (resolvedPointCache.has(cacheKey)) {
    return {
      point: resolvedPointCache.get(cacheKey) ?? null,
      lookupError: null,
    };
  }

  const pending = pendingResolvedPointRequests.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request: Promise<ResolvePointResult> = searchPalitraPoints(palitraIds, [
    normalizeEtalon(etalon),
  ])
    .then((results) => {
      for (const result of results) {
        const point = result.points[0];
        if (!point) continue;
        const pointLabel = normalizeEtalon(point.label ?? '');
        if (pointLabel === '') continue;
        if (pointLabel.toLowerCase() !== normalizeEtalon(etalon).toLowerCase()) {
          continue;
        }
        const resolvedPoint: CoordinatePreviewPoint = {
          source: 'palitra',
          lat: point.coords.lat,
          lng: point.coords.lng,
          label: pointLabel,
        };
        resolvedPointCache.set(cacheKey, resolvedPoint);
        return { point: resolvedPoint, lookupError: null };
      }

      resolvedPointCache.set(cacheKey, null);
      return { point: null, lookupError: null };
    })
    .catch((error) => {
      console.error(error);
      return {
        point: null,
        lookupError: new CoordinatePreviewLookupError('point-search', error),
      };
    })
    .finally(() => {
      pendingResolvedPointRequests.delete(cacheKey);
    });

  pendingResolvedPointRequests.set(cacheKey, request);
  return request;
}

async function resolveExistingMessageCoordinatePreview(
  input: CoordinatePreviewInput,
): Promise<CoordinatePreviewResult | null> {
  const directPoints = resolveDirectMessageCoordinatePreviewPoints(input.message);

  if (directPoints.length > 0) {
    return {
      points: directPoints,
      etalons: [],
      lookupError: null,
    };
  }

  const etalons = normalizeEtalons(getPointEtalonsFromMessage(input.message, input.tagsMap ?? {}));
  if (etalons.length === 0) {
    return null;
  }

  const { palitraIds, lookupError: paletteLookupError } = await loadAvailablePalitraIds();
  if (paletteLookupError != null) {
    return {
      points: [],
      etalons,
      lookupError: paletteLookupError,
    };
  }

  if (palitraIds.length === 0) {
    return null;
  }

  const points: CoordinatePreviewPoint[] = [];
  const palitraSeen = new Set<string>();
  let lookupError: CoordinatePreviewLookupError | null = null;

  for (const etalon of etalons) {
    const result = await resolvePointForEtalon(etalon, palitraIds);
    if (result.lookupError != null && lookupError == null) {
      lookupError = result.lookupError;
    }

    if (result.point == null) {
      continue;
    }

    const pointKey = coordinatePointKey(result.point);
    if (palitraSeen.has(pointKey)) {
      continue;
    }

    palitraSeen.add(pointKey);
    points.push(result.point);
  }

  if (points.length === 0 && lookupError == null) {
    return null;
  }

  return {
    points,
    etalons,
    lookupError,
  };
}

function documentCoordinateSource(coordinate: MediaSummaryCoordinate): string {
  if (coordinate.coordinateSystem === 'sk42') return `СК-42: ${coordinate.value}`;
  if (coordinate.coordinateSystem === 'usk2000') return `УСК-2000: ${coordinate.value}`;
  return coordinate.value;
}

export function resolveMediaSummaryCoordinatePoint(
  coordinate: MediaSummaryCoordinate,
): CoordinatePreviewPoint | null {
  const point = parseCoordinateBlock(documentCoordinateSource(coordinate))[0];
  if (point == null || point.format !== coordinate.coordinateSystem) return null;
  return {
    source: 'document',
    lat: point.lat,
    lng: point.lng,
    label: coordinate.title,
    description: coordinate.description ?? '',
    plannedMeans: coordinate.plannedMeans ?? null,
  };
}

async function resolveDocumentCoordinatePoints(message: InboxMessage): Promise<{
  points: CoordinatePreviewPoint[];
  lookupError: CoordinatePreviewLookupError | null;
}> {
  const mediaIds = Array.from(
    new Set(
      (message.media ?? []).flatMap((media) =>
        media.id != null && media.summary?.state === 'completed' && media.summary.hasCoordinates
          ? [media.id]
          : [],
      ),
    ),
  );
  if (mediaIds.length === 0) return { points: [], lookupError: null };

  const results = await Promise.all(
    mediaIds.map(async (mediaId) => {
      try {
        const result = await getMediaSummaryCoordinates(mediaId);
        return {
          points: result.coordinates.flatMap((coordinate) => {
            const point = resolveMediaSummaryCoordinatePoint(coordinate);
            return point == null ? [] : [point];
          }),
          error: null,
        };
      } catch (error) {
        return { points: [], error };
      }
    }),
  );
  const failed = results.find((result) => result.error != null);
  return {
    points: results.flatMap((result) => result.points),
    lookupError:
      failed == null
        ? null
        : new CoordinatePreviewLookupError('document-coordinates', failed.error),
  };
}

export async function resolveMessageCoordinatePreview(
  input: CoordinatePreviewInput,
): Promise<CoordinatePreviewResult | null> {
  const [existing, document] = await Promise.all([
    resolveExistingMessageCoordinatePreview(input),
    resolveDocumentCoordinatePoints(input.message),
  ]);
  const points: CoordinatePreviewPoint[] = [];
  const seen = new Set<string>();
  for (const point of [...(existing?.points ?? []), ...document.points]) {
    const key = coordinatePointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(point);
  }
  const lookupError = existing?.lookupError ?? document.lookupError;
  if (points.length === 0 && lookupError == null) return null;
  return {
    points,
    etalons: existing?.etalons ?? [],
    lookupError,
  };
}

export function collectCoordinatePreviewEtalons(
  message: InboxMessage,
  tagsMap: Record<number, Tag> = {},
): string[] {
  return normalizeEtalons(getPointEtalonsFromMessage(message, tagsMap));
}
