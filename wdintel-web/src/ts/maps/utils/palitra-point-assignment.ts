import { Coords, Palitra, PalitraPoint } from '../palitra-types';

type SearchEntry = { palitra_id: number; points: PalitraPoint[] };

export function splitEntriesByGeometry(
  entries: SearchEntry[],
  palitrasByApiId: Map<number, Palitra[]>,
  visiblePalitraIdsSet?: Set<number>,
): Array<{ palitra: Palitra; points: PalitraPoint[] }> {
  const splitEntries: Array<{ palitra: Palitra; points: PalitraPoint[] }> = [];
  const shouldIncludePalitra = (palitraId: number) =>
    visiblePalitraIdsSet ? visiblePalitraIdsSet.has(palitraId) : true;

  entries.forEach(({ palitra_id, points }) => {
    // Single API palitra may map to multiple geometries/colors in UI.
    const palitras = palitrasByApiId.get(palitra_id);
    if (!palitras || palitras.length === 0) {
      return;
    }

    if (palitras.length === 1) {
      if (shouldIncludePalitra(palitras[0].id)) {
        splitEntries.push({ palitra: palitras[0], points });
      }
      return;
    }

    const pointsByPalitraId = new Map<number, PalitraPoint[]>();
    palitras.forEach((palitra) => {
      pointsByPalitraId.set(palitra.id, []);
    });

    const fallbackPalitra = pickFallbackPalitraForUnmatched(palitras);
    const visibleFallbackPalitra =
      fallbackPalitra && shouldIncludePalitra(fallbackPalitra.id) ? fallbackPalitra : null;
    const preserveUnmatchedPalitra =
      palitras.find((palitra) => shouldIncludePalitra(palitra.id)) ?? palitras[0] ?? null;

    points.forEach((point) => {
      // Best-effort routing:
      // 1) exact geometry hit
      // 2) explicit fallback geometry (if unique)
      // 3) first allowed geometry to avoid dropping unmatched points
      const matchedPalitra =
        findPalitraForPoint(palitras, point) ?? visibleFallbackPalitra ?? preserveUnmatchedPalitra;
      if (!matchedPalitra) {
        return;
      }
      const bucket = pointsByPalitraId.get(matchedPalitra.id);
      if (!bucket) {
        return;
      }
      bucket.push(point);
    });

    palitras.forEach((palitra) => {
      if (!shouldIncludePalitra(palitra.id)) {
        return;
      }
      const palitraPoints = pointsByPalitraId.get(palitra.id);
      if (!palitraPoints || palitraPoints.length === 0) {
        return;
      }
      splitEntries.push({ palitra, points: palitraPoints });
    });
  });

  return splitEntries;
}

function findPalitraForPoint(palitras: Palitra[], point: PalitraPoint): Palitra | null {
  for (const palitra of palitras) {
    const perimeter = palitra.geometry?.perimeter_linear_ring;
    if (!perimeter || perimeter.length < 3) {
      continue;
    }
    if (isPointInPerimeter(point.coords, perimeter)) {
      return palitra;
    }
  }

  return null;
}

function pickFallbackPalitraForUnmatched(palitras: Palitra[]): Palitra | null {
  const palitrasWithoutPerimeter = palitras.filter((palitra) => {
    const perimeter = palitra.geometry?.perimeter_linear_ring;
    return !perimeter || perimeter.length < 3;
  });

  if (palitrasWithoutPerimeter.length === 1) {
    return palitrasWithoutPerimeter[0];
  }

  return null;
}

function isPointInPerimeter(point: Coords, perimeter: Coords[]): boolean {
  let inside = false;
  for (let i = 0, j = perimeter.length - 1; i < perimeter.length; j = i++) {
    const latI = perimeter[i].lat;
    const lngI = perimeter[i].lng;
    const latJ = perimeter[j].lat;
    const lngJ = perimeter[j].lng;

    const intersects =
      lngI > point.lng !== lngJ > point.lng &&
      point.lat < ((latJ - latI) * (point.lng - lngI)) / (lngJ - lngI) + latI;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}
