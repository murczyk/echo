import type { InboxMessage, PalitraReadV2 } from '../../../../../Bindings';

import {
  renderWgsFloat,
  extractCoordinates,
  convertCoordinateToWgs84,
} from '../../importer-beta/coordinates';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';
import { getPointEtalonsFromMessage } from '../../rer-duty-neo/utils';
import { listMapPalitrasV2, searchPalitraPoints } from '../../../services/api/palitra';

export type CoordinatePreviewSource = 'direct' | 'palitra';

export type CoordinatePreviewInput = {
  message: InboxMessage;
};

export type CoordinatePreviewResult = {
  source: CoordinatePreviewSource;
  point: {
    lat: number;
    lng: number;
    label: string;
  };
  mapSearch: string;
  etalons: string[];
  pointCount: number;
};

const AVAILABLE_PALITRA_IDS_KEY = 'coordinate-preview-available-palitras';

let availablePalitraIds: number[] | null = null;
let availablePalitraIdsPromise: Promise<number[]> | null = null;
const directCoordinateCache = new Map<string, CoordinatePreviewResult | null>();
const resolvedPointCache = new Map<string, CoordinatePreviewResult | null>();
const pendingResolvedPointRequests = new Map<string, Promise<CoordinatePreviewResult | null>>();

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
  availablePalitraIdsPromise = Promise.resolve(availablePalitraIds);
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

function formatDirectCoordinateLabel(lat: number, lng: number): string {
  return `${renderWgsFloat(lat)}, ${renderWgsFloat(lng)}`;
}

function formatDirectCoordinateSearch(lat: number, lng: number): string {
  return `${renderWgsFloat(lat)},${renderWgsFloat(lng)}`;
}

function createDirectCoordinateResult(lat: number, lng: number): CoordinatePreviewResult {
  return {
    source: 'direct',
    point: {
      lat,
      lng,
      label: formatDirectCoordinateLabel(lat, lng),
    },
    mapSearch: formatDirectCoordinateSearch(lat, lng),
    etalons: [],
    pointCount: 1,
  };
}

function resolveDirectCoordinateFromCoordinateText(
  rawText: string,
): CoordinatePreviewResult | null {
  const cacheKey = normalizeCoordinateSourceText(rawText);
  if (cacheKey === '') {
    return null;
  }
  if (directCoordinateCache.has(cacheKey)) {
    return directCoordinateCache.get(cacheKey) ?? null;
  }

  const parsed = parseCoordinateInput(cacheKey);
  if (parsed) {
    const result = createDirectCoordinateResult(parsed.lat, parsed.lng);
    directCoordinateCache.set(cacheKey, result);
    return result;
  }

  for (const coord of extractCoordinates(cacheKey)) {
    if (coord.kind === 'dms') {
      continue;
    }

    const latLng = convertCoordinateToWgs84(coord);
    if (!latLng) {
      continue;
    }

    const result = createDirectCoordinateResult(latLng.lat, latLng.lng);
    directCoordinateCache.set(cacheKey, result);
    return result;
  }

  directCoordinateCache.set(cacheKey, null);
  return null;
}

function collectDirectCoordinateCandidates(message: InboxMessage): string[] {
  return [message.coords ?? '', message.text ?? ''];
}

export function hasCoordinatePreviewCandidate(message: InboxMessage): boolean {
  const coords = message.coords?.trim() ?? '';
  if (coords !== '') {
    return true;
  }

  for (const rawText of collectDirectCoordinateCandidates(message)) {
    if (resolveDirectCoordinateFromCoordinateText(rawText) != null) {
      return true;
    }
  }

  return collectCoordinatePreviewEtalons(message).length > 0;
}

async function loadAvailablePalitraIds(): Promise<number[]> {
  if (availablePalitraIds != null) {
    return availablePalitraIds;
  }

  if (availablePalitraIdsPromise != null) {
    return availablePalitraIdsPromise;
  }

  availablePalitraIdsPromise = listMapPalitrasV2()
    .then((palitras) => {
      availablePalitraIds = normalizePalitraIds(
        palitras.map((palitraRead) => palitraRead.palitra.id),
      );
      return availablePalitraIds;
    })
    .catch((error) => {
      console.error('Failed to load map palitras for coordinate preview', error);
      availablePalitraIds = [];
      return availablePalitraIds;
    })
    .finally(() => {
      availablePalitraIdsPromise = null;
    });

  return availablePalitraIdsPromise;
}

async function resolvePointForEtalon(
  etalon: string,
  palitraIds: number[],
): Promise<CoordinatePreviewResult | null> {
  const cacheKey = `${getAvailablePalitraIdsKey(palitraIds)}:${normalizeEtalon(etalon).toLowerCase()}`;
  if (resolvedPointCache.has(cacheKey)) {
    return resolvedPointCache.get(cacheKey) ?? null;
  }

  const pending = pendingResolvedPointRequests.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = searchPalitraPoints(palitraIds, [normalizeEtalon(etalon)])
    .then((results) => {
      for (const result of results) {
        const point = result.points[0];
        if (!point) continue;
        const pointLabel = normalizeEtalon(point.label ?? '');
        if (pointLabel === '') continue;
        if (pointLabel.toLowerCase() !== normalizeEtalon(etalon).toLowerCase()) {
          continue;
        }
        const resolvedPoint: CoordinatePreviewResult = {
          source: 'palitra',
          point: {
            lat: point.coords.lat,
            lng: point.coords.lng,
            label: pointLabel,
          },
          mapSearch: normalizeEtalon(etalon),
          etalons: [normalizeEtalon(etalon)],
          pointCount: 1,
        };
        resolvedPointCache.set(cacheKey, resolvedPoint);
        return resolvedPoint;
      }

      resolvedPointCache.set(cacheKey, null);
      return null;
    })
    .catch((error) => {
      console.error('Failed to resolve coordinate preview point', error);
      resolvedPointCache.set(cacheKey, null);
      return null;
    })
    .finally(() => {
      pendingResolvedPointRequests.delete(cacheKey);
    });

  pendingResolvedPointRequests.set(cacheKey, request);
  return request;
}

export async function resolveMessageCoordinatePreview(
  input: CoordinatePreviewInput,
): Promise<CoordinatePreviewResult | null> {
  for (const rawText of collectDirectCoordinateCandidates(input.message)) {
    const directResult = resolveDirectCoordinateFromCoordinateText(rawText);
    if (directResult) {
      return directResult;
    }
  }

  const etalons = normalizeEtalons(getPointEtalonsFromMessage(input.message));
  if (etalons.length === 0) {
    return null;
  }

  const palitraIds = await loadAvailablePalitraIds();
  if (palitraIds.length === 0) {
    return null;
  }

  for (const etalon of etalons) {
    const point = await resolvePointForEtalon(etalon, palitraIds);
    if (point == null) {
      continue;
    }

    return {
      ...point,
      mapSearch: etalons.join(','),
      etalons,
      pointCount: etalons.length,
    };
  }

  return null;
}

export function collectCoordinatePreviewEtalons(message: InboxMessage): string[] {
  return normalizeEtalons(getPointEtalonsFromMessage(message));
}
