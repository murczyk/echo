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
vi.mock('../../utils/focus', () => ({
  blurActiveElement: vi.fn(),
}));

import { useRerNetworkDetailsNeoPageCallsignActions } from './use-rer-network-details-neo-page.callsign-actions';
import { createNetworkCallsign, updateNetworkCallsign } from '../../services/api/callsigns';
import { blurActiveElement } from '../../utils/focus';
import { createDefaultNetworkCallsignDrawerForm } from './network-callsigns.forms';
import type { NetworkCallsignDrawerForm } from './network-callsigns.types';

type HookResult = ReturnType<typeof useRerNetworkDetailsNeoPageCallsignActions>;

let root: Root | null = null;
let latestActions: HookResult | null = null;
let latestState: NetworkDetailsNeoPageState | null = null;

function Harness({
  unitIds,
  initialState = {},
}: {
  unitIds: number[];
  initialState?: Partial<NetworkDetailsNeoPageState>;
}) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>({
    ...EMPTY_STATE,
    ...initialState,
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

function renderHarness(unitIds: number[], initialState?: Partial<NetworkDetailsNeoPageState>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(createElement(Harness, { unitIds, initialState }));
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

  it('blurs focus before closing a non-saving drawer', () => {
    renderHarness([101]);
    act(() => {
      latestActions?.openCallsignDrawerForCreate();
    });
    vi.mocked(blurActiveElement).mockImplementation(() => {
      expect(latestState?.callsignDrawerOpen).toBe(true);
    });

    act(() => {
      latestActions?.closeCallsignDrawer();
    });

    expect(blurActiveElement).toHaveBeenCalledOnce();
    expect(latestState?.callsignDrawerOpen).toBe(false);
  });

  it('does not blur or close a saving drawer', () => {
    const form = createDefaultNetworkCallsignDrawerForm(17, 101);
    renderHarness([101], {
      callsignDrawerOpen: true,
      callsignDrawerSaving: true,
      callsignDrawerForm: form,
    });

    act(() => {
      latestActions?.closeCallsignDrawer();
    });

    expect(blurActiveElement).not.toHaveBeenCalled();
    expect(latestState?.callsignDrawerOpen).toBe(true);
  });

  it.each([
    ['create', createNetworkCallsign],
    ['edit', updateNetworkCallsign],
  ] as const)('blurs focus after a successful %s save', async (mode, apiCall) => {
    vi.mocked(apiCall).mockResolvedValue({} as never);
    const form: NetworkCallsignDrawerForm = {
      ...createDefaultNetworkCallsignDrawerForm(17, 101),
      id: mode === 'edit' ? 4 : null,
      callsign: 'СОКІЛ',
    };
    renderHarness([101], {
      callsignDrawerOpen: true,
      callsignDrawerMode: mode,
      callsignDrawerForm: form,
    });
    vi.mocked(blurActiveElement).mockImplementation(() => {
      expect(latestState?.callsignDrawerOpen).toBe(true);
    });

    await act(async () => {
      await latestActions?.saveCallsignDrawer();
    });

    expect(blurActiveElement).toHaveBeenCalledOnce();
    expect(latestState?.callsignDrawerOpen).toBe(false);
  });

  it('does not blur when saving fails', async () => {
    vi.mocked(createNetworkCallsign).mockRejectedValue(new Error('failed'));
    renderHarness([101]);
    act(() => {
      latestActions?.openCallsignDrawerForCreate({ callsign: 'СОКІЛ' });
    });

    await act(async () => {
      await latestActions?.saveCallsignDrawer();
    });

    expect(blurActiveElement).not.toHaveBeenCalled();
    expect(latestState?.callsignDrawerOpen).toBe(true);
  });
});
