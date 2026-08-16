import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { postJson } from './client';
import { fetchInboxMessages } from './inbox';
import { inboxMsgtoSnakeBody, normalizeMessageMediaInfo } from './inbox-messages';
import type { InboxMessagesReq } from '../../../../Bindings';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

function buildRawMessage(
  overrides: Partial<InboxMessage> & Record<string, unknown> = {},
): InboxMessage {
  return {
    text: 'P-2 ключ',
    freq: '129.9500',
    bookmarked: false,
    important: false,
    extendedForm: null,
    sender: null,
    groupMasterKey: null,
    networkIds: [],
    tags: [],
    inboxTags: null,
    metadata: [],
    textMarked: null,
    pointTokens: null,
    ...overrides,
  } as InboxMessage;
}

describe('inbox API normalization', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('filters empty marked tokens before they enter the message model', async () => {
    postJsonMock.mockResolvedValueOnce({
      inbox_items: [
        [
          7,
          buildRawMessage({
            text_marked: [
              { CNTextC: { text: 'P-2 ' } },
              { CNHighlightC: { text: '', begin: 4, end: 4 } },
              { CNHighlightC: { text: '  ', begin: 4, end: 8 } },
              { CNHighlightC: { text: 'ключ', begin: 4, end: 8 } },
              { CNPointC: { begin: 1, end: 1, etalon: 'P-1', text: '' } },
              { CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: '  ' } },
              { CNPointC: { begin: 0, end: 3, etalon: '', text: 'P-2' } },
              { CNPointC: { begin: 0, end: 3, etalon: 'P-2', text: 'P-2' } },
              null,
            ] as unknown as InboxMessage['textMarked'],
            point_tokens: [
              { begin: 0, end: 3, etalon: 'P-2', text: 'P-2' },
              { begin: 0, end: 0, etalon: '', text: '' },
            ],
          }),
        ],
      ],
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
    });

    const response = await fetchInboxMessages({} as Parameters<typeof fetchInboxMessages>[0]);
    const message = response.inboxItems[0]?.[1];

    expect(message?.textMarked).toEqual([
      { CNTextC: { text: 'P-2 ' } },
      { CNHighlightC: { text: 'ключ', begin: 4, end: 8 } },
      { CNTextC: { text: 'P-2' } },
      { CNPointC: { begin: 0, end: 3, etalon: 'P-2', text: 'P-2' } },
    ]);
    expect(message?.pointTokens).toEqual([{ begin: 0, end: 3, etalon: 'P-2', text: 'P-2' }]);
  });

  it('serializes denied tags and tag presence into the inbox request body', () => {
    const body = inboxMsgtoSnakeBody({
      deniedTags: [3, 7],
      tagPresence: 'WithoutTags',
      selectedTags: [],
    } as unknown as InboxMessagesReq) as Record<string, unknown>;

    expect(body.denied_tags).toEqual([3, 7]);
    expect(body.tag_presence).toBe('WithoutTags');
    expect(body.selected_tags).toBeNull();
  });

  it('sends null denied tags and tag presence when unset', () => {
    const body = inboxMsgtoSnakeBody({
      deniedTags: [],
      tagPresence: null,
    } as unknown as InboxMessagesReq) as Record<string, unknown>;

    expect(body.denied_tags).toBeNull();
    expect(body.tag_presence).toBeNull();
  });

  it('serializes without network and without coords flags as typed optional booleans', () => {
    for (const value of [true, false, null] as const) {
      const body = inboxMsgtoSnakeBody({
        withoutNetwork: value,
        orWithoutCoords: value,
      } as unknown as InboxMessagesReq) as Record<string, unknown>;

      expect(body.without_network).toBe(value);
      expect(body.or_without_coords).toBe(value);
    }
  });

  it('serializes empty selected networks as null while preserving without network', () => {
    const body = inboxMsgtoSnakeBody({
      selectedNetworks: [],
      withoutNetwork: true,
    } as unknown as InboxMessagesReq) as Record<string, unknown>;

    expect(body.selected_networks).toBeNull();
    expect(body.without_network).toBe(true);
  });

  it('normalizes inbox metadata fields from snake_case and falls back to an empty array', async () => {
    postJsonMock.mockResolvedValueOnce({
      inbox_items: [
        [7, buildRawMessage({ metadata: null })],
        [
          8,
          buildRawMessage({
            metadata: [
              {
                color_code: ' 3 ',
                color_code_start_index: 1,
                color_code_end_index: 2,
                call_group_id: ' 456 ',
                call_group_id_start_index: 3,
                call_group_id_end_index: 4,
                call_group_name: ' Bravo ',
                call_group_name_start_index: 5,
                call_group_name_end_index: 6,
                sender_id: ' 123 ',
                sender_id_start_index: 7,
                sender_id_end_index: 8,
                sender_name: ' Alpha ',
                sender_name_start_index: 9,
                sender_name_end_index: 10,
                hash_id: ' hash-1 ',
                hash_id_start_index: 11,
                hash_id_end_index: 12,
              },
            ],
          }),
        ],
      ],
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
    });

    const response = await fetchInboxMessages({} as Parameters<typeof fetchInboxMessages>[0]);
    const firstMessage = response.inboxItems[0]?.[1];
    const secondMessage = response.inboxItems[1]?.[1];

    expect(firstMessage?.metadata).toEqual([]);
    expect(secondMessage?.metadata).toEqual([
      {
        colorCode: ' 3 ',
        colorCodeStartIndex: 1,
        colorCodeEndIndex: 2,
        callGroupId: ' 456 ',
        callGroupIdStartIndex: 3,
        callGroupIdEndIndex: 4,
        callGroupName: ' Bravo ',
        callGroupNameStartIndex: 5,
        callGroupNameEndIndex: 6,
        senderId: ' 123 ',
        senderIdStartIndex: 7,
        senderIdEndIndex: 8,
        senderName: ' Alpha ',
        senderNameStartIndex: 9,
        senderNameEndIndex: 10,
        hashId: ' hash-1 ',
        hashIdStartIndex: 11,
        hashIdEndIndex: 12,
      },
    ]);
  });

  it('normalizes inbox media fields from snake_case', async () => {
    postJsonMock.mockResolvedValueOnce({
      inbox_items: [
        [
          9,
          buildRawMessage({
            media: [
              {
                id: 'audio-1',
                content_type: 'audio/mpeg',
                file_name: 'recording.mp3',
                size_bytes: 1024,
                href: '/api/messenger/media/audio-1',
                transcription: 'recognized speech',
              },
            ],
          }),
        ],
      ],
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
    });

    const response = await fetchInboxMessages({} as Parameters<typeof fetchInboxMessages>[0]);
    const message = response.inboxItems[0]?.[1];

    expect(message?.media).toEqual([
      {
        id: 'audio-1',
        contentType: 'audio/mpeg',
        fileName: 'recording.mp3',
        sizeBytes: 1024,
        href: '/api/messenger/media/audio-1',
        transcription: 'recognized speech',
        ocr: null,
      },
    ]);
  });

  it('normalizes nested message comments from snake_case', async () => {
    postJsonMock.mockResolvedValueOnce({
      inbox_items: [
        [
          10,
          buildRawMessage({
            message_comments: [
              {
                id: 11,
                message_id: 10,
                comment: 'system note',
                login: 'system',
                sigint_post_name: 'Post Alpha',
              },
            ],
          }),
        ],
      ],
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
    });

    const response = await fetchInboxMessages({} as Parameters<typeof fetchInboxMessages>[0]);
    const message = response.inboxItems[0]?.[1];

    expect(message?.messageComments).toEqual([
      {
        id: 11,
        messageId: 10,
        comment: 'system note',
        login: 'system',
        sigintPostName: 'Post Alpha',
      },
    ]);
  });
});

describe('normalizeMessageMediaInfo', () => {
  it('maps snake_case attachment fields to camelCase', () => {
    expect(
      normalizeMessageMediaInfo({
        id: 'm1',
        content_type: 'audio/wav',
        file_name: 'clip.wav',
        size_bytes: 2048,
        href: '/api/messenger/media/m1',
      }),
    ).toEqual({
      id: 'm1',
      contentType: 'audio/wav',
      fileName: 'clip.wav',
      sizeBytes: 2048,
      href: '/api/messenger/media/m1',
      transcription: null,
      ocr: null,
    });
  });
});
