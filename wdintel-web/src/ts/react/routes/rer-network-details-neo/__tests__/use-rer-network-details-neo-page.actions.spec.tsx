/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network } from '../../../../../Bindings';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
  type NetworkEditForm,
} from '../use-rer-network-details-neo-page.types';
import { NETWORK_STATUS_ACTIVE } from '../network-status';

const apiMock = vi.hoisted(() => ({
  deleteNetwork: vi.fn(),
  updateNetwork: vi.fn(),
  updateNetworkPosts: vi.fn(),
  updateNetworkUnits: vi.fn(),
}));

vi.mock('../../../services/api/networks', () => ({
  deleteNetwork: apiMock.deleteNetwork,
  updateNetwork: apiMock.updateNetwork,
  updateNetworkPosts: apiMock.updateNetworkPosts,
  updateNetworkUnits: apiMock.updateNetworkUnits,
}));

vi.mock('../use-rer-network-details-neo-page.description-actions', () => ({
  useRerNetworkDetailsNeoPageDescriptionActions: () => ({}),
}));
vi.mock('../use-rer-network-details-neo-page.report-actions', () => ({
  useRerNetworkDetailsNeoPageReportActions: () => ({}),
}));
vi.mock('../use-rer-network-details-neo-page.frequency-actions', () => ({
  useRerNetworkDetailsNeoPageFrequencyActions: () => ({}),
}));
vi.mock('../use-rer-network-details-neo-page.callsign-actions', () => ({
  useRerNetworkDetailsNeoPageCallsignActions: () => ({}),
}));
vi.mock('../use-rer-network-details-neo-page.callsign-mutations', () => ({
  useRerNetworkDetailsNeoPageCallsignMutations: () => ({}),
}));
vi.mock('../../../utils/browser', () => ({
  navigateWithinSpa: vi.fn(),
}));

import { useRerNetworkDetailsNeoPageActions } from '../use-rer-network-details-neo-page.actions';

type HookResult = ReturnType<typeof useRerNetworkDetailsNeoPageActions>;

let root: Root | null = null;
let latestActions: HookResult | null = null;

function buildNetwork(overrides: Partial<Network> = {}): Network {
  return {
    id: 1,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: 'Network 1',
    location: 'Location 1',
    radioStation: null,
    createdAt: 1,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    doNotArchive: false,
    lastUpdatedAt: 1,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
    ...overrides,
  };
}

function buildEditForm(overrides: Partial<NetworkEditForm> = {}): NetworkEditForm {
  return {
    id: 1,
    name: 'Network 1',
    location: 'Location 1',
    radioStation: '',
    purpose: '',
    operationMode: '',
    operationType: '',
    operationPeriod: '',
    doNotArchive: false,
    status: NETWORK_STATUS_ACTIVE,
    aorIds: [1],
    unitIds: [],
    postIds: [],
    freq: '',
    modulation: 'DMR',
    encryptionId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
    ...overrides,
  };
}

function Harness({ network, editForm }: { network: Network; editForm: NetworkEditForm }) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>({
    ...EMPTY_STATE,
    network,
    editForm,
    editDrawerOpen: true,
    editInProgress: false,
    editError: null,
  });

  latestActions = useRerNetworkDetailsNeoPageActions({
    state,
    setState,
    unitNames: [],
    reloadGeneration: { current: 0 },
    currentNetworkIdRef: { current: null },
    loadCallsigns: vi.fn(),
  });

  return null;
}

function renderHarness(network: Network, editForm: NetworkEditForm) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;

  act(() => {
    mountedRoot.render(createElement(Harness, { network, editForm }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  latestActions = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

// @test-scope safeguard: prevents a failed network mutation from restoring stale data over a newer selected network.
describe('useRerNetworkDetailsNeoPageActions restore guard', () => {
  it('requests restore for deleted rows without an active window', async () => {
    apiMock.updateNetwork.mockResolvedValue(buildNetwork({ deleted: true, activeTo: null }));
    apiMock.updateNetworkPosts.mockResolvedValue(buildNetwork());
    apiMock.updateNetworkUnits.mockResolvedValue(buildNetwork());

    renderHarness(buildNetwork({ deleted: true, activeTo: null }), buildEditForm());

    await act(async () => {
      await latestActions?.saveNetworkEdit();
    });

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ restoreNetwork: true }),
    );
  });

  it('requests restore for deleted rows with an active window', async () => {
    apiMock.updateNetwork.mockResolvedValue(buildNetwork({ deleted: true, activeTo: 1 }));
    apiMock.updateNetworkPosts.mockResolvedValue(buildNetwork());
    apiMock.updateNetworkUnits.mockResolvedValue(buildNetwork());

    renderHarness(buildNetwork({ deleted: true, activeTo: 1 }), buildEditForm());

    await act(async () => {
      await latestActions?.saveNetworkEdit();
    });

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ restoreNetwork: true }),
    );
  });
});
