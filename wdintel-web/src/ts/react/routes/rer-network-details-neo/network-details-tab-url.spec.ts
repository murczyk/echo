/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  buildNetworkDetailsTabUrl,
  getPublicNetworkDetailsTab,
  readRequestedNetworkDetailsTab,
  resolveRequestedNetworkDetailsTab,
  updateCurrentNetworkDetailsTabUrl,
} from './network-details-tab-url';

describe('network-details tab url mapping', () => {
  it('maps public tab names to internal tabs', () => {
    expect(resolveRequestedNetworkDetailsTab('direction-finding', true, true)).toBe(
      'direction-finding',
    );
    expect(resolveRequestedNetworkDetailsTab('pelengation', true, true)).toBe('direction-finding');
    expect(resolveRequestedNetworkDetailsTab('justifications', true, true)).toBe('descriptions');
    expect(resolveRequestedNetworkDetailsTab('connections-graph', true, true)).toBe('relations');
  });

  it('falls back when a gated tab is unavailable', () => {
    expect(resolveRequestedNetworkDetailsTab('activity', false, true)).toBe('descriptions');
    expect(resolveRequestedNetworkDetailsTab('connections-graph', true, false)).toBe(
      'descriptions',
    );
  });

  it('maps internal tabs to public query values', () => {
    expect(getPublicNetworkDetailsTab('descriptions')).toBe('justifications');
    expect(getPublicNetworkDetailsTab('direction-finding')).toBe('direction-finding');
  });

  it('builds tab urls while preserving unrelated params', () => {
    expect(
      buildNetworkDetailsTabUrl(
        {
          pathname: '/rer-networks/42',
          search: '?view=classic&foo=bar',
          hash: '#summary',
        } as Location,
        'callsigns',
      ),
    ).toBe('/rer-networks/42?view=classic&foo=bar&tab=callsigns#summary');
  });

  it('reads tab from search params', () => {
    expect(readRequestedNetworkDetailsTab('?tab=direction-finding')).toBe('direction-finding');
    expect(readRequestedNetworkDetailsTab('')).toBeNull();
  });

  it('updates the current url in replace and push modes', () => {
    window.history.replaceState({}, '', '/rer-networks/42?foo=bar');
    updateCurrentNetworkDetailsTabUrl('relations', 'replace');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?foo=bar&tab=connections-graph',
    );

    updateCurrentNetworkDetailsTabUrl('callsigns', 'push');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?foo=bar&tab=callsigns',
    );
  });
});
