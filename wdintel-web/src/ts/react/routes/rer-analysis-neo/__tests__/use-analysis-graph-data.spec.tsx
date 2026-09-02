/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from '../helpers';
import { useAnalysisGraphData } from '../use-analysis-graph-data';

type HookResult = ReturnType<typeof useAnalysisGraphData>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;

function Harness() {
  latest = useAnalysisGraphData({
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    optionsFreqValues: ['100.0000'],
    queryState: {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-04-01T00:00',
      toDateTimeStr: '2026-04-02T00:00',
    },
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

// @test-scope safeguard: prevents graph data errors or stale responses from replacing the current analysis graph.
describe('useAnalysisGraphData', () => {
  it('keeps the current graph for a normal invalidation and clears it for a hard clear', () => {
    renderHook();

    act(() => {
      latest?.setCallsignGraph({
        nodes: [],
        edges: [],
        freqs: [],
      });
    });

    expect(latest?.callsignGraph).not.toBeNull();

    act(() => {
      latest?.invalidateCallsignGraph();
    });

    expect(latest?.callsignGraph).not.toBeNull();

    act(() => {
      latest?.invalidateCallsignGraph({ clearGraph: true });
    });

    expect(latest?.callsignGraph).toBeNull();
  });
});
