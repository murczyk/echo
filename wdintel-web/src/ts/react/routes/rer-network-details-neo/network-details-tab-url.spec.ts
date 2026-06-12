import { describe, expect, it } from 'vitest';

import { readRequestedNetworkDetailsTab, resolveRequestedNetworkDetailsTab } from './network-details-tab-url';

describe('network-details tab url mapping', () => {
  it('maps public tab names to internal tabs', () => {
    expect(resolveRequestedNetworkDetailsTab('direction-finding', true, true)).toBe('pelengation');
    expect(resolveRequestedNetworkDetailsTab('justifications', true, true)).toBe('descriptions');
    expect(resolveRequestedNetworkDetailsTab('connections-graph', true, true)).toBe('relations');
  });

  it('falls back when a gated tab is unavailable', () => {
    expect(resolveRequestedNetworkDetailsTab('activity', false, true)).toBe('descriptions');
    expect(resolveRequestedNetworkDetailsTab('connections-graph', true, false)).toBe('descriptions');
  });

  it('reads tab from search params', () => {
    expect(readRequestedNetworkDetailsTab('?tab=direction-finding')).toBe('direction-finding');
    expect(readRequestedNetworkDetailsTab('')).toBeNull();
  });
});
