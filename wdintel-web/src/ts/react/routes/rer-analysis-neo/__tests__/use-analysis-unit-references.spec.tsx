/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallsignInfoRes, InboxMessage, Network, Unit } from '../../../../../Bindings';
import { getUnitsByIds } from '../../../services/api/units';
import { fetchNetworksByIds } from '../../../services/api/analysis';
import { invalidateUnitCatalog } from '../../../services/unit-catalog-events';
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

  function Harness({ scopeKey = 'original' }: { scopeKey?: string }) {
    references = useAnalysisReferenceState({ shouldLoadNewCallsigns: false, onError });
    const [networks, setNetworks] = useState<Network[]>([]);
    const networksRef = useRef(networks);
    networksRef.current = networks;
    loadedNetworks = networks;
    hydrate = useLoadMissingNetworksForMessages({
      scopeKey,
      hideNetworks: false,
      loadUnitsByIds: references.loadUnitsByIds,
      setUnitsMap: references.setUnitsMap,
      unitsMap: references.unitsMap,
      networksRef,
      setNetworks,
      setNetworkDisplayMap: vi.fn(),
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
    await act(async () => invalidateUnitCatalog());
    expect(references.unitsMap[7]).toBeUndefined();
    vi.mocked(getUnitsByIds).mockResolvedValue([]);
    await act(async () =>
      references.setSummaryCallsignsInfo({
        alpha: { res: [{ unitId: 7 }] } as CallsignInfoRes,
      }),
    );
    expect(references.unitsMap[7]).toBeUndefined();
  });

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
