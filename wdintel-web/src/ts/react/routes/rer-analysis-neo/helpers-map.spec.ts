import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { buildMapAttrs } from './helpers-map';

describe('buildMapAttrs', () => {
  it('emits the strict legacy map payload shape', () => {
    const attrs = buildMapAttrs({
      dateRange: { startDate: 1, endDate: 2 },
      isLoading: false,
      points: [
        {
          messageId: 17,
          messageUid: 'abc-123',
          id: 1,
          lat: 49.1,
          lng: 37.2,
          mgrsCoords: '37U AB 12345 67890',
          sk42Coords: '1 2 3',
          freq: '145.5',
        },
      ],
      messages: [
        [
          17,
          {
            text: 'line 1',
            date: '2026-04-30',
            time: '01:42:11',
            freq: '145.5',
            coords: '49.1, 37.2',
            textMarked: [
              { CNTextC: { text: 'hello' } },
              { CNPointC: { text: 'P-1', etalon: 'P-1', begin: 0, end: 3 } },
            ],
          } as InboxMessage,
        ],
      ],
      networkUnits: [{ name: 'Unit', frequencies: ['145.5'] }],
      selectedUnits: ['Unit'],
      palitras: [],
      palitrasLoaded: true,
      palitrasLoadState: 'success',
    });

    expect(JSON.parse(attrs.points)).toEqual([
      {
        message_id: 17,
        message_uid: 'abc-123',
        id: 1,
        lat: 49.1,
        lng: 37.2,
        mgrs_coords: '37U AB 12345 67890',
        sk42_coords: '1 2 3',
        freq: '145.5',
      },
    ]);

    expect(JSON.parse(attrs.messages)).toEqual({
      networkUnits: [{ name: 'Unit', frequencies: ['145.5'] }],
      messages: [
        [
          17,
          expect.objectContaining({
            text: 'line 1',
            date: '2026-04-30',
            time: '01:42:11',
            freq: '145.5',
            coords: '49.1, 37.2',
            text_marked: [
              { CNTextC: { text: 'hello' } },
              { CNPointC: { text: 'P-1', etalon: 'P-1', begin: 0, end: 3 } },
            ],
          }),
        ],
      ],
    });
  });
});
