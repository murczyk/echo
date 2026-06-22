/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  buildNetworkColumnOrder,
  buildNetworkLoadingRows,
  CountChipLabel,
  NETWORK_STATUS_FILTER_ORDER,
} from './NetworkCallsignsTableShared';
import { NO_DATA_LABEL } from '../../../utils/misc';

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

  it('prioritizes developing before catalog in the status filter order', () => {
    expect(NETWORK_STATUS_FILTER_ORDER.slice(0, 4)).toEqual(['All', 'Developing', 'Catalog', 'Unknown']);
  });

  it('shows a dash when a count is still loading', () => {
    expect(CountChipLabel({ label: 'Всі', count: null }).props.children[1].props.children).toBe(NO_DATA_LABEL);
  });
});
