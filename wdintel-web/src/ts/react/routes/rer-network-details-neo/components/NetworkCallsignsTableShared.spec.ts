/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { buildNetworkColumnOrder, buildNetworkLoadingRows } from './NetworkCallsignsTableShared';

describe('network callsigns table shared helpers', () => {
  it('keeps row numbers before actions in the default order', () => {
    expect(
      buildNetworkColumnOrder({
        dataColumnIds: ['callsign', 'position'],
      }),
    ).toEqual(['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position']);
  });

  it('builds loading rows with both markers disabled', () => {
    expect(buildNetworkLoadingRows()[0]).toMatchObject({
      mainRadioStation: false,
      commandControl: false,
    });
  });
});
