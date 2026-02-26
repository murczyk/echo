import type { PalitraPoint } from '../palitra-types';

export type SearchResultChunk = { palitra_id: number; points: PalitraPoint[] };

/** Bounds-like interface for viewport culling (testable without Leaflet). */
export interface BoundsLike {
  contains(latLng: [number, number]): boolean;
}

/**
 * Keep at most maxPoints total across palitras (takes first points across list).
 * Used to cap rendered markers for performance.
 */
export function truncateToMaxRendered(
  data: SearchResultChunk[],
  maxPoints: number
): SearchResultChunk[] {
  const flat: { palitra_id: number; point: PalitraPoint }[] = [];
  for (const { palitra_id, points } of data) {
    for (const point of points) {
      flat.push({ palitra_id, point });
      if (flat.length >= maxPoints) break;
    }
    if (flat.length >= maxPoints) break;
  }
  const byPalitra = new Map<number, PalitraPoint[]>();
  for (const { palitra_id, point } of flat) {
    const list = byPalitra.get(palitra_id) ?? [];
    list.push(point);
    byPalitra.set(palitra_id, list);
  }
  return Array.from(byPalitra.entries()).map(([palitra_id, points]) => ({
    palitra_id,
    points,
  }));
}

/**
 * Filter points to those inside the given bounds. Used for viewport culling
 * so we only render markers in view (and re-run on pan/zoom).
 */
export function cullSearchResultsToViewport(
  data: SearchResultChunk[],
  bounds: BoundsLike
): SearchResultChunk[] {
  return data.map(({ palitra_id, points }) => ({
    palitra_id,
    points: points.filter((p) => bounds.contains([p.coords.lat, p.coords.lng])),
  }));
}
