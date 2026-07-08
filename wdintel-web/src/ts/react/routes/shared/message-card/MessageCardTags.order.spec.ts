import { describe, expect, it } from 'vitest';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import { buildMessageCardTagRows } from './MessageCardTags.helpers';
import { buildSelectedFirstTagOrder } from './MessageCardTags';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: 'message',
    freq: null,
    bookmarked: false,
    important: false,
    extendedForm: null,
    sender: null,
    groupMasterKey: null,
    networkIds: [],
    tags: null,
    inboxTags: null,
    metadata: [],
    textMarked: null,
    pointTokens: null,
    ...overrides,
  } as InboxMessage;
}

const tagsMap = {
  10: {
    label: 'орг-3',
    extra: false,
    ord: 3,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
  11: {
    label: 'орг-1',
    extra: false,
    ord: 1,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
  13: {
    label: 'орг-2',
    extra: false,
    ord: 2,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
} as Record<number, Tag>;

describe('compact tag layout ordering', () => {
  it('keeps selected tags first, then sorts each group by ord', () => {
    // Tag 13 (ord 2) is selected; 11 (ord 1) and 10 (ord 3) are not.
    const rows = buildMessageCardTagRows(buildMessage({ tags: [13] }), tagsMap, [10, 11, 13]);
    const order = buildSelectedFirstTagOrder(rows);

    // Selected (13) first; remaining unselected keep ord order (11 then 10).
    expect(order).toEqual([13, 11, 10]);
  });

  it('sorts purely by ord when no tag is selected', () => {
    const rows = buildMessageCardTagRows(buildMessage(), tagsMap, [10, 11, 13]);
    const order = buildSelectedFirstTagOrder(rows);

    expect(order).toEqual([11, 13, 10]);
  });
});
