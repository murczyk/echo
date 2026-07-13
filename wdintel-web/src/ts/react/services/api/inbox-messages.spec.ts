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

    await expect(fetchMessagesByIds([7, 8])).resolves.toEqual([
      [
        7,
        expect.objectContaining({
          id: 7,
          text: 'updated',
        }),
      ],
    ]);

    expect(apiMocks.postJson).toHaveBeenCalledWith(
      '/api/rer-importer/messages-by-id',
      { message_ids: [7, 8], inbox_req: null },
      undefined,
    );
  });

  it('normalizes by-id messages the same way as inbox loading', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      messages: [
        [
          7,
          {
            id: 7,
            text: 'updated',
            text_marked: [
              { CNHighlightC: { text: '' } },
              { CNHighlightC: { text: 'keep' } },
              { CNPointC: { text: '', etalon: 'point-1' } },
              { CNPointC: { text: 'Point text', etalon: '   ' } },
              { CNPointC: { text: 'Point text', etalon: 'etalon-1' } },
              'CNNewlineC',
            ],
            point_tokens: [
              { text: 'bad', etalon: '' },
              { text: 'good', etalon: 'etalon-1' },
            ],
            inbox_tags: [
              { id: 1, tag_id: 5, confidence: 1, login: null, model: null, organism_id: null },
            ],
          },
        ],
      ],
    });

    await expect(fetchMessagesByIds([7])).resolves.toEqual([
      [
        7,
        expect.objectContaining({
          id: 7,
          text: 'updated',
          textMarked: [
            { CNHighlightC: { text: 'keep' } },
            { CNTextC: { text: 'Point text' } },
            { CNPointC: { text: 'Point text', etalon: 'etalon-1' } },
            'CNNewlineC',
          ],
          pointTokens: [{ text: 'good', etalon: 'etalon-1' }],
          inboxTags: [
            { id: 1, tagId: 5, confidence: 1, login: null, model: null, organismId: null },
          ],
        }),
      ],
    ]);
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
