/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallsignInfoRes, InboxMessage, Network, Unit } from '../../../../../Bindings';
import { getUnitsByIds } from '../../../services/api/units';
import { fetchNetworksByIds } from '../../../services/api/analysis';
import { invalidateUnitCatalog, reconcileUnitCatalog } from '../../../services/unit-catalog-events';
import { useAnalysisReferenceState } from '../use-analysis-reference-state';
import { useLoadMissingNetworksForMessages } from '../use-analysis-data.support';

vi.mock('../../../services/api/units', () => ({ getUnitsByIds: vi.fn() }));
vi.mock('../../../services/api/analysis', () => ({ fetchNetworksByIds: vi.fn() }));

describe('Analysis unit reference regression #3571', () => {
  let root: Root;
  let container: HTMLDivElement;
  let references: ReturnType<typeof useAnalysisReferenceState>;
  let hydrate: ReturnType<typeof useLoadMissingNetworksForMessages>;
  let loadedNetworks: Network[];
  const onError = vi.fn();

  function Harness({
    scopeKey = 'original',
    messages = [],
  }: {
    scopeKey?: string;
    messages?: Array<[number, InboxMessage]>;
  }) {
    const messagesRef = useRef(messages);
    messagesRef.current = messages;
    references = useAnalysisReferenceState({ messagesRef, shouldLoadNewCallsigns: false, onError });
    loadedNetworks = references.networks;
    hydrate = useLoadMissingNetworksForMessages({
      scopeKey,
      hideNetworks: false,
      loadUnitsByIds: references.loadUnitsByIds,
      setUnitsMap: references.setUnitsMap,
      unitsMap: references.unitsMap,
      networksRef: references.networksRef,
      setNetworks: references.setNetworks,
      setNetworkDisplayMap: references.setNetworkDisplayMap,
      onError,
      onUnauthorized: () => false,
    });
    return null;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    invalidateUnitCatalog();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads units introduced only by later callsign metadata and clears deleted records', async () => {
    vi.mocked(getUnitsByIds).mockResolvedValue([{ id: 7, name: 'Callsign unit' } as Unit]);
    await act(async () =>
      references.setSummaryCallsignsInfo({
        alpha: { res: [{ unitId: 7 }] } as CallsignInfoRes,
      }),
    );
    expect(references.unitsMap[7]?.name).toBe('Callsign unit');
    expect(getUnitsByIds).toHaveBeenCalledTimes(1);
    vi.mocked(getUnitsByIds).mockResolvedValue([]);
    await act(async () => invalidateUnitCatalog());
    expect(references.unitsMap[7]).toBeUndefined();
    expect(getUnitsByIds).toHaveBeenCalledTimes(2);
    await act(async () =>
      references.setSummaryCallsignsInfo({
        alpha: { res: [{ unitId: 7 }] } as CallsignInfoRes,
      }),
    );
    expect(references.unitsMap[7]).toBeUndefined();
  });

  it.each(['original', ''])(
    'rehydrates current message, network and callsign units after window-only reconciliation with nonce "%s"',
    async (nonce) => {
      await act(async () => reconcileUnitCatalog(`1:${nonce}`, false));
      const oldUnits = [3, 5, 7, 9].map((id) => ({ id, name: `Old unit ${id}` }) as Unit);
      vi.mocked(getUnitsByIds).mockResolvedValue(oldUnits);
      await act(async () => {
        root.render(
          createElement(Harness, {
            messages: [[1, { unitIds: [3, 9] } as InboxMessage]],
          }),
        );
        references.setNetworks([{ id: 11, name: 'Network', unitIds: [5] } as Network]);
        references.setSummaryCallsignsInfo({
          alpha: { res: [{ unitId: 7 }] } as CallsignInfoRes,
        });
      });
      expect(references.networkDisplayMap[11]).toContain('Old unit 5');
      const refreshedUnits = [3, 5, 7].map((id) => ({ id, name: `Fresh unit ${id}` }) as Unit);
      vi.mocked(getUnitsByIds).mockClear().mockResolvedValue(refreshedUnits);

      await act(async () => reconcileUnitCatalog(`2:${nonce}`, false));

      expect(getUnitsByIds).toHaveBeenCalledExactlyOnceWith(
        expect.arrayContaining([3, 5, 7, 9]),
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(references.unitsMap).toEqual(
        Object.fromEntries(refreshedUnits.map((unit) => [unit.id, unit])),
      );
      expect(references.networkDisplayMap[11]).toContain('Fresh unit 5');
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(['scope', 'scope-return', 'catalog', 'unmount'])(
    'discards network hydration after %s changes',
    async (change) => {
      let resolve!: (networks: Network[]) => void;
      vi.mocked(fetchNetworksByIds).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      let pending!: Promise<void>;
      await act(async () => {
        pending = hydrate([[1, { networkIds: [5], unitIds: [] } as unknown as InboxMessage]]);
      });
      await act(async () => {
        if (change.startsWith('scope')) root.render(createElement(Harness, { scopeKey: 'other' }));
        else if (change === 'catalog') invalidateUnitCatalog();
        else root.render(null);
      });
      if (change === 'scope-return') {
        await act(async () => root.render(createElement(Harness, { scopeKey: 'original' })));
      }
      await act(async () => {
        resolve([{ id: 5, unitIds: [7] } as Network]);
        await pending;
      });
      expect(getUnitsByIds).not.toHaveBeenCalled();
      expect(loadedNetworks).toEqual([]);
      expect(onError).not.toHaveBeenCalled();
    },
  );
});
