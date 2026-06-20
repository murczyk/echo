/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import type { NetworkFreqsRes } from '../../../../Bindings';
import {
  buildNetworkFreqActivityByFreq,
  buildNetworkFreqRows,
  encryptionLabelFromKeys,
  formatNetworkFreqValue,
  sortNetworkFreqRowsByTableOrder,
  sortNetworkFreqsByTableOrder,
} from './frequency-utils';

function createFreq(overrides: Partial<NetworkFreqsRes>): NetworkFreqsRes {
  return {
    networkFreqId: 1,
    freq: '652.1111',
    encryptionId: null,
    encryption: null,
    modulation: 'NFM',
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
    const callsignsById = new Map<number, string[]>([
      [10, ['Alpha']],
      [11, ['Bravo']],
      [12, ['Charlie']],
    ]);
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.1111', messageCount: 2, callsigns: ['Alpha'], modulation: 'NFM' }),
        createFreq({ networkFreqId: 11, freq: '652.1200', messageCount: 3, callsigns: ['Bravo'], modulation: 'NFM' }),
        createFreq({ networkFreqId: 12, freq: '652.1500', messageCount: 4, callsigns: ['Charlie'], modulation: 'DMR' }),
      ],
      new Map(),
      callsignsById,
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

  it('sorts active frequencies before inactive frequencies, then by frequency and id', () => {
    const sorted = sortNetworkFreqsByTableOrder([
      createFreq({ networkFreqId: 30, freq: '652.3000', isActive: true }),
      createFreq({ networkFreqId: 10, freq: '30.0000', isActive: false }),
      createFreq({ networkFreqId: 20, freq: '652.3000', isActive: false }),
      createFreq({ networkFreqId: 40, freq: '652.3000', isActive: true }),
    ]);

    expect(sorted.map((freq) => freq.networkFreqId)).toEqual([30, 40, 10, 20]);
  });

  it('keeps adjacent active and inactive frequencies on separate rows', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.5000', isActive: true }),
        createFreq({ networkFreqId: 20, freq: '652.5100', isActive: false }),
      ],
      new Map(),
      new Map(),
      [],
    );

    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      { kind: 'freq', displayFreq: '652.5000' },
      { kind: 'freq', displayFreq: '652.5100' },
    ]);
  });

  it('keeps an active row above a nearby inactive row in the overall table order', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.5000', isActive: true }),
        createFreq({ networkFreqId: 20, freq: '652.5100', isActive: false }),
      ],
      new Map(),
      new Map(),
      [],
    );

    const sortedRows = sortNetworkFreqRowsByTableOrder(rows, [{ id: 'displayFreq', desc: false }], 'Усі');

    expect(sortedRows.map((row) => row.id)).toEqual(['freq-10', 'freq-20']);
  });

  it('keeps expanded children attached to their parent group when sorting rows', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.5000', messageCount: 20, isActive: true }),
        createFreq({ networkFreqId: 11, freq: '652.5100', messageCount: 30, isActive: true }),
        createFreq({ networkFreqId: 20, freq: '652.9000', messageCount: 5, isActive: true }),
      ],
      new Map(),
      new Map(),
      ['freq-group:10-11'],
    );

    const sortedRows = sortNetworkFreqRowsByTableOrder(rows, [{ id: 'messageCount', desc: false }], 'Усі');

    expect(sortedRows.map((row) => row.id)).toEqual(['freq-20', 'freq-group:10-11', 'freq-10', 'freq-11']);
  });

  it('preserves DMRe as a distinct frequency type label', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.1111', modulation: 'DMRe' }),
        createFreq({ networkFreqId: 11, freq: '652.1500', modulation: 'DMR' }),
      ],
      new Map(),
      new Map(),
      [],
    );

    expect(rows).toMatchObject([
      { kind: 'freq', typeLabel: 'DMRe' },
      { kind: 'freq', typeLabel: 'DMR' },
    ]);
  });

  it('does not group adjacent active and inactive frequencies', () => {
    const rows = buildNetworkFreqRows(
      [
        createFreq({ networkFreqId: 10, freq: '652.1111', isActive: true }),
        createFreq({ networkFreqId: 11, freq: '652.1200', isActive: false }),
      ],
      new Map(),
      new Map(),
      [],
    );

    expect(rows).toMatchObject([
      { kind: 'freq', displayFreq: '652.1111' },
      { kind: 'freq', displayFreq: '652.1200' },
    ]);
  });

  it('preserves activity for duplicate frequency labels across rows', () => {
    const activity = buildNetworkFreqActivityByFreq(
      {
        '2026-05-09': {
          '652.1111': 7,
        },
      },
      [
        createFreq({ networkFreqId: 10, freq: '652.1111' }),
        createFreq({ networkFreqId: 11, freq: '652.1111', isActive: false }),
      ],
    );

    expect(activity[10]).toEqual([{ day: '2026-05-09', messageCount: 7 }]);
    expect(activity[11]).toEqual([{ day: '2026-05-09', messageCount: 7 }]);
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
