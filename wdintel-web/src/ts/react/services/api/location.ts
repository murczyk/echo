import { postJson, type RequestOptions } from './client';
import type { CoordinateLocality } from '../../../maps/coordinate-locality';

export type { CoordinateLocality } from '../../../maps/coordinate-locality';

export type MappedCoordinate = {
  coords: { lat: number; lon: number };
  locality: CoordinateLocality | null;
};

type MappedCoordinateRaw = {
  coords: { lat: number; lon: number };
  locality: {
    settlement_name: string;
    direction: string;
    region: string | null;
    country: string | null;
    distance_m: number;
    is_rf: boolean;
  } | null;
};

export async function mapCoordinates(
  coords: Array<{ lat: number; lon: number }>,
  options?: RequestOptions,
): Promise<MappedCoordinate[]> {
  const result = await postJson<MappedCoordinateRaw[]>(
    '/api/location/map-coordinates',
    { coords },
    options,
  );
  return result.map((item) => ({
    coords: item.coords,
    locality: item.locality
      ? {
          settlementName: item.locality.settlement_name,
          direction: item.locality.direction,
          region: item.locality.region,
          country: item.locality.country,
          distanceM: item.locality.distance_m,
          isRf: item.locality.is_rf,
        }
      : null,
  }));
}
