import type {
  NetworkCallsignRelationEdge,
  NetworkCallsignRelationFreq,
  NetworkCallsignRelationNode,
  NetworkCallsignRelationsRsp,
} from '../../../../Bindings';

export type NetworkCallsignRelationsEdgeView = NetworkCallsignRelationEdge & {
  visibleWeight: number;
  visibleByFreq: Array<{ freq: string; weight: number; messageIds: number[] }>;
};

export type NetworkCallsignRelationFreqView = NetworkCallsignRelationFreq & {
  color: string;
};

export type NetworkCallsignRelationsNodeView = NetworkCallsignRelationNode & {
  matchedSearch: boolean;
  visible: boolean;
};

export type NetworkCallsignRelationsGraphView = {
  nodes: NetworkCallsignRelationsNodeView[];
  edges: NetworkCallsignRelationsEdgeView[];
  freqs: NetworkCallsignRelationFreqView[];
  matchedNodeIds: Set<string>;
  visibleNodeIds: Set<string>;
  visibleEdgeIds: Set<string>;
  adjacencyByNodeId: Map<string, Set<string>>;
};

export function filterNetworkCallsignRelationEdgeMessages(edge: NetworkCallsignRelationsEdgeView | null): Array<{
  id: number;
  timestamp: number | null;
  freq: string | null;
  text: string;
  callsigns: string[];
}> {
  if (!edge) return [];
  const visibleMessageIds = new Set(edge.visibleByFreq.flatMap((item) => item.messageIds));
  const visibleFreqs = new Set(edge.visibleByFreq.map((item) => item.freq));
  return edge.messagesPreview.filter((message) => visibleMessageIds.has(message.id) || (message.freq !== null && visibleFreqs.has(message.freq)));
}

function normalizeRelationText(value: string | null | undefined): string {
  return (value?.trim() ?? '').toLocaleUpperCase('uk-UA');
}

function normalizeEnabledFreq(value: string): string {
  return value.trim();
}

const RELATION_FREQ_COLORS = [
  '#d59a57',
  '#60b8ea',
  '#66c87e',
  '#b073d9',
  '#f08a73',
  '#efd16d',
  '#5fd0c8',
  '#f29cc1',
];

function withFrequencyColors(freqs: NetworkCallsignRelationFreq[]): NetworkCallsignRelationFreqView[] {
  return freqs.map((freq, index) => ({
    ...freq,
    color: RELATION_FREQ_COLORS[index % RELATION_FREQ_COLORS.length] ?? '#8b8b8b',
  }));
}

export function buildNetworkCallsignRelationsGraphView(
  graph: NetworkCallsignRelationsRsp | null,
  searchText: string,
  enabledFreqs: string[],
  minIntensity: number,
): NetworkCallsignRelationsGraphView {
  const normalizedSearch = normalizeRelationText(searchText);
  const enabledFreqSet = new Set(enabledFreqs.map(normalizeEnabledFreq).filter((freq) => freq !== ''));

  const nodes = (graph?.nodes ?? []).map((node) => ({
    ...node,
    matchedSearch: normalizedSearch !== '' && normalizeRelationText(node.label).includes(normalizedSearch),
    visible: false,
  }));

  const matchedNodeIds = new Set(nodes.filter((node) => node.matchedSearch).map((node) => node.id));
  const visibleEdgeIds = new Set<string>();
  const visibleNodeIds = new Set<string>();
  const adjacencyByNodeId = new Map<string, Set<string>>();
  const edges = (graph?.edges ?? []).map<NetworkCallsignRelationsEdgeView>((edge) => {
    const visibleByFreq = edge.byFreq
      .filter((item) => enabledFreqSet.size === 0 || enabledFreqSet.has(normalizeEnabledFreq(item.freq)))
      .map((item) => ({
        freq: item.freq,
        weight: item.weight,
        messageIds: [...item.messageIds],
      }));
    const visibleWeight = visibleByFreq.reduce((total, item) => total + item.weight, 0);
    const visible = visibleWeight >= minIntensity;

    if (visible) {
      visibleEdgeIds.add(edge.id);
      visibleNodeIds.add(edge.source);
      visibleNodeIds.add(edge.target);

      const leftNeighbors = adjacencyByNodeId.get(edge.source) ?? new Set<string>();
      leftNeighbors.add(edge.target);
      adjacencyByNodeId.set(edge.source, leftNeighbors);

      const rightNeighbors = adjacencyByNodeId.get(edge.target) ?? new Set<string>();
      rightNeighbors.add(edge.source);
      adjacencyByNodeId.set(edge.target, rightNeighbors);
    }

    return {
      ...edge,
      visibleWeight,
      visibleByFreq,
    };
  });

  if (normalizedSearch !== '') {
    for (const node of nodes) {
      if (node.matchedSearch) {
        visibleNodeIds.add(node.id);
      }
    }
  }

  for (const node of nodes) {
    node.visible = visibleNodeIds.has(node.id) || node.matchedSearch;
  }

  const filteredEdges = edges.filter((edge) => {
    if (edge.visibleWeight < minIntensity) return false;
    if (normalizedSearch === '') return true;
    return matchedNodeIds.has(edge.source) || matchedNodeIds.has(edge.target);
  });

  const filteredVisibleEdgeIds = new Set(filteredEdges.map((edge) => edge.id));
  const filteredVisibleNodeIds = new Set<string>();
  for (const edge of filteredEdges) {
    filteredVisibleNodeIds.add(edge.source);
    filteredVisibleNodeIds.add(edge.target);
  }
  if (normalizedSearch !== '') {
    for (const nodeId of matchedNodeIds) {
      filteredVisibleNodeIds.add(nodeId);
      const neighbors = adjacencyByNodeId.get(nodeId);
      if (!neighbors) continue;
      for (const neighbor of neighbors) filteredVisibleNodeIds.add(neighbor);
    }
  }

  const visibleNodes = nodes.map((node) => ({
    ...node,
    visible: filteredVisibleNodeIds.has(node.id) || node.matchedSearch,
  }));

  return {
    nodes: visibleNodes,
    edges: filteredEdges,
    freqs: withFrequencyColors(graph?.freqs ?? []),
    matchedNodeIds,
    visibleNodeIds: filteredVisibleNodeIds,
    visibleEdgeIds: filteredVisibleEdgeIds,
    adjacencyByNodeId,
  };
}

export function normalizeNetworkCallsignRelationSearch(value: string): string {
  return normalizeRelationText(value);
}
