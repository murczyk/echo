import { describe, expect, it } from 'vitest';

import type {
  NetworkCallsignRelationNode,
  NetworkCallsignRelationsRsp,
} from '../../../../Bindings';
import {
  buildNetworkCallsignRelationFreqState,
  buildNetworkCallsignRelationsGraphView,
  buildRenderableNetworkCallsignRelationsGraphView,
  findMinimumRenderableNetworkCallsignRelationsIntensity,
  getRelationGraphPointFromViewport,
  limitGraphEdgesByWeight,
  normalizeNetworkCallsignRelationSearch,
  NETWORK_RELATIONS_RENDER_LIMITS,
  resolveNetworkCallsignRelationFreqs,
  zoomRelationGraphViewBox,
} from './network-relations';

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

describe('network relations helpers', () => {
  it('uses new defaults when the previous selection was not customized', () => {
    const nextGraph = {
      ...createGraph(),
      freqs: [
        { freq: '652.111', enabledByDefault: true },
        { freq: '852.111', enabledByDefault: true },
      ],
    };

    expect(resolveNetworkCallsignRelationFreqs(nextGraph, ['652.111'], false)).toEqual({
      enabledFreqs: ['652.111', '852.111'],
      customized: false,
    });
  });

  it('resets stale customized selections and keeps the reset automatic', () => {
    const onlySecondFreq = {
      ...createGraph(),
      edges: [],
      freqs: [{ freq: '852.111', enabledByDefault: true }],
    };
    const nextRange = {
      ...createGraph(),
      edges: [],
      freqs: [
        { freq: '852.111', enabledByDefault: true },
        { freq: '954.111', enabledByDefault: true },
      ],
    };

    expect(resolveNetworkCallsignRelationFreqs(onlySecondFreq, ['652.111'], true)).toEqual({
      enabledFreqs: ['852.111'],
      customized: false,
    });
    expect(resolveNetworkCallsignRelationFreqs(nextRange, ['852.111'], false)).toEqual({
      enabledFreqs: ['852.111', '954.111'],
      customized: false,
    });
  });

  it('preserves a customized selection when it overlaps the next response', () => {
    expect(resolveNetworkCallsignRelationFreqs(createGraph(), ['652.111'], true)).toEqual({
      enabledFreqs: ['652.111'],
      customized: true,
    });
  });

  it('keeps the graph point under the cursor fixed while zooming', () => {
    const viewBox = { x: 0, y: 0, width: 2000, height: 1000 };
    const focalPoint = getRelationGraphPointFromViewport(viewBox, 250, 100, 1000, 500);
    const zoomedViewBox = zoomRelationGraphViewBox(viewBox, 0.8, focalPoint);

    expect(focalPoint).toEqual({ x: 500, y: 200 });
    expect(zoomedViewBox).toEqual({ x: 100, y: 40, width: 1600, height: 800 });
  });

  it('accounts for SVG letterboxing when locating the zoom cursor', () => {
    expect(
      getRelationGraphPointFromViewport(
        { x: 0, y: 0, width: 1000, height: 1000 },
        250,
        0,
        1000,
        500,
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it('normalizes search text for case-insensitive matching', () => {
    expect(normalizeNetworkCallsignRelationSearch('  сокіл-1 ')).toBe('СОКІЛ-1');
  });

  it('derives frequency state from raw response frequencies', () => {
    const state = buildNetworkCallsignRelationFreqState(createGraph(), ['652.111']);

    expect(state.availableFreqs.map((freq) => freq.freq)).toEqual(['652.111', '852.111']);
    expect(state.defaultEnabledFreqs).toEqual(['652.111', '852.111']);
    expect(state.resolvedEnabledFreqs).toEqual(['652.111']);
  });

  it('derives frequency state from edge buckets when response frequencies are missing', () => {
    const state = buildNetworkCallsignRelationFreqState(
      {
        ...createGraph(),
        freqs: [],
      },
      [],
    );

    expect(state.availableFreqs.map((freq) => freq.freq)).toEqual(['652.111', '852.111']);
    expect(state.defaultEnabledFreqs).toEqual(['652.111', '852.111']);
    expect(state.resolvedEnabledFreqs).toEqual(['652.111', '852.111']);
  });

  it('filters edges by frequency selection and minimum intensity', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), '', ['652.111'], 2);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].id).toBe('ALPHA__BRAVO');
    expect(graph.edges[0].visibleWeight).toBe(2);
    expect(graph.freqs[0]).toMatchObject({ freq: '652.111', color: '#d59a57' });
    expect(graph.visibleNodeIds.has('ALPHA')).toBe(true);
    expect(graph.visibleNodeIds.has('BRAVO')).toBe(true);
    expect(graph.visibleNodeIds.has('CHARLIE')).toBe(false);
  });

  it('assigns stable distinct fallback colors beyond the base palette', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        ...createGraph(),
        freqs: [
          { freq: '652.111', enabledByDefault: true },
          { freq: '852.111', enabledByDefault: true },
          { freq: '445.500', enabledByDefault: true },
          { freq: '741.250', enabledByDefault: true },
          { freq: '159.7400', enabledByDefault: true },
          { freq: '159.7350', enabledByDefault: true },
          { freq: '159.7380', enabledByDefault: true },
          { freq: '159.7375', enabledByDefault: true },
          { freq: '159.7430', enabledByDefault: true },
        ],
      },
      '',
      [
        '652.111',
        '852.111',
        '445.500',
        '741.250',
        '159.7400',
        '159.7350',
        '159.7380',
        '159.7375',
        '159.7430',
      ],
      1,
    );

    expect(graph.freqs).toHaveLength(9);
    expect(graph.freqs[0]).toMatchObject({ freq: '652.111', color: '#d59a57' });
    expect(graph.freqs[8].color).toMatch(/^hsl\(\d+ 68% \d+%\)$/);
    expect(new Set(graph.freqs.map((freq) => freq.color)).size).toBe(9);
  });

  it('keeps search matches highlighted while preserving visible neighbors', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      createGraph(),
      'brav',
      ['652.111', '852.111'],
      1,
    );

    const bravo = graph.nodes.find((node) => node.id === 'BRAVO');
    expect(bravo?.matchedSearch).toBe(true);
    expect(bravo?.visible).toBe(true);
    expect(graph.visibleNodeIds.has('ALPHA')).toBe(true);
    expect(graph.visibleNodeIds.has('CHARLIE')).toBe(true);
  });

  it('falls back to default frequencies when the selection is empty', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), '', [], 1);

    expect(graph.edges).toHaveLength(2);
    expect(graph.visibleEdgeIds.size).toBe(2);
    expect(graph.visibleNodeIds.has('ALPHA')).toBe(true);
    expect(graph.visibleNodeIds.has('BRAVO')).toBe(true);
    expect(graph.visibleNodeIds.has('CHARLIE')).toBe(true);
  });

  it('falls back to the default selection when active frequency filters match no buckets', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        ...createGraph(),
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
        ],
      },
      '',
      ['999.999'],
      1,
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.visibleEdgeIds.has('ALPHA__BRAVO')).toBe(true);
  });

  it('uses edge buckets when the backend omits explicit relation frequencies', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        ...createGraph(),
        freqs: [],
      },
      '',
      [],
      1,
    );

    expect(graph.freqs.map((freq) => freq.freq)).toEqual(['652.111', '852.111']);
    expect(graph.edges).toHaveLength(2);
  });

  it('falls back to edge weight when no frequency buckets exist', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        ...createGraph(),
        edges: [
          {
            id: 'ALPHA__BRAVO',
            source: 'ALPHA',
            target: 'BRAVO',
            weight: 3,
            byFreq: [],
          },
        ],
      },
      '',
      ['999.999'],
      2,
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].visibleWeight).toBe(3);
    expect(graph.visibleEdgeIds.has('ALPHA__BRAVO')).toBe(true);
  });

  it('keeps small graphs at the minimum intensity', () => {
    expect(findMinimumRenderableNetworkCallsignRelationsIntensity(createGraph(), '', [])).toBe(1);
  });

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
