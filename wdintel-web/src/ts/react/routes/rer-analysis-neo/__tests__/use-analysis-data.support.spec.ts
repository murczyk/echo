import { describe, expect, it, vi } from 'vitest';

import { emptyNewCallsigns } from '../use-analysis-data.shared';
import { invalidateNewCallsignsLoadState } from '../use-analysis-data.support';

// @test-scope safeguard: prevents an invalidated callsign request from suppressing its required reload.
describe('invalidateNewCallsignsLoadState', () => {
  it('clears the loading state and invalidates prior request keys', () => {
    const setNewCallsigns = vi.fn();
    const setNewCallsignsLoading = vi.fn();
    const newCallsignsRequestRef = { current: 7 };
    const newCallsignsLoadedKeyRef = { current: 'loaded' };
    const newCallsignsPendingKeyRef = { current: 'pending' };

    invalidateNewCallsignsLoadState({
      setNewCallsigns,
      setNewCallsignsLoading,
      newCallsignsRequestRef,
      newCallsignsLoadedKeyRef,
      newCallsignsPendingKeyRef,
    });

    expect(setNewCallsigns).toHaveBeenCalledWith(emptyNewCallsigns);
    expect(setNewCallsignsLoading).toHaveBeenCalledWith(false);
    expect(newCallsignsRequestRef.current).toBe(8);
    expect(newCallsignsLoadedKeyRef.current).toBeNull();
    expect(newCallsignsPendingKeyRef.current).toBeNull();
  });
});
