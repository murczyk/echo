/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network, User } from '../../../../Bindings';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.types';

vi.mock('../../services/api/callsigns', () => ({
  createNetworkCallsign: vi.fn(),
  deleteCallsign: vi.fn(),
  deleteNetworkCallsign: vi.fn(),
  updateNetworkCallsign: vi.fn(),
}));

import { useRerNetworkDetailsNeoPageCallsignActions } from './use-rer-network-details-neo-page.callsign-actions';

type HookResult = ReturnType<typeof useRerNetworkDetailsNeoPageCallsignActions>;

let root: Root | null = null;
let latestActions: HookResult | null = null;
let latestState: NetworkDetailsNeoPageState | null = null;

function Harness({ unitIds }: { unitIds: number[] }) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>({
    ...EMPTY_STATE,
    network: { id: 17, unitIds } as Network,
    currentUser: { roles: ['Admin'] } as User,
  });

  latestState = state;
  latestActions = useRerNetworkDetailsNeoPageCallsignActions({
    state,
    setState,
    loadCallsigns: vi.fn(),
  });

  return null;
}

function renderHarness(unitIds: number[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(createElement(Harness, { unitIds }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  latestActions = null;
  latestState = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('useRerNetworkDetailsNeoPageCallsignActions', () => {
  it('defaults a new callsign when the network has exactly one unit', () => {
    renderHarness([101]);

    act(() => {
      latestActions?.openCallsignDrawerForCreate({ developing: false });
    });

    expect(latestState?.callsignDrawerForm).toMatchObject({
      networkId: 17,
      unitId: 101,
      developing: false,
    });
  });

  it('requires an explicit unit choice when the network has multiple units', () => {
    renderHarness([101, 102]);

    act(() => {
      latestActions?.openCallsignDrawerForCreate({ developing: false });
    });

    expect(latestState?.callsignDrawerForm).toMatchObject({
      networkId: 17,
      unitId: null,
      developing: false,
    });
  });
});
