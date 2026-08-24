// @test-scope parser: locality API response normalization fixture
import { describe, expect, it, vi } from 'vitest';

import { postJson } from './client';
import { mapCoordinates } from './location';

vi.mock('./client', () => ({ postJson: vi.fn() }));

describe('mapCoordinates', () => {
  it('maps backend locality fields to frontend names', async () => {
    vi.mocked(postJson).mockResolvedValueOnce([
      {
        coords: { lat: 49.1, lon: 37.2 },
        locality: {
          settlement_name: 'Степногірськ',
          direction: 'SW',
          region: null,
          country: null,
          distance_m: 5400,
          is_rf: false,
        },
      },
    ]);

    await expect(mapCoordinates([{ lat: 49.1, lon: 37.2 }])).resolves.toEqual([
      {
        coords: { lat: 49.1, lon: 37.2 },
        locality: {
          settlementName: 'Степногірськ',
          direction: 'SW',
          region: null,
          country: null,
          distanceM: 5400,
          isRf: false,
        },
      },
    ]);
    expect(postJson).toHaveBeenCalledWith(
      '/api/location/map-coordinates',
      { coords: [{ lat: 49.1, lon: 37.2 }] },
      undefined,
    );
  });
});
