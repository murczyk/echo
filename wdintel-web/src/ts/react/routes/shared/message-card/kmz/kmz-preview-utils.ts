export const MAX_KMZ_PREVIEW_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_KMZ_PREVIEW_ENTRIES = 100;
export const MAX_KMZ_PREVIEW_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_KMZ_PREVIEW_COORDINATES = 100_000;

export function isNativeKmlOrKmz(
  fileName: string,
  contentType?: string | null,
): 'kml' | 'kmz' | null {
  if (/\.kml$/i.test(fileName)) return 'kml';
  if (/\.kmz$/i.test(fileName)) return 'kmz';
  const type = contentType?.toLowerCase() ?? '';
  if (type.includes('kml')) return 'kml';
  if (type.includes('kmz') || type.includes('google-earth')) return 'kmz';
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
  if (/KMZ_MALFORMED|KML_MALFORMED|KMZ_NO_KML/.test(details))
    return 'Файл не можна відобразити у попередньому перегляді.';
  return 'Не вдалося відкрити попередній перегляд.';
}

export function isTerminalKmzPreviewError(details: string): boolean {
  return /KMZ_SOURCE_TOO_LARGE|KMZ_EXPANDED_TOO_LARGE|KMZ_TOO_MANY_ENTRIES|KMZ_TOO_MANY_COORDINATES|KMZ_MALFORMED|KML_MALFORMED|KMZ_NO_KML/.test(
    details,
  );
}
