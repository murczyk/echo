import { describe, expect, it, vi } from 'vitest';

import { fetchMessagesByIds } from '../inbox-messages';
import {
  getIntelligenceReports,
  getParentMessages,
} from '../../../routes/shared/intelligence-reports';

const apiMocks = vi.hoisted(() => ({
  postJson: vi.fn(),
}));

vi.mock('../client', () => ({
  postJson: apiMocks.postJson,
}));

describe('fetchMessagesByIds', () => {
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

  it('keeps parent linkage and non-recursive report summaries from the wire response', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      messages: [
        [
          7,
          {
            text: 'report',
            parent_messages: [
              {
                id: 4,
                text: 'original',
                timestamp: null,
                date: null,
                time: null,
                group_master_key: 'original-group',
              },
            ],
            intelligence_reports: [
              {
                id: 9,
                text: 'summary',
                timestamp: 100,
                date: null,
                time: null,
                group_master_key: null,
              },
            ],
          },
        ],
      ],
    });

    const [[, message]] = await fetchMessagesByIds([7]);

    expect(getParentMessages(message)).toEqual([
      {
        id: 4,
        text: 'original',
        timestamp: null,
        date: null,
        time: null,
        groupMasterKey: 'original-group',
      },
    ]);
    expect(getIntelligenceReports(message)).toEqual([
      {
        id: 9,
        text: 'summary',
        timestamp: 100,
        date: null,
        time: null,
        groupMasterKey: null,
      },
    ]);
  });
});
