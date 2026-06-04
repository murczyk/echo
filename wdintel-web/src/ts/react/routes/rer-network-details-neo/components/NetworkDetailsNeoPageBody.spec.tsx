/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import { buildCallsignPanelProps } from '../network-callsigns-page';

describe('NetworkDetailsNeoPageBody callsign props', () => {
  it('opens intercepted callsigns with the expected create defaults', () => {
    const openCallsignDrawerForCreate = vi.fn();
    const page = {
      sources: [],
      networkCallsigns: [],
      catalogCallsignGroups: [],
      unknownInterceptedCallsigns: [],
      callsignsLoading: false,
      callsignsError: null,
      canManageCallsignActions: true,
      callsignSectionMode: 'network',
      setCallsignSectionMode: vi.fn(),
      callsignStatusFilter: 'All',
      setCallsignStatusFilter: vi.fn(),
      callsignInterceptedExpanded: false,
      toggleCallsignInterceptedExpanded: vi.fn(),
      openCallsignDrawerForCreate,
      openCallsignDrawerForEdit: vi.fn(),
      openCallsignDeleteDialog: vi.fn(),
      setNetworkCallsignMarkerMode: vi.fn(),
      addKnownCallsignsToNetwork: vi.fn(),
      loadCallsigns: vi.fn(),
      callsignCreateInFlightCallsigns: [],
      callsignCatalogAddInFlightIds: [],
      callsignUpdateInFlightIds: [],
      callsignDeleteInFlightIds: [],
    };

    const callsignPanelProps = buildCallsignPanelProps(page);
    callsignPanelProps.onAddInterceptedToDeveloping('ABC-1');
    callsignPanelProps.onAddInterceptedToNetwork('XYZ-2');

    expect(openCallsignDrawerForCreate).toHaveBeenNthCalledWith(1, {
      callsign: 'ABC-1',
      developing: true,
    });
    expect(openCallsignDrawerForCreate).toHaveBeenNthCalledWith(2, {
      callsign: 'XYZ-2',
      developing: false,
    });
  });
});
