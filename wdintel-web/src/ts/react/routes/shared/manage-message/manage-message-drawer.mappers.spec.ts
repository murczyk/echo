import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import type { InboxMessage, Tag } from '../../../../../Bindings';
import {
  mapFormToInboxMessage,
  mapInboxMessageToForm,
  type MessageFormValues,
} from './manage-message-drawer.mappers';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'm-1',
    text: 'body text',
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-07-01',
    time: '13:45',
    freq: '149.500',
    coords: '49.1, 37.2',
    callsigns: ['ALFA'],
    callsignsAlg2: ['BRAVO'],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: 'g-1',
    sender: null,
    extendedForm: 'a note',
    post: 'post-1',
    postId: null,
    unit: 'unit-1',
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: 'Київ, Харків',
    tags: [7],
    networkIds: [3],
    inboxTags: null,
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

const tagsMap: Record<number, Tag> = {
  7: {
    label: 'арта',
    extra: null,
    ord: null,
    keywords: null,
    isPalitra: false,
    ownerOrganismId: null,
  },
};
const labelToTagId = new Map<string, number>([['арта', 7]]);

describe('mapInboxMessageToForm', () => {
  it('maps scalar and structured fields into form values', () => {
    const values = mapInboxMessageToForm(buildMessage(), tagsMap);
    expect(values.full_body).toBe('body text');
    expect(values.comment).toBe('a note');
    expect(values.freq).toBe('149.500');
    expect(values.coords).toBe('49.1, 37.2');
    expect(values.post).toBe('post-1');
    expect(values.unit).toBe('unit-1');
    expect(values.callsigns).toEqual(['ALFA']);
    expect(values.locations).toEqual(['Київ', 'Харків']);
    expect(values.tags).toEqual(['арта']);
    expect(values.date?.format('YYYY-MM-DD')).toBe('2026-07-01');
    expect(values.time?.format('HH:mm')).toBe('13:45');
  });

  it('handles null fields without throwing', () => {
    const values = mapInboxMessageToForm(
      buildMessage({
        date: null,
        time: null,
        coords: null,
        location: null,
        tags: null,
        extendedForm: null,
      }),
      tagsMap,
    );
    expect(values.date).toBeNull();
    expect(values.time).toBeNull();
    expect(values.coords).toBe('');
    expect(values.locations).toEqual([]);
    expect(values.tags).toEqual([]);
    expect(values.comment).toBe('');
  });

  it('drops tag ids missing from the tags map', () => {
    const values = mapInboxMessageToForm(buildMessage({ tags: [7, 99] }), tagsMap);
    expect(values.tags).toEqual(['арта']);
  });

  it('converts the UTC timestamp to Kyiv date and time', () => {
    const values = mapInboxMessageToForm(
      buildMessage({
        timestamp: Date.parse('2026-07-01T10:45:00Z'),
        date: '2000-01-01',
        time: '00:00',
      }),
      tagsMap,
    );

    expect(values.date?.format('YYYY-MM-DD')).toBe('2026-07-01');
    expect(values.time?.format('HH:mm')).toBe('13:45');
  });
});

describe('mapFormToInboxMessage', () => {
  const baseValues: MessageFormValues = {
    full_body: 'new body',
    comment: 'new note',
    date: dayjs('2026-08-02', 'YYYY-MM-DD'),
    time: dayjs('09:05', 'HH:mm'),
    freq: '150.000',
    coords: '50.0, 30.0',
    callsigns: ['CHARLIE'],
    post: 'post-2',
    unit: 'unit-2',
    locations: ['Львів'],
    tags: ['арта'],
  };

  it('merges edited fields onto the original message', () => {
    const original = buildMessage();
    const next = mapFormToInboxMessage(original, baseValues, labelToTagId);
    expect(next.text).toBe('new body');
    expect(next.extendedForm).toBe('new note');
    expect(next.date).toBe('2026-08-02');
    expect(next.time).toBe('09:05');
    expect(next.freq).toBe('150.000');
    expect(next.coords).toBe('50.0, 30.0');
    expect(next.callsigns).toEqual(['CHARLIE']);
    expect(next.location).toBe('Львів');
    expect(next.post).toBe('post-2');
    expect(next.unit).toBe('unit-2');
    expect(next.tags).toEqual([7]);
  });

  it('preserves untouched original fields (media, tokens, networkIds, callsignsAlg2)', () => {
    const original = buildMessage();
    const next = mapFormToInboxMessage(original, baseValues, labelToTagId);
    expect(next.callsignsAlg2).toEqual(['BRAVO']);
    expect(next.networkIds).toEqual([3]);
    expect(next.messageUid).toBe('m-1');
    expect(next.groupMasterKey).toBe('g-1');
  });

  it('nullifies emptied optional strings and drops unknown tag labels', () => {
    const original = buildMessage();
    const next = mapFormToInboxMessage(
      original,
      { ...baseValues, freq: '   ', coords: '', locations: [], tags: ['арта', 'невідомий'] },
      labelToTagId,
    );
    expect(next.freq).toBeNull();
    expect(next.coords).toBeNull();
    expect(next.location).toBeNull();
    expect(next.tags).toEqual([7]);
  });
});
