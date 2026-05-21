import { describe, expect, it } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../Bindings';
import {
  buildNetworkCallsignRelationsGraphView,
  buildRenderableNetworkCallsignRelationsGraphView,
  filterNetworkCallsignRelationEdgeMessages,
  limitGraphEdgesByWeight,
  normalizeNetworkCallsignRelationSearch,
  NETWORK_RELATIONS_RENDER_LIMITS,
} from './network-relations';

function createGraph(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      {
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 3,
        relationCount: 2,
        activityCount: 3,
        position: 'КР',
        unitName: '1 мб',
        knownCallsignId: 10,
      },
      {
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 2,
        relationCount: 2,
        activityCount: 2,
        position: null,
        unitName: null,
        knownCallsignId: null,
      },
      {
        id: 'CHARLIE',
        label: 'CHARLIE',
        weight: 1,
        relationCount: 1,
        activityCount: 1,
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
        weight: 3,
        byFreq: [
          { freq: '652.111', weight: 2, messageIds: [1, 2] },
          { freq: '852.111', weight: 1, messageIds: [3] },
        ],
        messagesPreview: [
          { id: 1, timestamp: 1000, freq: '652.111', text: 'alpha bravo', callsigns: ['ALPHA', 'BRAVO'] },
        ],
      },
      {
        id: 'BRAVO__CHARLIE',
        source: 'BRAVO',
        target: 'CHARLIE',
        weight: 1,
        byFreq: [{ freq: '852.111', weight: 1, messageIds: [4] }],
        messagesPreview: [
          { id: 4, timestamp: 2000, freq: '852.111', text: 'bravo charlie', callsigns: ['BRAVO', 'CHARLIE'] },
        ],
      },
    ],
    freqs: [
      { freq: '652.111', enabledByDefault: true },
      { freq: '852.111', enabledByDefault: true },
    ],
  };
}

describe('network relations helpers', () => {
  it('normalizes search text for case-insensitive matching', () => {
    expect(normalizeNetworkCallsignRelationSearch('  сокіл-1 ')).toBe('СОКІЛ-1');
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
      ['652.111', '852.111', '445.500', '741.250', '159.7400', '159.7350', '159.7380', '159.7375', '159.7430'],
      1,
    );

    expect(graph.freqs).toHaveLength(9);
    expect(graph.freqs[0]).toMatchObject({ freq: '652.111', color: '#d59a57' });
    expect(graph.freqs[8].color).toMatch(/^hsl\(\d+ 68% \d+%\)$/);
    expect(new Set(graph.freqs.map((freq) => freq.color)).size).toBe(9);
  });

  it('keeps search matches highlighted while preserving visible neighbors', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), 'brav', ['652.111', '852.111'], 1);

    const bravo = graph.nodes.find((node) => node.id === 'BRAVO');
    expect(bravo?.matchedSearch).toBe(true);
    expect(bravo?.visible).toBe(true);
    expect(graph.visibleNodeIds.has('ALPHA')).toBe(true);
    expect(graph.visibleNodeIds.has('CHARLIE')).toBe(true);
  });

  it('filters edge previews to currently visible frequencies', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), '', ['652.111'], 1);
    const edge = graph.edges.find((item) => item.id === 'ALPHA__BRAVO');

    expect(filterNetworkCallsignRelationEdgeMessages(edge ?? null).map((message) => message.id)).toEqual([1]);
  });

  it('hides frequency-bucket edges when no frequencies are enabled', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), '', [], 1);

    expect(graph.edges).toHaveLength(0);
    expect(graph.visibleEdgeIds.size).toBe(0);
    expect(graph.visibleNodeIds.size).toBe(0);
  });

  it('preserves edge previews when no frequency buckets exist', () => {
    const edge = {
      id: 'ALPHA__BRAVO',
      source: 'ALPHA',
      target: 'BRAVO',
      weight: 3,
      visibleWeight: 3,
      visibleByFreq: [],
      byFreq: [],
      messagesPreview: [
        { id: 1, timestamp: 1000, freq: null, text: 'alpha bravo', callsigns: ['ALPHA', 'BRAVO'] },
        { id: 2, timestamp: 1001, freq: null, text: 'alpha bravo again', callsigns: ['ALPHA', 'BRAVO'] },
      ],
    } as any;

    expect(filterNetworkCallsignRelationEdgeMessages(edge).map((message) => message.id)).toEqual([1, 2]);
  });

  it('excludes edges when active frequency filters match no buckets', () => {
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
              { freq: '652.111', weight: 2, messageIds: [1, 2] },
              { freq: '852.111', weight: 1, messageIds: [3] },
            ],
            messagesPreview: [],
          },
        ],
      },
      '',
      ['999.999'],
      1,
    );

    expect(graph.edges).toHaveLength(0);
    expect(graph.visibleEdgeIds.has('ALPHA__BRAVO')).toBe(false);
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
            messagesPreview: [],
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

  it('limits edges by visible weight deterministically', () => {
    const edges = limitGraphEdgesByWeight(
      [
        { id: 'BRAVO__CHARLIE', source: 'BRAVO', target: 'CHARLIE', weight: 1, visibleWeight: 3, visibleByFreq: [], messagesPreview: [], byFreq: [] },
        { id: 'ALPHA__DELTA', source: 'ALPHA', target: 'DELTA', weight: 1, visibleWeight: 7, visibleByFreq: [], messagesPreview: [], byFreq: [] },
        { id: 'ALPHA__BRAVO', source: 'ALPHA', target: 'BRAVO', weight: 1, visibleWeight: 7, visibleByFreq: [], messagesPreview: [], byFreq: [] },
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
          {
            id: 'DELTA',
            label: 'DELTA',
            weight: 1,
            relationCount: 1,
            activityCount: 1,
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
            weight: 5,
            byFreq: [{ freq: '652.111', weight: 5, messageIds: [1] }],
            messagesPreview: [],
          },
          {
            id: 'BRAVO__CHARLIE',
            source: 'BRAVO',
            target: 'CHARLIE',
            weight: 3,
            byFreq: [{ freq: '652.111', weight: 3, messageIds: [2] }],
            messagesPreview: [],
          },
          {
            id: 'CHARLIE__DELTA',
            source: 'CHARLIE',
            target: 'DELTA',
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1, messageIds: [3] }],
            messagesPreview: [],
          },
        ],
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(graph, graph.nodes.filter((node) => node.visible), {
      maxRenderNodes: 4,
      maxRenderEdges: 2,
      softLimitMultiplier: 2,
    });

    expect(renderView.warning).toBe(false);
    expect(renderView.edges.map((edge) => edge.id)).toEqual(['ALPHA__BRAVO', 'BRAVO__CHARLIE']);
    expect(renderView.nodes.map((node) => node.id)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
  });

  it('warns when the trimmed graph still exceeds the node cap', () => {
    const graph = buildNetworkCallsignRelationsGraphView(createGraph(), '', ['652.111', '852.111'], 1);
    const renderView = buildRenderableNetworkCallsignRelationsGraphView(graph, graph.nodes.filter((node) => node.visible), {
      maxRenderNodes: 1,
      maxRenderEdges: 2,
      softLimitMultiplier: 2,
    });

    expect(renderView.warning).toBe(true);
    expect(renderView.nodes).toHaveLength(0);
    expect(renderView.edges).toHaveLength(0);
  });

  it('warns immediately when the graph is far beyond the soft cap', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        nodes: Array.from({ length: 170 }, (_, index) => ({
          id: `NODE_${index}`,
          label: `NODE_${index}`,
          weight: 1,
          relationCount: 1,
          activityCount: 1,
          position: null,
          unitName: null,
          knownCallsignId: null,
        })),
        edges: Array.from({ length: 1700 }, (_, index) => {
          const sourceIndex = index % 169;
          const targetIndex = sourceIndex + 1;
          return {
            id: `EDGE_${String(index).padStart(4, '0')}`,
            source: `NODE_${sourceIndex}`,
            target: `NODE_${targetIndex}`,
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1, messageIds: [index + 1] }],
            messagesPreview: [],
          };
        }),
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(graph, graph.nodes.filter((node) => node.visible), NETWORK_RELATIONS_RENDER_LIMITS);

    expect(renderView.warning).toBe(true);
    expect(renderView.nodes).toHaveLength(0);
    expect(renderView.edges).toHaveLength(0);
  });

  it('honors a custom soft limit multiplier when rendering', () => {
    const graph = buildNetworkCallsignRelationsGraphView(
      {
        nodes: Array.from({ length: 6 }, (_, index) => ({
          id: `NODE_${index}`,
          label: `NODE_${index}`,
          weight: 1,
          relationCount: 1,
          activityCount: 1,
          position: null,
          unitName: null,
          knownCallsignId: null,
        })),
        edges: Array.from({ length: 25 }, (_, index) => {
          const sourceIndex = index % 6;
          const targetIndex = (sourceIndex + 1) % 6;
          return {
            id: `EDGE_${String(index).padStart(4, '0')}`,
            source: `NODE_${sourceIndex}`,
            target: `NODE_${targetIndex}`,
            weight: 1,
            byFreq: [{ freq: '652.111', weight: 1, messageIds: [index + 1] }],
            messagesPreview: [],
          };
        }),
        freqs: [{ freq: '652.111', enabledByDefault: true }],
      },
      '',
      ['652.111'],
      1,
    );

    const renderView = buildRenderableNetworkCallsignRelationsGraphView(graph, graph.nodes.filter((node) => node.visible), {
      maxRenderNodes: 10,
      maxRenderEdges: 10,
      softLimitMultiplier: 3,
    });

    expect(renderView.warning).toBe(false);
    expect(renderView.edges).toHaveLength(10);
    expect(renderView.nodes.length).toBeGreaterThan(0);
  });
});
