import { describe, expect, it } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../Bindings';
import {
  deriveRelationsEnabledFreqs,
  isCurrentRelationsWindow,
} from './use-rer-network-details-neo-page.load';

function makeRelations(freqs: NetworkCallsignRelationsRsp['freqs']): NetworkCallsignRelationsRsp {
  return {
    nodes: [],
    edges: [],
    freqs,
  };
}

describe('use-rer-network-details-neo-page.load relations helpers', () => {
  it('falls back to enabled-by-default frequencies when the previous selection no longer matches', () => {
    expect(
      deriveRelationsEnabledFreqs(
        ['652.111'],
        makeRelations([{ freq: '652.111', enabledByDefault: true }]),
        makeRelations([
          { freq: '852.111', enabledByDefault: true },
          { freq: '445.500', enabledByDefault: false },
        ]),
      ),
    ).toEqual(['852.111']);
  });

  it('falls back to all returned frequencies when none are enabled by default', () => {
    expect(
      deriveRelationsEnabledFreqs(
        [],
        null,
        makeRelations([
          { freq: '652.111', enabledByDefault: false },
          { freq: '852.111', enabledByDefault: false },
        ]),
      ),
    ).toEqual(['652.111', '852.111']);
  });

  it('detects when the current UI window still matches the request window', () => {
    const since = Date.parse('2026-05-20T00:00:00Z');
    const till = Date.parse('2026-05-21T00:00:00Z');

    expect(isCurrentRelationsWindow('2026-05-20', '2026-05-20', since, till)).toBe(true);
    expect(isCurrentRelationsWindow('2026-05-21', '2026-05-21', since, till)).toBe(false);
  });
});
