/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';

let latestGraphProps: Record<string, unknown> | null = null;

vi.mock('../../rer-network-details-neo/components/NetworkCallsignRelationsGraph', () => ({
  NetworkCallsignRelationsGraph: (props: Record<string, unknown>) => {
    latestGraphProps = props;
    return <div>connections-graph</div>;
  },
}));

import { AnalysisCallsignGraphPane } from './AnalysisCallsignGraphPane';

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

describe('AnalysisCallsignGraphPane', () => {
  const rendered: Array<{ container: HTMLDivElement; root: Root }> = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => item.root.unmount());
      item.container.remove();
    }
    latestGraphProps = null;
  });

  it('renders the network connections graph without legacy controls', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onLoadCallsignGraph = vi.fn();
    rendered.push({ container, root });

    act(() => {
      root.render(
        <AnalysisCallsignGraphPane
          callsignGraph={createGraph()}
          callsignGraphLoading={false}
          onLoadCallsignGraph={onLoadCallsignGraph}
        />,
      );
    });

    expect(container.textContent).toContain('connections-graph');
    expect(container.textContent).not.toContain('показувати всі');
    expect(latestGraphProps?.showDateFilters).toBe(false);
    expect(latestGraphProps?.showMessages).toBe(false);
    expect(latestGraphProps?.defaultMinIntensity).toBe(1);
    expect(latestGraphProps?.relationsMinIntensity).toBe(1);
    expect(latestGraphProps?.relations).toMatchObject({
      edges: [{ source: 'ALPHA', target: 'BRAVO', weight: 3 }],
    });
    expect(onLoadCallsignGraph).not.toHaveBeenCalled();
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
});
