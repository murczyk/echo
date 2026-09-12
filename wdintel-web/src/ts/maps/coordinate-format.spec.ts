import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forward } from 'mgrs';

vi.mock('mgrs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mgrs')>();
  return { ...actual, forward: vi.fn(actual.forward) };
});

import {
  getCoordinateMgrsText,
  getCoordinateText,
  getCoordinateTextIfAvailable,
} from './coordinate-format';
import { parseCoordinateInput } from './coordinate-search';

const COORDS = { lat: 47.068996, lng: 33.639173 };

describe('getCoordinateText', () => {
  beforeEach(() => {
    vi.mocked(forward).mockClear();
  });

  it('formats supplied MGRS coordinates with spaced groups', () => {
    expect(getCoordinateMgrsText(COORDS, '36TXX1234567890')).toBe('36T XX 12345 67890');
  });

  it('returns null when MGRS conversion fails', () => {
    vi.mocked(forward).mockImplementationOnce(() => {
      throw new Error('conversion failed');
    });

    expect(getCoordinateMgrsText(COORDS)).toBeNull();
  });

  it('formats every supported coordinate representation', () => {
    expect(getCoordinateText('wgs', COORDS)).toBe('47.06900, 33.63917');
    expect(getCoordinateText('dms', COORDS)).toContain("47°4'");
    expect(getCoordinateText('mgrs', COORDS)).toMatch(/^36T /);
    expect(getCoordinateText('sk42', COORDS)).toBe('СК-42: X=5215227, Y=6548669');
    expect(getCoordinateText('usk2000', COORDS)).toMatch(/^УСК-2000: X=\d{7}, Y=\d{7}$/);
    expect(getCoordinateText('utm', COORDS)).toMatch(/^36T \d{6} \d{7}$/);
  });

  it('produces UTM output accepted by the shared parser', () => {
    const formatted = getCoordinateText('utm', COORDS);
    const parsed = parseCoordinateInput(formatted);

    expect(parsed?.lat).toBeCloseTo(COORDS.lat, 4);
    expect(parsed?.lng).toBeCloseTo(COORDS.lng, 4);
  });

  it('preserves unavailable projected conversion state while the legacy formatter falls back', () => {
    const unsupported = { lat: 50, lng: 60 };

    expect(getCoordinateTextIfAvailable('sk42', unsupported)).toBeNull();
    expect(getCoordinateTextIfAvailable('usk2000', unsupported)).toBeNull();
    expect(getCoordinateTextIfAvailable('utm', { lat: 85, lng: 30 })).toBeNull();
    expect(getCoordinateText('sk42', unsupported)).toBe('50.00000, 60.00000');
    expect(getCoordinateTextIfAvailable('sk42', COORDS)).toMatch(/^СК-42: X=/);
  });
});
