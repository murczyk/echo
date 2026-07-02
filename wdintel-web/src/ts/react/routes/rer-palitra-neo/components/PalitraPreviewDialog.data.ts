import type {
  Palitra as ReadPalitra,
  PalitraGeometryDetails as ReadGeometry,
  PalitraReadV2,
} from '../../../../../Bindings';
import type {
  Coords,
  Geometry,
  Palitra as MapPalitra,
  PalitraDetails,
  PalitraPoint,
} from '../../../../maps/palitra-types';

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizeCoords(
  raw: { lat: number | string; lng: number | string } | null | undefined,
): Coords | null {
  if (!raw) {
    return null;
  }

  const lat = normalizeNumber(raw.lat);
  const lng = normalizeNumber(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return { lat, lng };
}

function normalizeGeometry(raw: ReadGeometry['geometry'] | null | undefined): Geometry | null {
  if (!raw) {
    return null;
  }

  return {
    center: normalizeCoords(raw.center),
    perimeter_linear_ring: (raw.perimeterLinearRing ?? [])
      .map((coords) => normalizeCoords(coords))
      .filter((coords): coords is Coords => coords !== null),
    line_strings: (raw.lineStrings ?? []).map((lineString) =>
      lineString
        .map((coords) => normalizeCoords(coords))
        .filter((coords): coords is Coords => coords !== null),
    ),
  };
}

export function hasRenderableGeometry(geometry: Geometry | null | undefined): boolean {
  if (!geometry) {
    return false;
  }

  const perimeter = geometry.perimeter_linear_ring;
  if (Array.isArray(perimeter) && perimeter.length >= 3) {
    return true;
  }

  const lineStrings = geometry.line_strings;
  if (
    Array.isArray(lineStrings) &&
    lineStrings.some((lineString) => Array.isArray(lineString) && lineString.length >= 2)
  ) {
    return true;
  }

  return Boolean(geometry.center);
}

export function toPreviewPalitras(preview: PalitraReadV2 | null): PalitraDetails[] {
  if (!preview) {
    return [];
  }

  const basePalitra = preview.palitra;
  const geometries =
    preview.geometries.length > 0
      ? preview.geometries
      : basePalitra.geometry
        ? [
            {
              id: basePalitra.id,
              colorHex: basePalitra.colorHex,
              sourceFileName: basePalitra.sourceFileName,
              lastUploadedAtTs: basePalitra.lastUploadedAtTs,
              geometry: basePalitra.geometry,
              points: [],
            },
          ]
        : [];

  return geometries
    .map((geometry) => {
      const normalizedGeometry = normalizeGeometry(geometry.geometry);
      if (!normalizedGeometry) {
        return null;
      }

      const palitra: MapPalitra = {
        id: normalizeNumber(geometry.id),
        api_palitra_id: normalizeNumber(basePalitra.id),
        name: basePalitra.name,
        folder: basePalitra.folder,
        color_hex: geometry.colorHex ?? basePalitra.colorHex ?? '#00bcd4',
        geometry: normalizedGeometry,
        source_file_name: geometry.sourceFileName ?? basePalitra.sourceFileName ?? undefined,
      };

      return {
        palitra,
        points: [] as PalitraPoint[],
      };
    })
    .filter((entry): entry is PalitraDetails => entry !== null);
}
