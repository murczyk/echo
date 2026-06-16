import { describe, expect, it } from 'vitest';

import { getRestoreNetworkOnEditValue, NETWORK_STATUS_ACTIVE, NETWORK_STATUS_INACTIVE } from './network-status';

describe('getRestoreNetworkOnEditValue', () => {
  it('returns true for deleted active networks with an active window', () => {
    expect(getRestoreNetworkOnEditValue({ deleted: true, activeTo: 1 }, NETWORK_STATUS_ACTIVE)).toBe(true);
  });

  it('returns null for deleted active networks without an active window', () => {
    expect(getRestoreNetworkOnEditValue({ deleted: true, activeTo: null }, NETWORK_STATUS_ACTIVE)).toBeNull();
  });

  it('returns null for inactive status', () => {
    expect(getRestoreNetworkOnEditValue({ deleted: true, activeTo: 1 }, NETWORK_STATUS_INACTIVE)).toBeNull();
  });

  it('returns null for non-deleted networks', () => {
    expect(getRestoreNetworkOnEditValue({ deleted: false, activeTo: 1 }, NETWORK_STATUS_ACTIVE)).toBeNull();
  });

  it('returns null for missing networks', () => {
    expect(getRestoreNetworkOnEditValue(null, NETWORK_STATUS_ACTIVE)).toBeNull();
    expect(getRestoreNetworkOnEditValue(undefined, NETWORK_STATUS_ACTIVE)).toBeNull();
  });
});
