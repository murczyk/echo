import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import StarIcon from '@mui/icons-material/Star';
import { useTheme } from '@mui/material/styles';
import {
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from 'react';
import type { ComponentType } from 'react';

import {
  getRelationEdgeLabel,
  getRelationEdgeStroke,
  getRelationNodeFill,
  isPointVisibleInRelationViewBox,
  isCatalogRelationNode,
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
  onWheel: (event: WheelEvent) => void;
};

function renderNodeMarkerBadge(
  x: number,
  y: number,
  label: string,
  Icon: ComponentType<any>,
  fill: string,
) {
  const badgeDiameter = 24;
  const iconSize = 16;

  return (
    <g
      key={label}
      transform={`translate(${x} ${y})`}
      role="img"
      aria-label={label}
      style={{ pointerEvents: 'none' }}
    >
      <title>{label}</title>
      <circle
        cx={0}
        cy={0}
        r={badgeDiameter / 2}
        fill={fill}
        stroke="rgba(255,255,255,0.42)"
        strokeWidth={1}
      />
      <Icon
        x={-iconSize / 2}
        y={-iconSize / 2}
        width={iconSize}
        height={iconSize}
        htmlColor="#ffffff"
      />
    </g>
  );
}

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
  onWheel,
}: Props) {
  const theme = useTheme();
  const [svgElement, setSvgElement] = useState<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!svgElement) return;

    const handleWheel = (event: WheelEvent) => {
      onWheel(event);
    };

    svgElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      svgElement.removeEventListener('wheel', handleWheel);
    };
  }, [onWheel, svgElement]);

  return (
    <svg
      ref={(node) => {
        svgRef.current = node;
        setSvgElement(node);
      }}
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
        const highlighted =
          selected ||
          (selectedNodeId !== null &&
            (edge.source === selectedNodeId || edge.target === selectedNodeId));
        const stroke = getRelationEdgeStroke(edge, legendFreqs);
        const opacity = highlighted ? 1 : selectedNeighborIds.size > 0 ? 0.18 : 0.5;
        const width = 1.8 + Math.min(edge.visibleWeight, 8) * 0.65;
        const ctrlX = (sourcePosition.x + targetPosition.x) / 2;
        const ctrlY =
          (sourcePosition.y + targetPosition.y) / 2 -
          Math.min(
            Math.abs(sourcePosition.x - targetPosition.x),
            Math.abs(sourcePosition.y - targetPosition.y),
          ) *
            0.14;

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
            {relationsShowLabels &&
            !denseGraph &&
            isPointVisibleInRelationViewBox(ctrlX, ctrlY, viewBox, 48) ? (
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
        const highlighted =
          selected ||
          (selectedNodeId !== null ? selectedNeighborIds.has(node.id) : node.matchedSearch);
        const opacity =
          selectedNodeId !== null || selectedEdgeId !== null
            ? highlighted
              ? 1
              : 0.28
            : node.matchedSearch
              ? 1
              : 0.9;
        const stroke = node.matchedSearch
          ? '#f0d2a0'
          : selected
            ? '#fff5df'
            : 'rgba(255,255,255,0.18)';
        const radius = Math.max(20, 22 + Math.min(node.weight, 24) * 0.65);
        const markerOffset = 15;
        const catalogMarkerOffset = 18;

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
            {isCatalogRelationNode(node)
              ? renderNodeMarkerBadge(
                  position.x,
                  position.y - catalogMarkerOffset,
                  'Збіг з каталогу, не підтверджено в мережі',
                  InfoOutlinedIcon,
                  theme.palette.secondary.main,
                )
              : null}
            {node.mainRadioStation
              ? renderNodeMarkerBadge(
                  node.commandControl ? position.x - markerOffset : position.x,
                  position.y,
                  'Головна радіостанція',
                  StarIcon,
                  theme.palette.warning.main,
                )
              : null}
            {node.commandControl
              ? renderNodeMarkerBadge(
                  node.mainRadioStation ? position.x + markerOffset : position.x,
                  position.y,
                  'Ланка управління',
                  MilitaryTechOutlinedIcon,
                  theme.palette.info.main,
                )
              : null}
            {((relationsShowLabels &&
              !denseGraph &&
              isPointVisibleInRelationViewBox(position.x, position.y, viewBox, radius * 3)) ||
              selected ||
              node.matchedSearch) && (
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
