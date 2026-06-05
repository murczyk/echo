/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import {
  buildNetworkCallsignRelationsGraphView,
  createRelationGraphLayout,
} from '../network-relations';
import { NetworkCallsignRelationsGraphCanvas } from './NetworkCallsignRelationsGraphCanvas';

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
        relationCount: 0,
        activityCount: 3,
        mainRadioStation: true,
        commandControl: true,
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
        commandControl: false,
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
        weight: 1,
        byFreq: [{ freq: '652.111', weight: 1 }],
      },
    ],
    freqs: [{ freq: '652.111', enabledByDefault: true }],
  };
}

function renderCanvas() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const graphView = buildNetworkCallsignRelationsGraphView(createGraph(), '', ['652.111'], 1);
  const layout = createRelationGraphLayout(graphView.nodes, graphView.edges);
  const svgRef = { current: null } as MutableRefObject<SVGSVGElement | null>;

  act(() => {
    root.render(
      <NetworkCallsignRelationsGraphCanvas
        svgRef={svgRef}
        headingId="graph"
        graphView={graphView}
        layout={layout}
        viewBox={{ x: -500, y: -500, width: 1000, height: 1000 }}
        selectedNodeId={null}
        selectedEdgeId={null}
        selectedNeighborIds={new Set()}
        relationsShowLabels={true}
        denseGraph={false}
        isDarkMode={false}
        legendFreqs={graphView.freqs}
        visibleEdgeIdsForRender={new Set(['ALPHA__BRAVO'])}
        visibleNodeIdsForRender={new Set(['ALPHA', 'BRAVO'])}
        onSelectNodeId={vi.fn()}
        onSelectEdgeId={vi.fn()}
        onPointerDown={vi.fn()}
        onPointerMove={vi.fn()}
        onPointerUp={vi.fn()}
      />,
    );
  });

  return { container, root };
}

describe('NetworkCallsignRelationsGraphCanvas', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    document.body.innerHTML = '';
  });

  it('renders compact node marker badges', () => {
    const view = renderCanvas();
    rendered.push(view);

    expect(view.container.querySelectorAll('circle')).toHaveLength(4);
  });
});
