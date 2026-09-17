import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../../../Bindings';
import { mapFormToInboxMessage, type MessageFormValues } from '../manage-message-drawer.mappers';

function buildMessage(): InboxMessage {
  return {
    messageUid: 'm-1',
    media: [{ id: 1 }],
    callsignTokens: ['token'],
    signalTokens: ['signal'],
    pointTokens: ['point'],
    networkIds: [3],
    callsignsAlg2: ['BRAVO'],
    coordsWithLocality: [{ coords: { lat: 49.1, lon: 37.2 }, locality: null }],
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
