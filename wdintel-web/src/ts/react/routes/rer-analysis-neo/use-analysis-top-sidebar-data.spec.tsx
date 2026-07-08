/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from './helpers';
import { useAnalysisTopSidebarData } from './use-analysis-top-sidebar-data';

type HookResult = ReturnType<typeof useAnalysisTopSidebarData>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;

function Harness() {
  latest = useAnalysisTopSidebarData({
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    optionsFreqValues: ['100.0000'],
    queryState: emptyQueryState(),
  });
  return null;
}

function renderHook() {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(Harness));
  });

  if (!latest) throw new Error('Hook did not render');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  vi.clearAllMocks();
});

describe('useAnalysisTopSidebarData', () => {
  it('keeps top sidebar counters visible while invalidating the right sidebar load state', () => {
    renderHook();

    act(() => {
      latest?.setTopFreqs([{ key: '100.0000', count: 3 }]);
      latest?.setTopCallsigns([{ key: 'ABC', count: 2 }]);
      latest?.setTopLocations([{ key: 'Kyiv', count: 4 }]);
      latest?.setTopUnits([{ key: 'Unit 1', count: 5 }]);
    });

    expect(latest?.topFreqs).toEqual([{ key: '100.0000', count: 3 }]);
    expect(latest?.topCallsigns).toEqual([{ key: 'ABC', count: 2 }]);
    expect(latest?.topLocations).toEqual([{ key: 'Kyiv', count: 4 }]);
    expect(latest?.topUnits).toEqual([{ key: 'Unit 1', count: 5 }]);

    act(() => {
      latest?.invalidateRightSidebarData();
    });

    expect(latest?.topFreqs).toEqual([{ key: '100.0000', count: 3 }]);
    expect(latest?.topCallsigns).toEqual([{ key: 'ABC', count: 2 }]);
    expect(latest?.topLocations).toEqual([{ key: 'Kyiv', count: 4 }]);
    expect(latest?.topUnits).toEqual([{ key: 'Unit 1', count: 5 }]);
  });
});
