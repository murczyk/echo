/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../../Bindings';

let latestGraphProps: Record<string, unknown> | null = null;

vi.mock('../../../rer-network-details-neo/components/NetworkCallsignRelationsGraph', () => ({
  NetworkCallsignRelationsGraph: (props: Record<string, unknown>) => {
    latestGraphProps = props;
    return <div>connections-graph</div>;
  },
}));

import { AnalysisCallsignGraphPane } from '.././AnalysisCallsignGraphPane';

function createGraph(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      {
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 2,
        relationCount: 1,
        activityCount: 2,
        mainRadioStation: false,
        commandControl: false,
        position: null,
        unitName: null,
        knownCallsignId: null,
        enrichmentSource: 'RelationEnrichmentNone',
      },
      {
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 1,
        relationCount: 1,
        activityCount: 1,
        mainRadioStation: false,
        commandControl: false,
        position: null,
        unitName: null,
        knownCallsignId: null,
        enrichmentSource: 'RelationEnrichmentNone',
      },
    ],
    edges: [
      {
        id: 'ALPHA__BRAVO',
        source: 'ALPHA',
        target: 'BRAVO',
        weight: 3,
        byFreq: [{ freq: '100.1', weight: 3 }],
      },
    ],
    freqs: [{ freq: '100.1', enabledByDefault: true }],
  };
}

function createAdaptiveGraph(): NetworkCallsignRelationsRsp {
  const nodes = Array.from({ length: 303 }, (_, index) => ({
    id: `NODE_${index}`,
    label: `NODE_${index}`,
    weight: 1,
    relationCount: 1,
    activityCount: 1,
    mainRadioStation: false,
    commandControl: false,
    position: null,
    unitName: null,
    knownCallsignId: null,
    enrichmentSource: 'RelationEnrichmentNone' as const,
  }));

  return {
    nodes,
    edges: [
      {
        id: 'STRONG',
        source: 'NODE_0',
        target: 'NODE_1',
        weight: 3,
        byFreq: [{ freq: '100.1', weight: 3 }],
      },
      ...Array.from({ length: 301 }, (_, index) => ({
        id: `WEAK_${index}`,
        source: `NODE_${index + 1}`,
        target: `NODE_${index + 2}`,
        weight: 1,
        byFreq: [{ freq: '200.2', weight: 1 }],
      })),
    ],
    freqs: [
      { freq: '100.1', enabledByDefault: true },
      { freq: '200.2', enabledByDefault: false },
    ],
  };
}

function createSearchAdaptiveGraph(): NetworkCallsignRelationsRsp {
  const nodes = Array.from({ length: 301 }, (_, index) => ({
    id: index < 300 ? `MATCH_${index}` : 'OTHER',
    label: index < 300 ? `MATCH ${index}` : 'OTHER',
    weight: 1,
    relationCount: 1,
    activityCount: 1,
    mainRadioStation: false,
    commandControl: false,
    position: null,
    unitName: null,
    knownCallsignId: null,
    enrichmentSource: 'RelationEnrichmentNone' as const,
  }));

  return {
    nodes,
    edges: [
      {
        id: 'STRONG',
        source: 'MATCH_0',
        target: 'MATCH_1',
        weight: 2,
        byFreq: [{ freq: '100.1', weight: 2 }],
      },
      {
        id: 'WEAK',
        source: 'MATCH_0',
        target: 'OTHER',
        weight: 1,
        byFreq: [{ freq: '100.1', weight: 1 }],
      },
    ],
    freqs: [{ freq: '100.1', enabledByDefault: true }],
  };
}

// @test-scope safeguard: preserves explicit graph loading and prevents local graph filters from replacing a bounded, current graph with an unusable selection.
describe('AnalysisCallsignGraphPane', () => {
  const rendered: Array<{ container: HTMLDivElement; root: Root }> = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => item.root.unmount());
      item.container.remove();
    }
    latestGraphProps = null;
  });

  it('waits for an explicit load before building the graph', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onLoadCallsignGraph = vi.fn();
    rendered.push({ container, root });

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={null}
          callsignGraphLoading={false}
          onLoadCallsignGraph={onLoadCallsignGraph}
        />,
      );
    });

    expect(onLoadCallsignGraph).not.toHaveBeenCalled();
    const loadButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Завантажити',
    );
    expect(loadButton).toBeTruthy();

    act(() => loadButton?.click());
    expect(onLoadCallsignGraph).toHaveBeenCalledTimes(1);
  });

  it('raises and clamps intensity when graph-local filters would exceed render limits', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={createAdaptiveGraph()}
          callsignGraphLoading={false}
          onLoadCallsignGraph={vi.fn()}
        />,
      );
    });

    expect(latestGraphProps?.relationsMinIntensity).toBe(1);

    act(() => {
      (latestGraphProps?.onEnabledFreqsChange as (freqs: string[]) => void)(['100.1', '200.2']);
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);

    act(() => {
      (latestGraphProps?.onMinIntensityChange as (intensity: number) => void)(1);
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);

    act(() => {
      (latestGraphProps?.onSearchChange as (search: string) => void)('NODE_0');
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);
  });

  it('raises intensity when search matches would exceed the node limit', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={createSearchAdaptiveGraph()}
          callsignGraphLoading={false}
          onLoadCallsignGraph={vi.fn()}
        />,
      );
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(1);

    act(() => {
      (latestGraphProps?.onSearchChange as (search: string) => void)('MATCH');
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);
  });

  it('recalculates defaults and resets graph-local filters for new graph data', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    const adaptiveGraph = createAdaptiveGraph();
    adaptiveGraph.freqs[1].enabledByDefault = true;

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={adaptiveGraph}
          callsignGraphLoading={false}
          onLoadCallsignGraph={vi.fn()}
        />,
      );
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);

    act(() => {
      (latestGraphProps?.onSearchChange as (search: string) => void)('NODE_0');
      (latestGraphProps?.onEnabledFreqsChange as (freqs: string[]) => void)(['100.1']);
    });

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={createGraph()}
          callsignGraphLoading={false}
          onLoadCallsignGraph={vi.fn()}
        />,
      );
    });

    expect(latestGraphProps?.relationsSearch).toBe('');
    expect(latestGraphProps?.relationsEnabledFreqs).toEqual([]);
    expect(latestGraphProps?.relationsMinIntensity).toBe(1);
    expect(latestGraphProps?.defaultMinIntensity).toBe(1);
  });

  it('keeps intensity controls available when no non-empty threshold can fit', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });
    const impossibleGraph = createAdaptiveGraph();
    impossibleGraph.edges = impossibleGraph.edges.map((edge) => ({
      ...edge,
      weight: 1,
      byFreq: edge.byFreq.map((item) => ({ ...item, weight: 1 })),
    }));
    impossibleGraph.freqs[1].enabledByDefault = true;

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={impossibleGraph}
          callsignGraphLoading={false}
          onLoadCallsignGraph={vi.fn()}
        />,
      );
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(1);

    act(() => {
      (latestGraphProps?.onMinIntensityChange as (intensity: number) => void)(2);
    });
    expect(latestGraphProps?.relationsMinIntensity).toBe(2);
  });
});
