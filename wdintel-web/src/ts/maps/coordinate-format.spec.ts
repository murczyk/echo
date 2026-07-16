import { beforeEach, describe, expect, it, vi } from 'vitest';

const forward = vi.hoisted(() => vi.fn());

vi.mock('mgrs', () => ({
  forward,
}));

import { getCoordinateMgrsText } from './coordinate-format';

describe('coordinate-format', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('formats MGRS coordinates with spaced groups', () => {
    forward.mockReturnValue('36TXX1234567890');

    expect(getCoordinateMgrsText({ lat: 50.45044, lng: 30.52355 })).toBe('36T XX 12345 67890');
  });

  it('returns null when MGRS conversion fails', () => {
    forward.mockImplementationOnce(() => {
      throw new Error('conversion failed');
    });

    expect(getCoordinateMgrsText({ lat: 50.45044, lng: 30.52355 })).toBeNull();
  });
});
