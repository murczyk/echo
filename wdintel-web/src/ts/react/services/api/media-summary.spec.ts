import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson } from './client';
import { getMediaSummaryCoordinates } from './media-summary';

vi.mock('./client', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

describe('media summary API', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
  });

  it('loads only coordinates from the authorized media endpoint', async () => {
    vi.mocked(getJson).mockResolvedValueOnce({ coordinates: [] });

    await expect(getMediaSummaryCoordinates('media/id')).resolves.toEqual({ coordinates: [] });
    expect(getJson).toHaveBeenCalledWith('/api/messenger/media/media%2Fid/summary/coordinates');
  });
});
