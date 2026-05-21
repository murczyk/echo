import { describe, expect, it } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../Bindings';
import {
  buildNetworkCallsignRelationsGraphView,
  filterNetworkCallsignRelationEdgeMessages,
  normalizeNetworkCallsignRelationSearch,
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
});
