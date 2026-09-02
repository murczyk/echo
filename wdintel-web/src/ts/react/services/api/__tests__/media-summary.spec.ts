import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson } from '../client';
import { getMediaSummary, getMediaSummaryCoordinates } from '../media-summary';

vi.mock('../client', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

// @test-scope parser: preserves authorized media summary request paths and payload compatibility.
describe('media summary API', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
  });

  it('loads only coordinates from the authorized media endpoint', async () => {
    vi.mocked(getJson).mockResolvedValueOnce({ coordinates: [] });

    await expect(getMediaSummaryCoordinates('media/id')).resolves.toEqual({ coordinates: [] });
    expect(getJson).toHaveBeenCalledWith('/api/messenger/media/media%2Fid/summary/coordinates');
  });

  it('uses the admin-authorized summary endpoint for OCR evaluation', async () => {
    vi.mocked(getJson).mockResolvedValueOnce({ state: 'completed' });
    const controller = new AbortController();

    await getMediaSummary('media/id', { signal: controller.signal }, 'admin-ocr');

    expect(getJson).toHaveBeenCalledWith('/api/admin/ocr/media%2Fid/summary', {
      signal: controller.signal,
    });
  });
});
