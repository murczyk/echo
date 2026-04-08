import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { postJson } from './client';
import { fetchInboxMessages } from './inbox';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

function buildRawMessage(overrides: Partial<InboxMessage> & Record<string, unknown> = {}): InboxMessage {
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
});
