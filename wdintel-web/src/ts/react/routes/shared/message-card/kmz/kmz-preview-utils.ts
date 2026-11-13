export const MAX_KMZ_PREVIEW_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_KMZ_PREVIEW_ENTRIES = 100;
export const MAX_KMZ_PREVIEW_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_KMZ_PREVIEW_COORDINATES = 100_000;
export const MAX_KMZ_PREVIEW_INFERRED_AREA_GROUPS = 500;
export const MAX_KMZ_PREVIEW_INFERRED_AREA_VERTICES = 512;
export const MIN_KMZ_PREVIEW_INFERRED_AREA_POINTS = 30;
export const MAX_MAP_PREVIEW_FEATURES = 100_000;
export const MAX_MAP_PREVIEW_GEOMETRY_DEPTH = 32;

export type NativeMapFormat = 'kml' | 'kmz' | 'gpx' | 'geojson';

export function getNativeMapFormat(
  fileName: string,
  contentType?: string | null,
): NativeMapFormat | null {
  if (/\.kml$/i.test(fileName)) return 'kml';
  if (/\.kmz$/i.test(fileName)) return 'kmz';
  if (/\.gpx$/i.test(fileName)) return 'gpx';
  if (/\.geojson$/i.test(fileName)) return 'geojson';
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.includes('kml')) return 'kml';
  if (type.includes('kmz') || type.includes('google-earth')) return 'kmz';
  if (type === 'application/gpx+xml') return 'gpx';
  if (type === 'application/geo+json' || type === 'application/vnd.geo+json') return 'geojson';
  return null;
}

export function kmzPreviewErrorCopy(details: string): string {
  if (/KMZ_REQUEST_TIMEOUT/.test(details))
    return 'Час очікування завантаження або перевірки конвертації вичерпано. Спробуйте ще раз.';
  if (/KMZ_SOURCE_TOO_LARGE/.test(details))
    return 'Перевищено ліміт попереднього перегляду 25 МіБ. Оригінал можна завантажити.';
  if (/KMZ_EXPANDED_TOO_LARGE|KMZ_TOO_MANY_ENTRIES/.test(details))
    return 'Архів KMZ завеликий для безпечного попереднього перегляду.';
  if (/KMZ_TOO_MANY_COORDINATES/.test(details))
    return 'Перевищено ліміт у 100 000 координат для попереднього перегляду.';
  if (/MAP_TOO_MANY_FEATURES/.test(details))
    return 'Перевищено ліміт у 100 000 об’єктів для попереднього перегляду.';
  if (/KMZ_MALFORMED|KML_MALFORMED|MAP_MALFORMED|KMZ_NO_KML/.test(details))
    return 'Файл не можна відобразити у попередньому перегляді.';
  return 'Не вдалося відкрити попередній перегляд.';
}

export function isTerminalKmzPreviewError(details: string): boolean {
  return /KMZ_SOURCE_TOO_LARGE|KMZ_EXPANDED_TOO_LARGE|KMZ_TOO_MANY_ENTRIES|KMZ_TOO_MANY_COORDINATES|MAP_TOO_MANY_FEATURES|KMZ_MALFORMED|KML_MALFORMED|MAP_MALFORMED|KMZ_NO_KML/.test(
    details,
  );
}
