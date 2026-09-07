import { describe, expect, it, vi } from 'vitest';

import { fetchInboxWindow, fetchMessagesByIds } from './inbox-messages';
import {
  getIntelligenceReports,
  getParentMessages,
} from '../../routes/shared/intelligence-reports';

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

describe('fetchInboxItemContext', () => {
  it('posts message uid to /api/rer-importer/inbox-item-context and normalizes response', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      message: [
        101,
        {
          text: 'target',
          freq: '123.45',
          group_master_key: 'group-alpha',
          network_ids: [7],
        },
      ],
      group_master_keys: ['group-alpha', 'group-beta'],
      sigint_inbox_item_ids: [101, 102],
      sinceTs: 1700000000000,
      tillTs: 1700001800000,
    });

    const { fetchInboxItemContext } = await import('./inbox-messages');
    const result = await fetchInboxItemContext({ messageUid: 'uid-123' });

    expect(apiMocks.postJson).toHaveBeenCalledWith(
      '/api/rer-importer/inbox-item-context',
      { message_uid: 'uid-123' },
      undefined,
    );
    expect(result).toEqual({
      message: [
        101,
        expect.objectContaining({
          text: 'target',
          freq: '123.45',
          groupMasterKey: 'group-alpha',
          networkIds: [7],
        }),
      ],
      groupMasterKeys: ['group-alpha', 'group-beta'],
      sigintInboxItemIds: [101, 102],
      sinceTs: 1700000000000,
      tillTs: 1700001800000,
    });
  });
});

describe('fetchInboxWindow', () => {
  it('loads and normalizes the target with messages on both sides in one request', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      inbox_items: [
        [100, { text: 'before' }],
        [101, { message_uuid: '019-id', text: 'target' }],
        [102, { text: 'after' }],
      ],
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
      page_limit: 20,
      around_message_messages_before: 20,
      around_message_messages_after: 19,
    });

    const result = await fetchInboxWindow({ messageRef: '019-id', inboxReq: null });

    expect(apiMocks.postJson).toHaveBeenCalledWith(
      '/api/rer-importer/get-inbox',
      expect.objectContaining({
        around_message_ref: '019-id',
      }),
      undefined,
    );
    expect(result).toMatchObject({
      targetMessageId: 101,
      inbox: {
        inboxItems: [
          [100, expect.objectContaining({ text: 'before' })],
          [101, expect.objectContaining({ messageUuid: '019-id', text: 'target' })],
          [102, expect.objectContaining({ text: 'after' })],
        ],
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
      messagesBefore: 20,
      messagesAfter: 19,
    });
  });
});
