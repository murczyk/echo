import { type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';

import {
  getRelationEdgeLabel,
  getRelationEdgeStroke,
  getRelationNodeFill,
  isPointVisibleInRelationViewBox,
  type NetworkCallsignRelationFreqView,
  type NetworkCallsignRelationsGraphView,
  type RelationGraphLayout,
  type RelationGraphViewBox,
} from '../network-relations';

type Props = {
  svgRef: MutableRefObject<SVGSVGElement | null>;
  headingId: string;
  graphView: NetworkCallsignRelationsGraphView;
  layout: RelationGraphLayout;
  viewBox: RelationGraphViewBox;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedNeighborIds: Set<string>;
  relationsShowLabels: boolean;
  denseGraph: boolean;
  isDarkMode: boolean;
  legendFreqs: NetworkCallsignRelationFreqView[];
  visibleEdgeIdsForRender: Set<string>;
  visibleNodeIdsForRender: Set<string>;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
};

export function NetworkCallsignRelationsGraphCanvas({
  svgRef,
  headingId,
  graphView,
  layout,
  viewBox,
  selectedNodeId,
  selectedEdgeId,
  selectedNeighborIds,
  relationsShowLabels,
  denseGraph,
  isDarkMode,
  legendFreqs,
  visibleEdgeIdsForRender,
  visibleNodeIdsForRender,
  onSelectNodeId,
  onSelectEdgeId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Props) {
  return (
    <svg
      ref={svgRef}
      role="img"
      aria-label="Граф зв'язків позивних"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onClick={() => {
        onSelectNodeId(null);
        onSelectEdgeId(null);
      }}
    >
      <defs>
        <filter id={`${headingId}-node-shadow`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="rgba(0,0,0,0.65)" />
        </filter>
      </defs>

      {graphView.edges.map((edge) => {
        if (!visibleEdgeIdsForRender.has(edge.id)) return null;
        const sourcePosition = layout.positions.get(edge.source);
        const targetPosition = layout.positions.get(edge.target);
        if (!sourcePosition || !targetPosition) return null;
        const selected = selectedEdgeId === edge.id;
        const highlighted = selected || (selectedNodeId !== null && (edge.source === selectedNodeId || edge.target === selectedNodeId));
        const stroke = getRelationEdgeStroke(edge, legendFreqs);
        const opacity = highlighted ? 1 : selectedNeighborIds.size > 0 ? 0.18 : 0.5;
        const width = 1.8 + Math.min(edge.visibleWeight, 8) * 0.65;
        const ctrlX = (sourcePosition.x + targetPosition.x) / 2;
        const ctrlY = (sourcePosition.y + targetPosition.y) / 2 - Math.min(Math.abs(sourcePosition.x - targetPosition.x), Math.abs(sourcePosition.y - targetPosition.y)) * 0.14;

        return (
          <g
            key={edge.id}
            opacity={opacity}
            onClick={(event) => {
              event.stopPropagation();
              onSelectEdgeId(edge.id);
            }}
            style={{ cursor: 'pointer' }}
          >
            <path
              d={`M ${sourcePosition.x} ${sourcePosition.y} Q ${ctrlX} ${ctrlY} ${targetPosition.x} ${targetPosition.y}`}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={selected ? 1 : 0.8}
            />
            {relationsShowLabels && !denseGraph && isPointVisibleInRelationViewBox(ctrlX, ctrlY, viewBox, 48) ? (
              <text
                x={ctrlX}
                y={ctrlY - 8}
                textAnchor="middle"
                fill={isDarkMode ? 'rgba(255,255,255,0.62)' : '#111111'}
                fontSize="14"
                fontWeight="600"
                style={{ pointerEvents: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
              >
                {getRelationEdgeLabel(edge)}
              </text>
            ) : null}
          </g>
        );
      })}

      {graphView.nodes.map((node) => {
        if (!visibleNodeIdsForRender.has(node.id)) return null;
        const position = layout.positions.get(node.id);
        if (!position || !node.visible) return null;
        const selected = selectedNodeId === node.id;
        const highlighted = selected || (selectedNodeId !== null ? selectedNeighborIds.has(node.id) : node.matchedSearch);
        const opacity = selectedNodeId !== null || selectedEdgeId !== null ? (highlighted ? 1 : 0.28) : node.matchedSearch ? 1 : 0.9;
        const stroke = node.matchedSearch ? '#f0d2a0' : selected ? '#fff5df' : 'rgba(255,255,255,0.18)';
        const radius = Math.max(20, 22 + Math.min(node.weight, 24) * 0.65);

        return (
          <g
            key={node.id}
            opacity={opacity}
            onClick={(event) => {
              event.stopPropagation();
              onSelectNodeId(node.id);
            }}
            style={{ cursor: 'pointer' }}
          >
            <circle
              cx={position.x}
              cy={position.y}
              r={radius}
              fill={getRelationNodeFill(node, selected, highlighted)}
              stroke={stroke}
              strokeWidth={selected ? 4 : 2}
              filter={`url(#${headingId}-node-shadow)`}
            />
            {((relationsShowLabels && !denseGraph && isPointVisibleInRelationViewBox(position.x, position.y, viewBox, radius * 3)) || selected || node.matchedSearch) && (
              <text
                x={position.x}
                y={position.y + radius + 18}
                textAnchor="middle"
                fill={isDarkMode ? 'rgba(255,255,255,0.88)' : '#111111'}
                fontSize="18"
                fontWeight="700"
                style={{ pointerEvents: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
              >
                {node.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
