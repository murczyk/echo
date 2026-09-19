import { describe, expect, it } from 'vitest';

import type {
  NetworkCallsignRelationNode,
  NetworkCallsignRelationsRsp,
} from '../../../../../Bindings';
import {
  buildNetworkCallsignRelationsGraphView,
  buildRenderableNetworkCallsignRelationsGraphView,
  findMinimumRenderableNetworkCallsignRelationsIntensity,
  limitGraphEdgesByWeight,
  NETWORK_RELATIONS_RENDER_LIMITS,
} from '../network-relations';

function relationNode(
  overrides: Partial<NetworkCallsignRelationNode> &
    Pick<NetworkCallsignRelationNode, 'id' | 'label'>,
): NetworkCallsignRelationNode {
  return {
    weight: 1,
    relationCount: 1,
    activityCount: 1,
    mainRadioStation: false,
    commandControl: false,
    position: null,
    unitName: null,
    knownCallsignId: null,
    enrichmentSource: 'RelationEnrichmentNone',
    ...overrides,
  };
}

function createGraph(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      relationNode({
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 3,
        relationCount: 2,
        activityCount: 3,
        position: 'КР',
        unitName: '1 мб',
        knownCallsignId: 10,
        enrichmentSource: 'RelationEnrichmentNetwork',
      }),
      relationNode({
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 2,
        relationCount: 2,
        activityCount: 2,
      }),
      relationNode({
        id: 'CHARLIE',
        label: 'CHARLIE',
      }),
    ],
    edges: [
      {
        id: 'ALPHA__BRAVO',
        source: 'ALPHA',
        target: 'BRAVO',
        weight: 3,
        byFreq: [
          { freq: '652.111', weight: 2 },
          { freq: '852.111', weight: 1 },
        ],
      },
      {
        id: 'BRAVO__CHARLIE',
        source: 'BRAVO',
        target: 'CHARLIE',
        weight: 1,
        byFreq: [{ freq: '852.111', weight: 1 }],
      },
    ],
    freqs: [
      { freq: '652.111', enabledByDefault: true },
      { freq: '852.111', enabledByDefault: true },
    ],
  };
}
describe('network relation render limits', () => {
  it('selects the first complete weight threshold within exact render limits', () => {
    const graph = {
      nodes: Array.from({ length: 5 }, (_, index) =>
        relationNode({ id: `NODE_${index}`, label: `NODE_${index}` }),
      ),
      edges: [
        {
          id: 'EDGE_1',
          source: 'NODE_0',
          target: 'NODE_1',
          weight: 1,
          byFreq: [{ freq: '100.1', weight: 1 }],
        },
        {
          id: 'EDGE_2',
          source: 'NODE_1',
          target: 'NODE_2',
          weight: 2,
          byFreq: [{ freq: '100.1', weight: 2 }],
        },
        {
          id: 'EDGE_3',
          source: 'NODE_2',
          target: 'NODE_3',
          weight: 2,
          byFreq: [{ freq: '100.1', weight: 2 }],
        },
        {
          id: 'EDGE_4',
          source: 'NODE_3',
          target: 'NODE_4',
          weight: 3,
          byFreq: [{ freq: '100.1', weight: 3 }],
        },
      ],
      freqs: [{ freq: '100.1', enabledByDefault: true }],
    };

    expect(
      findMinimumRenderableNetworkCallsignRelationsIntensity(graph, '', [], {
        maxRenderNodes: 4,
        maxRenderEdges: 3,
        softLimitMultiplier: 2,
      }),
    ).toBe(2);
  });

  it('accounts for frequency and search filters when finding a safe threshold', () => {
    const graph = {
      ...createGraph(),
      nodes: [
        ...createGraph().nodes,
        relationNode({ id: 'DELTA', label: 'DELTA' }),
        relationNode({ id: 'ECHO', label: 'ECHO' }),
      ],
      edges: [
        {
          id: 'ALPHA__BRAVO',
          source: 'ALPHA',
          target: 'BRAVO',
          weight: 3,
          byFreq: [{ freq: '100.1', weight: 3 }],
        },
        {
          id: 'BRAVO__DELTA',
          source: 'BRAVO',
          target: 'DELTA',
          weight: 2,
          byFreq: [{ freq: '200.2', weight: 2 }],
        },
        {
          id: 'DELTA__ECHO',
          source: 'DELTA',
          target: 'ECHO',
          weight: 2,
          byFreq: [{ freq: '200.2', weight: 2 }],
        },
      ],
      freqs: [
        { freq: '100.1', enabledByDefault: true },
        { freq: '200.2', enabledByDefault: true },
      ],
    };
    const limits = { maxRenderNodes: 2, maxRenderEdges: 1, softLimitMultiplier: 2 };

    expect(
      findMinimumRenderableNetworkCallsignRelationsIntensity(graph, '', ['200.2'], limits),
    ).toBeNull();
    expect(findMinimumRenderableNetworkCallsignRelationsIntensity(graph, 'alpha', [], limits)).toBe(
      1,
    );
  });

  it('raises the safe threshold when search matches add too many nodes', () => {
    const graph = {
      nodes: [
        relationNode({ id: 'MATCH_1', label: 'MATCH 1' }),
        relationNode({ id: 'MATCH_2', label: 'MATCH 2' }),
        relationNode({ id: 'MATCH_3', label: 'MATCH 3' }),
        relationNode({ id: 'OTHER', label: 'OTHER' }),
      ],
      edges: [
        {
          id: 'STRONG',
          source: 'MATCH_1',
          target: 'MATCH_2',
          weight: 2,
          byFreq: [{ freq: '100.1', weight: 2 }],
        },
        {
          id: 'WEAK',
          source: 'MATCH_1',
          target: 'OTHER',
          weight: 1,
          byFreq: [{ freq: '100.1', weight: 1 }],
        },
      ],
      freqs: [{ freq: '100.1', enabledByDefault: true }],
    };
    const limits = { maxRenderNodes: 3, maxRenderEdges: 2, softLimitMultiplier: 2 };

    expect(findMinimumRenderableNetworkCallsignRelationsIntensity(graph, '', [], limits)).toBe(1);
    expect(findMinimumRenderableNetworkCallsignRelationsIntensity(graph, 'match', [], limits)).toBe(
      2,
    );
  });

  it('returns null when equal top-weight relationships cannot fit', () => {
    const graph = {
      nodes: Array.from({ length: 4 }, (_, index) =>
        relationNode({ id: `NODE_${index}`, label: `NODE_${index}` }),
      ),
      edges: Array.from({ length: 3 }, (_, index) => ({
        id: `EDGE_${index}`,
        source: `NODE_${index}`,
        target: `NODE_${index + 1}`,
        weight: 5,
        byFreq: [{ freq: '100.1', weight: 5 }],
      })),
      freqs: [{ freq: '100.1', enabledByDefault: true }],
    };

    expect(
      findMinimumRenderableNetworkCallsignRelationsIntensity(graph, '', [], {
        maxRenderNodes: 3,
        maxRenderEdges: 2,
        softLimitMultiplier: 2,
      }),
    ).toBeNull();
  });

  it('limits edges by visible weight deterministically', () => {
    const edges = limitGraphEdgesByWeight(
      [
        {
          id: 'BRAVO__CHARLIE',
          source: 'BRAVO',
          target: 'CHARLIE',
          weight: 1,
          visibleWeight: 3,
          visibleByFreq: [],
          byFreq: [],
        },
        {
          id: 'ALPHA__DELTA',
          source: 'ALPHA',
          target: 'DELTA',
          weight: 1,
          visibleWeight: 7,
          visibleByFreq: [],
          byFreq: [],
        },
        {
          id: 'ALPHA__BRAVO',
          source: 'ALPHA',
          target: 'BRAVO',
          weight: 1,
          visibleWeight: 7,
          visibleByFreq: [],
          byFreq: [],
        },
      ] as any,
      2,
    );

    expect(edges.map((edge) => edge.id)).toEqual(['ALPHA__BRAVO', 'ALPHA__DELTA']);
  });

  it('renders a top-weight subset when the graph is only slightly over the edge cap', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        ...createGraph(),
        nodes: [
          ...createGraph().nodes,
          relationNode({
            id: 'DELTA',
            label: 'DELTA',
          }),
        ],
        edges: [
          {
            id: 'ALPHA__BRAVO',
            source: 'ALPHA',
            target: 'BRAVO',
            weight: 5,
            byFreq: [{ freq: '652.111', weight: 5 }],
          },
          {
            id: 'BRAVO__CHARLIE',
            source: 'BRAVO',
            target: 'CHARLIE',
            weight: 3,
            byFreq: [{ freq: '652.111', weight: 3 }],
          },
          {
            id: 'CHARLIE__DELTA',
            source: 'CHARLIE',
            target: 'DELTA',
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1 }],
          },
        ],
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(
      graph,
      graph.nodes.filter((node) => node.visible),
      {
        maxRenderNodes: 4,
        maxRenderEdges: 2,
        softLimitMultiplier: 2,
      },
    );

    expect(renderView.warning).toBe(false);
    expect(renderView.edges.map((edge) => edge.id)).toEqual(['ALPHA__BRAVO', 'BRAVO__CHARLIE']);
    expect(renderView.nodes.map((node) => node.id)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
  });

  it('warns when the trimmed graph still exceeds the node cap', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      createGraph(),
      '',
      ['652.111', '852.111'],
      1,
    );
    const renderView = buildRenderableNetworkCallsignRelationsGraphView(
      graph,
      graph.nodes.filter((node) => node.visible),
      {
        maxRenderNodes: 1,
        maxRenderEdges: 2,
        softLimitMultiplier: 2,
      },
    );

    expect(renderView.warning).toBe(true);
    expect(renderView.nodes).toHaveLength(0);
    expect(renderView.edges).toHaveLength(0);
  });

  it('warns immediately when the graph is far beyond the soft cap', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        nodes: Array.from({ length: 601 }, (_, index) =>
          relationNode({
            id: `NODE_${index}`,
            label: `NODE_${index}`,
          }),
        ),
        edges: Array.from({ length: 600 }, (_, index) => {
          const sourceIndex = index % 600;
          const targetIndex = sourceIndex + 1;
          return {
            id: `EDGE_${String(index).padStart(4, '0')}`,
            source: `NODE_${sourceIndex}`,
            target: `NODE_${targetIndex}`,
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1 }],
          };
        }),
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(
      graph,
      graph.nodes.filter((node) => node.visible),
      NETWORK_RELATIONS_RENDER_LIMITS,
    );

    expect(renderView.warning).toBe(true);
    expect(renderView.nodes).toHaveLength(0);
    expect(renderView.edges).toHaveLength(0);
  });

  it('honors a custom soft limit multiplier when rendering', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        nodes: Array.from({ length: 6 }, (_, index) =>
          relationNode({
            id: `NODE_${index}`,
            label: `NODE_${index}`,
          }),
        ),
        edges: Array.from({ length: 25 }, (_, index) => {
          const sourceIndex = index % 6;
          const targetIndex = (sourceIndex + 1) % 6;
          return {
            id: `EDGE_${String(index).padStart(4, '0')}`,
            source: `NODE_${sourceIndex}`,
            target: `NODE_${targetIndex}`,
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1 }],
          };
        }),
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(
      graph,
      graph.nodes.filter((node) => node.visible),
      {
        maxRenderNodes: 10,
        maxRenderEdges: 10,
        softLimitMultiplier: 3,
      },
    );

    expect(renderView.warning).toBe(false);
    expect(renderView.edges).toHaveLength(10);
    expect(renderView.nodes.length).toBeGreaterThan(0);
  });
});
