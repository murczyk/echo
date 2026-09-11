import { describe, expect, it } from 'vitest';

import type { InboxMessage, Tag } from '../../../../../../../Bindings';
import { buildMessageCardTagRows } from '../../MessageCardTags.helpers';

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
  2: {
    label: 'глобальний',
    extra: false,
    ord: 2,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: null,
  },
  99: {
    label: 'організм',
    extra: false,
    ord: 1,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
} as Record<number, Tag>;

const orderingTagsMap = {
  2: {
    label: 'глобальний',
    extra: false,
    ord: 5,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: null,
  },
  10: {
    label: 'орг-третій',
    extra: false,
    ord: 3,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
  11: {
    label: 'орг-перший',
    extra: false,
    ord: 1,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
  12: {
    label: 'орг-без-ord',
    extra: false,
    ord: null,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
  13: {
    label: 'орг-другий',
    extra: false,
    ord: 2,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: 7,
  },
} as Record<number, Tag>;

describe('buildMessageCardTagRows', () => {
  it('uses explicit backend tag order instead of object key order', () => {
    const rows = buildMessageCardTagRows(buildMessage(), tagsMap, [99, 2]);

    expect(rows.map((row) => row.tagId)).toEqual([99, 2]);
    expect(rows.map((row) => row.label)).toEqual(['організм', 'глобальний']);
  });

  it('sorts custom organism tags by ord while keeping them before global tags', () => {
    const rows = buildMessageCardTagRows(buildMessage(), orderingTagsMap, [10, 11, 12, 13, 2]);

    // Organism tags sorted by ord (1,2,3), null ord last keeping backend order; global stays after.
    expect(rows.map((row) => row.tagId)).toEqual([11, 13, 10, 12, 2]);
  });

  it('keeps extra custom tags after primary custom tags even with a lower ord', () => {
    const extraOrderingTagsMap = {
      20: {
        label: 'орг-екстра-ord0',
        extra: true,
        ord: 0,
        keywords: null,
        isPalitra: false,
        ownerOrganismId: 7,
      },
      21: {
        label: 'орг-основний-ord5',
        extra: false,
        ord: 5,
        keywords: null,
        isPalitra: false,
        ownerOrganismId: 7,
      },
      22: {
        label: 'орг-екстра-ord1',
        extra: true,
        ord: 1,
        keywords: null,
        isPalitra: false,
        ownerOrganismId: 7,
      },
    } as Record<number, Tag>;

    const rows = buildMessageCardTagRows(buildMessage(), extraOrderingTagsMap, [20, 21, 22]);

    // Primary tag (21) first despite its higher ord; extras (20, 22) follow, sorted by ord.
    expect(rows.map((row) => row.tagId)).toEqual([21, 20, 22]);
  });

  it('shows human contributors and bot contributors for a selected tag', () => {
    const rows = buildMessageCardTagRows(
      buildMessage({
        tags: [99],
        inboxTags: [
          { id: 1, tagId: 99, confidence: 1, login: 'delta1', model: null, organismId: 7 },
          {
            id: 2,
            tagId: 99,
            confidence: 0.72,
            login: null,
            model: 'classifier-v2',
            organismId: null,
          },
        ],
      }),
      tagsMap,
      [99, 2],
    );

    expect(rows[0]).toMatchObject({
      tagId: 99,
      isSet: true,
      provenance: 'mixed',
    });
    expect(rows[0]?.tip).toBe('Користувачі: delta1\nБоти: classifier-v2 (72%)');
  });

  it('uses current user fallback text for optimistic human tags without login', () => {
    const rows = buildMessageCardTagRows(
      buildMessage({
        tags: [99],
        inboxTags: [
          { id: 0, tagId: 99, confidence: 1, login: null, model: null, organismId: null },
        ],
      }),
      tagsMap,
      [99, 2],
    );

    expect(rows[0]?.tip).toBe('Користувачі: (ваш вибір)');
  });

  it('ECHO-3324 marks bot-only selected tags with robot provenance', () => {
    const rows = buildMessageCardTagRows(
      buildMessage({
        tags: [99],
        inboxTags: [
          {
            id: 1,
            tagId: 99,
            confidence: 0.86,
            login: null,
            model: 'classifier-v2',
            organismId: null,
          },
        ],
      }),
      tagsMap,
      [99],
    );

    expect(rows[0]).toMatchObject({ tagId: 99, isSet: true, provenance: 'robot' });
  });

  it('shows only human tag contributions from the selected organism', () => {
    const rows = buildMessageCardTagRows(
      buildMessage({
        tags: [2, 99],
        inboxTags: [
          { id: 1, tagId: 99, confidence: 1, login: 'own', model: null, organismId: 7 },
          { id: 2, tagId: 2, confidence: 1, login: 'other', model: null, organismId: 8 },
          { id: 3, tagId: 2, confidence: 0.9, login: null, model: 'bot', organismId: 7 },
        ],
      }),
      tagsMap,
      [99, 2],
      7,
    );

    expect(rows[0]).toMatchObject({
      tagId: 99,
      isSet: true,
      provenance: 'human',
    });
    expect(rows[1]).toMatchObject({
      tagId: 2,
      isSet: false,
      provenance: 'none',
    });
  });
});
