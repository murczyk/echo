import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../../../Bindings';
import {
  mapDirectSubmitCopyToForm,
  mapFormToInboxMessage,
  mapInboxMessageToForm,
  type MessageFormValues,
} from '../manage-message-drawer.mappers';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'm-1',
    date: '2026-07-01',
    time: '13:45',
    timestamp: Date.parse('2026-07-01T10:45:00Z'),
    media: [{ id: 1 }],
    callsignTokens: ['token'],
    signalTokens: ['signal'],
    pointTokens: ['point'],
    networkIds: [3],
    callsignsAlg2: ['BRAVO'],
    coordsWithLocality: [{ coords: { lat: 49.1, lon: 37.2 }, locality: null }],
    ...overrides,
  } as InboxMessage;
}

const values: MessageFormValues = {
  full_body: 'new body',
  comment: '',
  date: null,
  time: null,
  freq: '',
  coords: '',
  callsigns: [],
  post: '',
  unit: '',
  locations: [],
  tags: [],
};

// @test-scope regression: https://github.com/echoua/echo/issues/3515
it('#3515 keeps date-only edit time empty despite the noon timestamp', () => {
  const form = mapInboxMessageToForm(
    buildMessage({
      date: '2026-07-15',
      time: '12:00:00',
      timestamp: Date.parse('2026-07-15T09:00:00Z'),
      isTimeNull: true,
    }),
    {},
  );
  expect(form.date?.format('YYYY-MM-DD')).toBe('2026-07-15');
  expect(form.time).toBeNull();
});

// @test-scope regression: https://github.com/echoua/echo/issues/3515
it('#3515 preserves a date-only copied message without restoring noon in the form', () => {
  const form = mapDirectSubmitCopyToForm({
    timestamp: '2026-07-15T09:00:00Z',
    is_time_null: true,
    signal_group_master_key: 'g-1',
  });
  expect(form.date?.format('YYYY-MM-DD')).toBe('2026-07-15');
  expect(form.time).toBeNull();
});

describe('mapFormToInboxMessage', () => {
  // @test-scope safeguard: prevents edits from losing untouched persisted media, tokens, network IDs, callsigns, or coordinates.
  it('preserves untouched persisted fields while applying an edit', () => {
    const original = buildMessage();
    const next = mapFormToInboxMessage(original, values, new Map());

    expect(next.media).toEqual(original.media);
    expect(next.callsignTokens).toEqual(original.callsignTokens);
    expect(next.signalTokens).toEqual(original.signalTokens);
    expect(next.pointTokens).toEqual(original.pointTokens);
    expect(next.networkIds).toEqual(original.networkIds);
    expect(next.callsignsAlg2).toEqual(original.callsignsAlg2);
    expect(next.coordsWithLocality).toEqual(original.coordsWithLocality);
  });
});
