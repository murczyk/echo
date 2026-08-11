export type CoordinateLocality = {
  settlementName: string;
  direction: string;
  region: string | null;
  country: string | null;
  distanceM: number;
  isRf: boolean;
};

const DIRECTION_LABELS: Record<string, string> = {
  N: 'пн',
  S: 'пд',
  E: 'сх',
  W: 'зх',
};

export function formatCoordinateLocality(locality: CoordinateLocality | null): string | null {
  if (!locality) return null;
  if (locality.distanceM < 100) return locality.settlementName;
  const direction = Array.from(locality.direction.toUpperCase())
    .map((part) => DIRECTION_LABELS[part] ?? part.toLowerCase())
    .join('-');
  const distanceKm = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(
    locality.distanceM / 1000,
  );
  return `${distanceKm} км на ${direction} від ${locality.settlementName}`;
}
