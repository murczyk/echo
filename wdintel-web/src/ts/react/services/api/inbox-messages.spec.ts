import { describe, expect, it, vi } from 'vitest';

import { fetchMessagesByIds } from './inbox-messages';

const apiMocks = vi.hoisted(() => ({
  postJson: vi.fn(),
}));

vi.mock('./client', () => ({
  postJson: apiMocks.postJson,
}));

describe('fetchMessagesByIds', () => {
  it('posts message ids to the by-id inbox endpoint', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      messages: [[7, { id: 7, text: 'updated' }]],
    });

    await expect(fetchMessagesByIds([7, 8])).resolves.toEqual([[7, { id: 7, text: 'updated' }]]);

    expect(apiMocks.postJson).toHaveBeenCalledWith(
      '/api/rer-importer/messages-by-id',
      { message_ids: [7, 8], inbox_req: null },
      undefined,
    );
  });

  it('sends inbox request context when provided', async () => {
    apiMocks.postJson.mockResolvedValueOnce({ messages: [] });

    await fetchMessagesByIds([7], {
      highlightPoints: true,
      highlightKeywords: true,
      search: 'needle',
    } as never);

    expect(apiMocks.postJson).toHaveBeenCalledWith(
      '/api/rer-importer/messages-by-id',
      {
        message_ids: [7],
        inbox_req: {
          highlight_points: true,
          highlight_keywords: true,
          search: 'needle',
        },
      },
      undefined,
    );
  });
});
