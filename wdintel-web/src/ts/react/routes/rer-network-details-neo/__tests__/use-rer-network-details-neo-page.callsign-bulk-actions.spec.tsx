/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network, NetworkCallsign, User } from '../../../../../Bindings';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
} from '../use-rer-network-details-neo-page.types';

vi.mock('../../../services/api/callsigns', () => ({
  deleteNetworkCallsigns: vi.fn(),
}));

import {
  isCatalogDeletableNetworkCallsign,
  useRerNetworkDetailsNeoPageCallsignBulkActions,
} from '../use-rer-network-details-neo-page.callsign-bulk-actions';
import { deleteNetworkCallsigns } from '../../../services/api/callsigns';

type HookResult = ReturnType<typeof useRerNetworkDetailsNeoPageCallsignBulkActions>;

let root: Root | null = null;
let latestActions: HookResult | null = null;
let latestState: NetworkDetailsNeoPageState | null = null;
const reloadCallsignsData = vi.fn(() => Promise.resolve());

function createNetworkCallsign(id: number, overrides: Partial<NetworkCallsign> = {}) {
  return {
    id,
    networkId: 17,
    callsign: `сокіл-${id}`,
    knownCallsignId: null,
    developing: false,
    ...overrides,
  } as NetworkCallsign;
}

function Harness({
  roles,
  initialState,
}: {
  roles: string[];
  initialState: Partial<NetworkDetailsNeoPageState>;
}) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>({
    ...EMPTY_STATE,
    ...initialState,
    network: { id: 17 } as Network,
    currentUser: { roles } as User,
  });

  latestState = state;
  latestActions = useRerNetworkDetailsNeoPageCallsignBulkActions({
    state,
    setState,
    reloadCallsignsData,
  });

  return null;
}

function renderHarness(
  initialState: Partial<NetworkDetailsNeoPageState> = {},
  roles: string[] = ['Admin'],
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(createElement(Harness, { roles, initialState }));
  });
}

const NETWORK_CALLSIGNS = [
  createNetworkCallsign(1, { knownCallsignId: 11 }),
  createNetworkCallsign(2),
  createNetworkCallsign(3),
];

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

describe('useRerNetworkDetailsNeoPageCallsignBulkActions', () => {
  it('enters selection mode empty and leaves it with the selection cleared', () => {
    renderHarness({ networkCallsigns: NETWORK_CALLSIGNS, selectedNetworkCallsignIds: [2] });

    act(() => latestActions?.enterCallsignSelectionMode());
    expect(latestState?.callsignSelectionMode).toBe(true);
    expect(latestState?.selectedNetworkCallsignIds).toEqual([]);

    act(() => latestActions?.setSelectedNetworkCallsignIds([1, 3]));
    act(() => latestActions?.exitCallsignSelectionMode());
    expect(latestState?.callsignSelectionMode).toBe(false);
    expect(latestState?.selectedNetworkCallsignIds).toEqual([]);
  });

  it('does not enter selection mode without network callsign edit rights', () => {
    renderHarness({}, ['Rer']);

    act(() => latestActions?.enterCallsignSelectionMode());

    expect(latestState?.callsignSelectionMode).toBe(false);
  });

  it('opens the dialog only when something is selected', () => {
    renderHarness({ networkCallsigns: NETWORK_CALLSIGNS, callsignSelectionMode: true });

    act(() => latestActions?.openCallsignBulkDeleteDialog());
    expect(latestState?.callsignBulkDeleteDialogOpen).toBe(false);

    act(() => latestActions?.setSelectedNetworkCallsignIds([1]));
    act(() => latestActions?.openCallsignBulkDeleteDialog());
    expect(latestState?.callsignBulkDeleteDialogOpen).toBe(true);
    expect(latestState?.callsignBulkDeleteTargets.map(({ id }) => id)).toEqual([1]);
  });

  it('keeps the confirmed callsigns until the dialog has exited', () => {
    renderHarness({
      networkCallsigns: NETWORK_CALLSIGNS,
      callsignSelectionMode: true,
      selectedNetworkCallsignIds: [2],
    });

    act(() => latestActions?.openCallsignBulkDeleteDialog());
    act(() => latestActions?.setCallsignBulkDeleteAlsoFromCatalog(true));
    act(() => latestActions?.closeCallsignBulkDeleteDialog());
    expect(latestState?.callsignBulkDeleteDialogOpen).toBe(false);
    expect(latestState?.callsignBulkDeleteTargets.map(({ id }) => id)).toEqual([2]);
    expect(latestState?.callsignBulkDeleteAlsoFromCatalog).toBe(true);

    act(() => latestActions?.resetCallsignBulkDeleteDialog());
    expect(latestState?.callsignBulkDeleteTargets).toEqual([]);
    expect(latestState?.callsignBulkDeleteAlsoFromCatalog).toBe(false);
    expect(latestState?.selectedNetworkCallsignIds).toEqual([2]);
  });

  it('deletes the selected callsigns in one request, leaves selection mode and reloads', async () => {
    vi.mocked(deleteNetworkCallsigns).mockResolvedValue({
      deletedIds: [1, 3],
      deletedCatalogCallsignIds: [11],
    });
    renderHarness({
      networkCallsigns: NETWORK_CALLSIGNS,
      callsignSelectionMode: true,
      selectedNetworkCallsignIds: [3, 1, 99],
    });
    act(() => latestActions?.openCallsignBulkDeleteDialog());
    act(() => latestActions?.setCallsignBulkDeleteAlsoFromCatalog(true));

    await act(async () => {
      await latestActions?.deleteSelectedCallsigns();
    });

    expect(deleteNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 17,
      ids: [1, 3],
      alsoDeleteFromCatalog: true,
    });
    expect(latestState).toMatchObject({
      callsignSelectionMode: false,
      selectedNetworkCallsignIds: [],
      callsignBulkDeleteDialogOpen: false,
      callsignBulkDeleteSubmitting: false,
      callsignBulkDeleteError: null,
      callsignDeleteInFlightIds: [],
    });
    expect(
      latestState?.callsignBulkDeleteTargets.map(({ id }) => id),
      'the closing dialog still shows what was deleted',
    ).toEqual([1, 3]);
    expect(reloadCallsignsData).toHaveBeenCalledTimes(1);
  });

  it('never asks to delete from the catalog without catalog edit rights', async () => {
    vi.mocked(deleteNetworkCallsigns).mockResolvedValue({
      deletedIds: [1],
      deletedCatalogCallsignIds: [],
    });
    renderHarness(
      {
        networkCallsigns: NETWORK_CALLSIGNS,
        callsignSelectionMode: true,
        selectedNetworkCallsignIds: [1],
      },
      ['Rer', 'UnitsEditor'],
    );
    act(() => latestActions?.openCallsignBulkDeleteDialog());
    act(() => latestActions?.setCallsignBulkDeleteAlsoFromCatalog(true));

    await act(async () => {
      await latestActions?.deleteSelectedCallsigns();
    });

    expect(deleteNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 17,
      ids: [1],
      alsoDeleteFromCatalog: false,
    });
  });

  it('keeps the dialog and selection open with the error when the request fails', async () => {
    vi.mocked(deleteNetworkCallsigns).mockRejectedValue(new Error('Позивні вже видалені'));
    renderHarness({
      networkCallsigns: NETWORK_CALLSIGNS,
      callsignSelectionMode: true,
      selectedNetworkCallsignIds: [2],
    });
    act(() => latestActions?.openCallsignBulkDeleteDialog());

    await act(async () => {
      await latestActions?.deleteSelectedCallsigns();
    });

    expect(latestState?.callsignBulkDeleteDialogOpen).toBe(true);
    expect(latestState?.callsignBulkDeleteSubmitting).toBe(false);
    expect(latestState?.callsignBulkDeleteError).toContain('Позивні вже видалені');
    expect(latestState?.callsignSelectionMode).toBe(true);
    expect(latestState?.selectedNetworkCallsignIds).toEqual([2]);
    expect(latestState?.callsignDeleteInFlightIds).toEqual([]);
    expect(reloadCallsignsData).toHaveBeenCalledTimes(1);
  });

  it('treats only catalog-linked rows outside further reconnaissance as catalog deletable', () => {
    expect(isCatalogDeletableNetworkCallsign({ developing: false, knownCallsignId: 11 })).toBe(
      true,
    );
    expect(isCatalogDeletableNetworkCallsign({ developing: true, knownCallsignId: 11 })).toBe(
      false,
    );
    expect(isCatalogDeletableNetworkCallsign({ developing: false, knownCallsignId: null })).toBe(
      false,
    );
  });
});
