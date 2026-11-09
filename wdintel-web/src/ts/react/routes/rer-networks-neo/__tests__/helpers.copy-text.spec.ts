import { describe, expect, it } from 'vitest';

import type { Network, NetworkFreq } from '../../../../../Bindings';
import { buildNetworkCopyText, type NetworkRowView } from '../helpers';

function freq(overrides: Partial<NetworkFreq>): NetworkFreq {
  return {
    id: 1,
    networkId: 1,
    freq: '122.4000',
    deleted: false,
    activeFrom: 0,
    activeTo: null,
    createdAt: 0,
    modulation: 'NFM',
    encryptionId: null,
    encryptionKeys: [],
    ...overrides,
  };
}

function row(overrides: {
  location?: string;
  activeFrequencies?: NetworkFreq[];
  inactiveFrequencies?: NetworkFreq[];
}): NetworkRowView {
  return {
    networkLabel: 'р/м управління мінбатр 5 мсб 57 омсбр 5 ТА',
    network: { location: overrides.location ?? '' } as Network,
    activeFrequencies: overrides.activeFrequencies ?? [],
    inactiveFrequencies: overrides.inactiveFrequencies ?? [],
  } as NetworkRowView;
}

describe('buildNetworkCopyText', () => {
  it('formats name, location and frequency in a single line', () => {
    const text = buildNetworkCopyText(
      row({
        location: 'КАЛИНОВЕ, ЛИМАН ПЕРШИЙ,\nХАРКІВСЬКА ОБЛАСТЬ',
        activeFrequencies: [freq({})],
      }),
      true,
    );
    expect(text).toBe(
      'УКХ р/м управління мінбатр 5 мсб 57 омсбр 5 ТА (КАЛИНОВЕ, ЛИМАН ПЕРШИЙ, ХАРКІВСЬКА ОБЛАСТЬ), 122.400 МГц',
    );
  });

  it('falls back to inactive frequencies and omits empty location', () => {
    const text = buildNetworkCopyText(
      row({
        inactiveFrequencies: [
          freq({ freq: '146.1125', modulation: 'DMR' }),
          freq({ id: 2, freq: '150.0000', modulation: 'DMR' }),
        ],
      }),
      true,
    );
    expect(text).toBe('DMR р/м управління мінбатр 5 мсб 57 омсбр 5 ТА, 146.1125, 150.000 МГц');
  });

  it('omits deleted frequencies, including in the inactive fallback', () => {
    const text = buildNetworkCopyText(
      row({
        activeFrequencies: [freq({ freq: '160.0000', deleted: true })],
        inactiveFrequencies: [
          freq({ id: 2, freq: '150.0000', deleted: true }),
          freq({ id: 3, freq: '146.1125', modulation: 'DMR' }),
        ],
      }),
      true,
    );
    expect(text).toBe('DMR р/м управління мінбатр 5 мсб 57 омсбр 5 ТА, 146.1125 МГц');
  });

  it('omits unknown types from the prefix', () => {
    const text = buildNetworkCopyText(
      row({ activeFrequencies: [freq({ modulation: null }), freq({ id: 2, freq: '150.0000' })] }),
      true,
    );
    expect(text).toBe('УКХ р/м управління мінбатр 5 мсб 57 омсбр 5 ТА, 122.400, 150.000 МГц');
  });

  it('omits type and frequencies when radio features are hidden', () => {
    const text = buildNetworkCopyText(
      row({ location: 'КАЛИНОВЕ', activeFrequencies: [freq({})] }),
      false,
    );
    expect(text).toBe('р/м управління мінбатр 5 мсб 57 омсбр 5 ТА (КАЛИНОВЕ)');
  });
});
