import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from './client';
import { reprocessMediaOcr } from './ocr';

vi.mock('./client', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

describe('OCR API', () => {
  beforeEach(() => {
    vi.mocked(postJson).mockReset();
  });

  it('queues admin media reprocessing through the encoded endpoint', async () => {
    vi.mocked(postJson).mockResolvedValueOnce({ state: 'queued' });

    await expect(reprocessMediaOcr('media/id')).resolves.toEqual({ state: 'queued' });
    expect(postJson).toHaveBeenCalledWith('/api/admin/ocr/media%2Fid/reprocess');
  });
});
