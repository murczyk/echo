/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';

vi.mock('../../../services/api/networks', () => ({
  getNetworkCallsignRelationMessages: vi.fn(),
}));

vi.mock('./NetworkDatePickerField', () => ({
  NetworkDatePickerField: ({ label }: { label: string }) => <div data-testid={`date-picker-${label}`} />,
}));

vi.mock('./NetworkCallsignRelationsGraphFilters', () => ({
  NetworkCallsignRelationsGraphFilters: () => <div data-testid="graph-filters" />,
}));

import { getNetworkCallsignRelationMessages } from '../../../services/api/networks';
import { NetworkCallsignRelationsGraph } from './NetworkCallsignRelationsGraph';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function createGraph(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      {
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 3,
        relationCount: 1,
        activityCount: 3,
        mainRadioStation: true,
        commandControl: false,
        position: null,
        unitName: null,
        knownCallsignId: null,
      },
      {
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 2,
        relationCount: 1,
        activityCount: 2,
        mainRadioStation: false,
        commandControl: true,
        position: null,
        unitName: null,
        knownCallsignId: null,
      },
    ],
    edges: [
      {
        id: 'ALPHA__BRAVO',
        source: 'ALPHA',
        target: 'BRAVO',
        weight: 2,
        byFreq: [{ freq: '652.111', weight: 2 }],
      },
    ],
    freqs: [{ freq: '652.111', enabledByDefault: true }],
  };
}

function renderGraph() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const deferred = (() => {
    let resolve!: (value: { messages: Array<{ id: number; timestamp: number | null; freq: string | null; text: string; callsigns: string[] }> }) => void;
    const promise = new Promise<{ messages: Array<{ id: number; timestamp: number | null; freq: string | null; text: string; callsigns: string[] }> }>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  })();

  vi.mocked(getNetworkCallsignRelationMessages).mockImplementation(() => deferred.promise);

  act(() => {
    root.render(
      <NetworkCallsignRelationsGraph
        networkId={42}
        relations={createGraph()}
        relationsSearch=""
        relationsEnabledFreqs={['652.111']}
        relationsMinIntensity={1}
        relationsShowLabels={true}
        relationsSelectedNodeId="ALPHA"
        relationsSelectedEdgeId={null}
        relationsSince="2026-05-20"
        relationsTill="2026-05-21"
        relationsLoading={false}
        onSearchChange={vi.fn()}
        onEnabledFreqsChange={vi.fn()}
        onMinIntensityChange={vi.fn()}
        onShowLabelsChange={vi.fn()}
        onSelectNodeId={vi.fn()}
        onSelectEdgeId={vi.fn()}
        onRelationsSinceChange={vi.fn()}
        onRelationsTillChange={vi.fn()}
      />,
    );
  });

  return { container, root, deferred };
}

describe('NetworkCallsignRelationsGraph', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('loads selected node messages and renders them in the details panel', async () => {
    const view = renderGraph();
    rendered.push(view);

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Завантажуємо повідомлення');

    await act(async () => {
      view.deferred.resolve({
        messages: [
          {
            id: 7,
            timestamp: 1717000000000,
            freq: '652.111',
            text: 'hello',
            callsigns: ['ALPHA'],
          },
        ],
      });
      await view.deferred.promise;
    });

    expect(view.container.textContent).toContain('hello');
    expect(view.container.textContent).toContain('652.111');
  });
});
