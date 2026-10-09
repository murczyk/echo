/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
const mocks = vi.hoisted(() => ({
  getNetworksByIds: vi.fn(),
  getUnitsByIds: vi.fn(),
  getUnitsList: vi.fn(),
}));

vi.mock('../../../services/api/networks', () => ({ getNetworksByIds: mocks.getNetworksByIds }));
vi.mock('../../../services/api/units', () => ({
  getUnitsByIds: mocks.getUnitsByIds,
  getUnitsList: mocks.getUnitsList,
}));

import { useRerDutyReferenceData } from '../useRerDutyReferenceData';
import { emptyFilter, type MessageFeedState } from '../utils';

let root: Root | null = null;
let latest: ReturnType<typeof useRerDutyReferenceData> | null = null;

function buildFeed(): MessageFeedState {
  return {
    id: 'feed-1',
    filter: emptyFilter(),
    items: [[0, { networkIds: [7] } as InboxMessage]],
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
  };
}

function Harness({ hideNetworks }: { hideNetworks: boolean }) {
  latest = useRerDutyReferenceData([buildFeed()], hideNetworks);
  return null;
}

function renderHook(hideNetworks: boolean) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness, { hideNetworks })));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('useRerDutyReferenceData', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('loads the unit catalog once while hidden network hydration stays suppressed', async () => {
    mocks.getUnitsList.mockResolvedValue([{ id: 3, name: 'Підрозділ' }]);
    mocks.getNetworksByIds.mockResolvedValue([]);
    mocks.getUnitsByIds.mockResolvedValue([]);
    renderHook(true);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.getUnitsList).toHaveBeenCalledOnce();
    expect(mocks.getNetworksByIds).not.toHaveBeenCalled();
    expect(mocks.getUnitsByIds).not.toHaveBeenCalled();
    expect(latest?.unitsMap).toMatchObject({ 3: { name: 'Підрозділ' } });

    await act(async () => {
      root?.render(createElement(Harness, { hideNetworks: false }));
    });
    expect(mocks.getUnitsList).toHaveBeenCalledOnce();
  });
});
