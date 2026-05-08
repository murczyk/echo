/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import type { NetworkFreqsRes } from '../../../../Bindings';
import { buildNetworkFreqRows, encryptionLabelFromKeys, formatNetworkFreqValue } from './frequency-utils';

function createFreq(overrides: Partial<NetworkFreqsRes>): NetworkFreqsRes {
  return {
    networkFreqId: 1,
    freq: '652.1111',
    modulationId: null,
    modulation: null,
    encryptionKeyIds: [],
    encryptionKeys: [],
    messageCount: 0,
    callsigns: [],
    lastDatetime: null,
    lastDatetimeInAor: null,
    createdAt: 0,
    isActive: true,
    activeFrom: 0,
    activeTo: null,
    kind: 'VHF',
    ...overrides,
  };
}

describe('frequency utils', () => {
  it('formats frequencies with four decimals', () => {
    expect(formatNetworkFreqValue('652.1111')).toBe('652.1111');
    expect(formatNetworkFreqValue('652.1')).toBe('652.1000');
    expect(formatNetworkFreqValue(652.11114)).toBe('652.1111');
  });

  it('groups adjacent frequencies within the spread threshold', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.1111', messageCount: 2, callsigns: ['Alpha'], kind: 'VHF' }),
        createFreq({ networkFreqId: 11, freq: '652.1200', messageCount: 3, callsigns: ['Bravo'], kind: 'VHF' }),
        createFreq({ networkFreqId: 12, freq: '652.1500', messageCount: 4, callsigns: ['Charlie'], kind: 'DMR' }),
      ],
      new Map(),
      [],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'group',
      displayFreq: '652.1111, 652.1200',
      messageCount: 5,
      callsignLabel: 'Alpha, Bravo',
      typeLabel: 'NFM',
    });
    expect(rows[1]).toMatchObject({
      kind: 'freq',
      displayFreq: '652.1500',
      typeLabel: 'DMR',
    });
  });

  it('derives encryption label from modulation metadata when keys are absent', () => {
    expect(
      encryptionLabelFromKeys([], new Map([[4, 'DMR (ARC40)']]), 4, null),
    ).toBe('ARC40');
    expect(
      encryptionLabelFromKeys([], new Map([[5, 'DMR (AES256)']]), 5, null),
    ).toBe('AES256');
    expect(
      encryptionLabelFromKeys([], new Map([[9, 'TYT (VEDA)']]), 9, null),
    ).toBe('VEDA');
  });
});
