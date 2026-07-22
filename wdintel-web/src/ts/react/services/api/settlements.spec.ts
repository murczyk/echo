import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from './client';
import { findSettlementPrefix } from './settlements';

vi.mock('./client', () => ({
  postJson: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

describe('settlement API helpers', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('sends the exact prefix search body and forwards the abort signal', async () => {
    const controller = new AbortController();
    const settlements = [
      {
        id: 1,
        name: 'МЕРЕФА',
        region: 'Харківська область',
        language: 'Ua' as const,
        coords: [49.82, 35.98] as [number, number],
      },
    ];
    postJsonMock.mockResolvedValueOnce(settlements);

    const result = await findSettlementPrefix({
      query: ' мер',
      relatedCoordinates: [49.82, 36.05],
      signal: controller.signal,
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/settlement/find-prefix',
      {
        query: ' мер',
        region: null,
        related_coordinates: [49.82, 36.05],
        aor_id: null,
      },
      { signal: controller.signal },
    );
    expect(result).toBe(settlements);
  });

  it('passes null coordinates through unchanged', async () => {
    postJsonMock.mockResolvedValueOnce([]);

    await findSettlementPrefix({ query: 'ме', relatedCoordinates: null });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/settlement/find-prefix',
      {
        query: 'ме',
        region: null,
        related_coordinates: null,
        aor_id: null,
      },
      undefined,
    );
  });
});
