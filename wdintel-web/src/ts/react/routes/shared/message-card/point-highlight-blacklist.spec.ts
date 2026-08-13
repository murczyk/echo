import { describe, expect, it } from 'vitest';
import type { InboxMessage } from '../../../../../Bindings';
import {
  pointBlacklistLabelKey,
  removePointHighlightSourceFromMessage,
} from './point-highlight-blacklist';

function message(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    text: 'Точка',
    textMarked: null,
    pointTokens: null,
    ...overrides,
  } as InboxMessage;
}

describe('pointBlacklistLabelKey', () => {
  it.each([
    ['  Bravo  ', 'bravo'],
    ['БРАВО', 'браво'],
    ['Їжак', 'їжак'],
    ['  Ґрунт\u00a0', 'ґрунт'],
  ])('matches backend identity for %s', (value, expected) => {
    expect(pointBlacklistLabelKey(value)).toBe(expected);
  });
});

describe('removePointHighlightSourceFromMessage', () => {
  it('removes only the selected palette from marked text and point tokens', () => {
    const source = message({
      textMarked: [{ CNPointC: { etalon: '  БРАВО ', text: 'Bravo', palitraIds: [4, 8] } }],
      pointTokens: [{ etalon: ' БРАВО', text: 'Bravo', palitraIds: [4, 8] }],
    });

    const result = removePointHighlightSourceFromMessage(source, {
      messageId: 12,
      etalon: 'браво',
      palitraId: 4,
    });

    expect(result.textMarked).toEqual([
      { CNPointC: { etalon: '  БРАВО ', text: 'Bravo', palitraIds: [8] } },
    ]);
    expect(result.pointTokens).toEqual([{ etalon: ' БРАВО', text: 'Bravo', palitraIds: [8] }]);
  });

  it('converts a point node to text when its last source is removed', () => {
    const source = message({
      textMarked: [{ CNPointC: { etalon: 'Їжак', text: 'Їжак', palitraIds: [4] } }],
    });
    const result = removePointHighlightSourceFromMessage(source, {
      messageId: 12,
      etalon: ' їжак ',
      palitraId: 4,
    });
    expect(result.textMarked).toEqual([{ CNTextC: { text: 'Їжак' } }]);
  });

  it('updates every matching chip and token while leaving other sources intact', () => {
    const source = message({
      textMarked: [
        { CNPointC: { etalon: 'Alpha', text: 'A', palitraIds: [7, 12] } },
        { CNPointC: { etalon: ' alpha ', text: 'Different', palitraIds: [7] } },
      ],
      pointTokens: [
        { etalon: 'ALPHA', text: 'A', palitraIds: [7, 12] },
        { etalon: 'Other', text: 'O', palitraIds: [7] },
      ],
    });

    const result = removePointHighlightSourceFromMessage(source, {
      messageId: 12,
      etalon: ' alpha ',
      palitraId: 7,
    });

    expect(result.textMarked).toEqual([
      { CNPointC: { etalon: 'Alpha', text: 'A', palitraIds: [12] } },
      { CNTextC: { text: 'Different' } },
    ]);
    expect(result.pointTokens).toEqual([
      { etalon: 'ALPHA', text: 'A', palitraIds: [12] },
      { etalon: 'Other', text: 'O', palitraIds: [7] },
    ]);
  });

  it('returns the original message when the source does not match', () => {
    const source = message({
      textMarked: [{ CNPointC: { etalon: 'Alpha', text: 'Alpha', palitraIds: [4] } }],
    });
    expect(
      removePointHighlightSourceFromMessage(source, {
        messageId: 12,
        etalon: 'Alpha',
        palitraId: 8,
      }),
    ).toBe(source);
  });

  it('leaves points with empty source ids unchanged', () => {
    const source = message({
      textMarked: [{ CNPointC: { etalon: 'Alpha', text: 'Alpha', palitraIds: [] } }],
      pointTokens: [{ etalon: 'Alpha', text: 'Alpha', palitraIds: [] }],
    });
    expect(
      removePointHighlightSourceFromMessage(source, {
        messageId: 12,
        etalon: 'Alpha',
        palitraId: 7,
      }),
    ).toBe(source);
  });
});
