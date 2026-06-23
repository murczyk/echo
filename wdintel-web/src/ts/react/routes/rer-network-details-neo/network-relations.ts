import type {
  NetworkCallsignRelationEdge,
  NetworkCallsignRelationFreq,
  NetworkCallsignRelationNode,
  NetworkCallsignRelationsRsp,
} from '../../../../Bindings';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3';
import { buildDistinctColorPalette } from '../shared/distinct-colors';

export type NetworkCallsignRelationsEdgeView = NetworkCallsignRelationEdge & {
  visibleWeight: number;
  visibleByFreq: Array<{ freq: string; weight: number }>;
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

type NetworkCallsignRelationsRenderLimits = {
  maxRenderNodes: number;
  maxRenderEdges: number;
  softLimitMultiplier: number;
};

// These are pragmatic browser-performance guardrails for the force layout and SVG rendering path.
// The soft multiplier delays the warning state until the graph is well beyond the hard cap.
export const NETWORK_RELATIONS_RENDER_LIMITS: NetworkCallsignRelationsRenderLimits = {
  maxRenderNodes: 300,
  maxRenderEdges: 1000,
  softLimitMultiplier: 2,
};

function normalizeRelationText(value: string | null | undefined): string {
  return (value?.trim() ?? '').toLocaleUpperCase('uk-UA');
}

function normalizeEnabledFreq(value: string): string {
  return value.trim();
}

function withFrequencyColors(freqs: NetworkCallsignRelationFreq[]): NetworkCallsignRelationFreqView[] {
  const palette = buildDistinctColorPalette(freqs.length);
  return freqs.map((freq, index) => ({
    ...freq,
    color: palette[index] ?? '#8b8b8b',
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
      .filter((item) => enabledFreqSet.has(normalizeEnabledFreq(item.freq)))
      .map((item) => ({
        freq: item.freq,
        weight: item.weight,
      }));
    const visibleWeight = edge.byFreq.length === 0 ? edge.weight : visibleByFreq.reduce((total, item) => total + item.weight, 0);
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

export function limitGraphEdgesByWeight(edges: NetworkCallsignRelationsEdgeView[], maxEdges: number): NetworkCallsignRelationsEdgeView[] {
  return [...edges]
    .sort((left, right) => right.visibleWeight - left.visibleWeight || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, maxEdges));
}

export type RelationGraphViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RelationGraphLayoutNode = NetworkCallsignRelationNode & {
  x: number;
  y: number;
  radius: number;
};

export type RelationGraphLayoutLink = {
  source: string;
  target: string;
  weight: number;
};

export type RelationGraphLayout = {
  nodes: RelationGraphLayoutNode[];
  positions: Map<string, { x: number; y: number }>;
  bounds: RelationGraphViewBox;
};

export type NetworkCallsignRelationsGraphRenderView = NetworkCallsignRelationsGraphView & {
  warning: boolean;
};

const MIN_VIEWBOX_SIZE = 900;
const VIEWBOX_PADDING = 160;
const GRAPH_MIN_VIEWBOX_SIZE = 320;
const GRAPH_MAX_VIEWBOX_SIZE = 4200;

export function isPointVisibleInRelationViewBox(x: number, y: number, viewBox: RelationGraphViewBox, padding = 0): boolean {
  return x >= viewBox.x - padding && x <= viewBox.x + viewBox.width + padding && y >= viewBox.y - padding && y <= viewBox.y + viewBox.height + padding;
}

function clampRelationViewBox(viewBox: RelationGraphViewBox): RelationGraphViewBox {
  return {
    x: viewBox.x,
    y: viewBox.y,
    width: Math.min(GRAPH_MAX_VIEWBOX_SIZE, Math.max(GRAPH_MIN_VIEWBOX_SIZE, viewBox.width)),
    height: Math.min(GRAPH_MAX_VIEWBOX_SIZE, Math.max(GRAPH_MIN_VIEWBOX_SIZE, viewBox.height)),
  };
}

export function createRelationGraphLayout(nodes: NetworkCallsignRelationNode[], edges: NetworkCallsignRelationsEdgeView[]): RelationGraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      positions: new Map(),
      bounds: { x: -MIN_VIEWBOX_SIZE / 2, y: -MIN_VIEWBOX_SIZE / 2, width: MIN_VIEWBOX_SIZE, height: MIN_VIEWBOX_SIZE },
    };
  }

  const layoutNodes: RelationGraphLayoutNode[] = nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1);
    const radius = 28 + Math.min(node.weight, 32);
    return {
      ...node,
      x: Math.cos(angle) * 220,
      y: Math.sin(angle) * 220,
      radius,
    };
  });

  const layoutLinks: RelationGraphLayoutLink[] = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.visibleWeight,
  }));

  const simulation = forceSimulation(layoutNodes)
    .force('charge', forceManyBody().strength(-300))
    .force(
      'link',
      forceLink<RelationGraphLayoutNode, RelationGraphLayoutLink>(layoutLinks as any)
        .id((node) => node.id)
        .distance((link) => 140 - Math.min((link.weight ?? 1) * 4, 70))
        .strength(0.25),
    )
    .force('center', forceCenter(0, 0))
    .force('collision', forceCollide<RelationGraphLayoutNode>().radius((node) => node.radius + 18).strength(0.9));
  simulation.stop();
  for (let index = 0; index < 240; index += 1) simulation.tick();

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of layoutNodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      nodes: layoutNodes,
      positions: new Map(layoutNodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      bounds: { x: -MIN_VIEWBOX_SIZE / 2, y: -MIN_VIEWBOX_SIZE / 2, width: MIN_VIEWBOX_SIZE, height: MIN_VIEWBOX_SIZE },
    };
  }

  const width = Math.max(maxX - minX + VIEWBOX_PADDING * 2, MIN_VIEWBOX_SIZE);
  const height = Math.max(maxY - minY + VIEWBOX_PADDING * 2, MIN_VIEWBOX_SIZE * 0.7);
  const bounds = {
    x: minX - VIEWBOX_PADDING,
    y: minY - VIEWBOX_PADDING,
    width,
    height,
  };

  return {
    nodes: layoutNodes,
    positions: new Map(layoutNodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
    bounds,
  };
}

export function buildRenderableNetworkCallsignRelationsGraphView(
  graphView: NetworkCallsignRelationsGraphView,
  visibleNodes: NetworkCallsignRelationsNodeView[],
  renderLimits: NetworkCallsignRelationsRenderLimits = NETWORK_RELATIONS_RENDER_LIMITS,
): NetworkCallsignRelationsGraphRenderView {
  const { maxRenderNodes, maxRenderEdges, softLimitMultiplier } = renderLimits;

  if (visibleNodes.length > maxRenderNodes * softLimitMultiplier || graphView.edges.length > maxRenderEdges * softLimitMultiplier) {
    return { ...graphView, nodes: [], edges: [], warning: true };
  }

  const limitedEdges = graphView.edges.length > maxRenderEdges ? limitGraphEdgesByWeight(graphView.edges, maxRenderEdges) : graphView.edges;
  if (limitedEdges.length === 0) {
    return { ...graphView, nodes: [], edges: [], warning: false };
  }

  const limitedNodeIds = new Set<string>();
  for (const edge of limitedEdges) {
    limitedNodeIds.add(edge.source);
    limitedNodeIds.add(edge.target);
  }

  const renderNodes = visibleNodes.filter((node) => limitedNodeIds.has(node.id));
  if (renderNodes.length === 0) {
    return { ...graphView, nodes: [], edges: [], warning: true };
  }

  if (renderNodes.length > maxRenderNodes) {
    return { ...graphView, nodes: [], edges: [], warning: true };
  }

  if (graphView.matchedNodeIds.size > 0) {
    for (const matchedNodeId of graphView.matchedNodeIds) {
      if (!limitedNodeIds.has(matchedNodeId)) {
        return { ...graphView, nodes: [], edges: [], warning: true };
      }
    }
  }

  return {
    ...graphView,
    nodes: renderNodes,
    edges: limitedEdges,
    warning: false,
  };
}

export function zoomRelationGraphViewBox(viewBox: RelationGraphViewBox, factor: number): RelationGraphViewBox {
  const nextWidth = Math.max(MIN_VIEWBOX_SIZE / 2, viewBox.width * factor);
  const nextHeight = Math.max(MIN_VIEWBOX_SIZE / 2, viewBox.height * factor);
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  return clampRelationViewBox({
    x: centerX - nextWidth / 2,
    y: centerY - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  });
}

export function moveRelationGraphViewBox(
  viewBox: RelationGraphViewBox,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): RelationGraphViewBox {
  const xScale = viewBox.width / Math.max(viewportWidth, 1);
  const yScale = viewBox.height / Math.max(viewportHeight, 1);
  return clampRelationViewBox({
    ...viewBox,
    x: viewBox.x - deltaX * xScale,
    y: viewBox.y - deltaY * yScale,
  });
}

export function getRelationEdgeBounds(edge: NetworkCallsignRelationsEdgeView, positions: Map<string, { x: number; y: number }>): RelationGraphViewBox | null {
  const sourcePosition = positions.get(edge.source);
  const targetPosition = positions.get(edge.target);
  if (!sourcePosition || !targetPosition) return null;

  const ctrlX = (sourcePosition.x + targetPosition.x) / 2;
  const ctrlY = (sourcePosition.y + targetPosition.y) / 2 - Math.min(Math.abs(sourcePosition.x - targetPosition.x), Math.abs(sourcePosition.y - targetPosition.y)) * 0.14;
  const minX = Math.min(sourcePosition.x, targetPosition.x, ctrlX);
  const minY = Math.min(sourcePosition.y, targetPosition.y, ctrlY);
  const maxX = Math.max(sourcePosition.x, targetPosition.x, ctrlX);
  const maxY = Math.max(sourcePosition.y, targetPosition.y, ctrlY);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function intersectsRelationViewBox(bounds: RelationGraphViewBox | null, viewBox: RelationGraphViewBox, padding = 0): boolean {
  if (!bounds) return false;
  return !(
    bounds.x + bounds.width < viewBox.x - padding ||
    bounds.x > viewBox.x + viewBox.width + padding ||
    bounds.y + bounds.height < viewBox.y - padding ||
    bounds.y > viewBox.y + viewBox.height + padding
  );
}

export function buildRelationNeighborIds(edge: NetworkCallsignRelationEdge): Set<string> {
  return new Set([edge.source, edge.target]);
}

export function getRelationFreqColor(freq: string, freqs: NetworkCallsignRelationFreqView[]): string {
  return freqs.find((item) => item.freq === freq)?.color ?? '#8b8b8b';
}

export function getRelationEdgeStroke(edge: NetworkCallsignRelationsEdgeView, freqs: NetworkCallsignRelationFreqView[]): string {
  const topFreq = edge.visibleByFreq[0]?.freq ?? edge.byFreq[0]?.freq ?? null;
  return topFreq ? getRelationFreqColor(topFreq, freqs) : 'rgba(255, 255, 255, 0.3)';
}

export function getRelationNodeFill(node: NetworkCallsignRelationNode, selected: boolean, highlighted: boolean): string {
  if (selected) return '#e0a25e';
  if (highlighted) return '#c7965c';
  return '#9a8568';
}

export function isCatalogRelationNode(node: Pick<NetworkCallsignRelationNode, 'enrichmentSource'>): boolean {
  return node.enrichmentSource === 'RelationEnrichmentCatalog';
}

export function getRelationEdgeLabel(edge: NetworkCallsignRelationsEdgeView): string {
  const firstFreq = edge.visibleByFreq[0];
  if (!firstFreq) return String(edge.visibleWeight);
  if (edge.visibleByFreq.length === 1) return String(firstFreq.weight);
  return `${firstFreq.weight}`;
}
