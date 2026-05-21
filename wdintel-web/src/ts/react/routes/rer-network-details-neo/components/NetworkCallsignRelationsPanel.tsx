import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import AddIcon from '@mui/icons-material/Add';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Paper,
  Popover,
  Slider,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3';
import dayjs from 'dayjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type {
  NetworkCallsignRelationEdge,
  NetworkCallsignRelationNode,
  NetworkCallsignRelationsRsp,
} from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { APP_DATETIME_INPUT_MIN } from '../../../utils/misc';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../shared/empty-state-text';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
import { NetworkDetailsLoadingState } from './NetworkDetailsLoadingState';
import {
  buildNetworkCallsignRelationsGraphView,
  filterNetworkCallsignRelationEdgeMessages,
  type NetworkCallsignRelationFreqView,
  type NetworkCallsignRelationsEdgeView,
} from '../network-relations';
import { NetworkDatePickerField } from './NetworkDatePickerField';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';

type Props = {
  relations: NetworkCallsignRelationsRsp | null;
  relationsLoaded: boolean;
  relationsLoading: boolean;
  relationsError: string | null;
  relationsSearch: string;
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsShowLabels: boolean;
  relationsSelectedNodeId: string | null;
  relationsSelectedEdgeId: string | null;
  relationsSince: string;
  relationsTill: string;
  onReload: () => void;
  onSearchChange: (value: string) => void;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onShowLabelsChange: (value: boolean) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onRelationsSinceChange: (value: string) => void;
  onRelationsTillChange: (value: string) => void;
};

type ViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type LayoutNode = NetworkCallsignRelationNode & {
  x: number;
  y: number;
  radius: number;
};

type LayoutLink = {
  source: string;
  target: string;
  weight: number;
};

type GraphLayout = {
  nodes: LayoutNode[];
  positions: Map<string, { x: number; y: number }>;
  bounds: ViewBox;
};

const MIN_VIEWBOX_SIZE = 900;
const VIEWBOX_PADDING = 160;
const GRAPH_MIN_VIEWBOX_SIZE = 320;
const GRAPH_MAX_VIEWBOX_SIZE = 4200;
const GRAPH_WHEEL_ZOOM_IN_FACTOR = 0.88;
const GRAPH_WHEEL_ZOOM_OUT_FACTOR = 1.14;
function isPointVisibleInViewBox(x: number, y: number, viewBox: ViewBox, padding = 0): boolean {
  return x >= viewBox.x - padding && x <= viewBox.x + viewBox.width + padding && y >= viewBox.y - padding && y <= viewBox.y + viewBox.height + padding;
}

function clampViewBox(viewBox: ViewBox): ViewBox {
  return {
    x: viewBox.x,
    y: viewBox.y,
    width: Math.min(GRAPH_MAX_VIEWBOX_SIZE, Math.max(GRAPH_MIN_VIEWBOX_SIZE, viewBox.width)),
    height: Math.min(GRAPH_MAX_VIEWBOX_SIZE, Math.max(GRAPH_MIN_VIEWBOX_SIZE, viewBox.height)),
  };
}

function createLayout(nodes: NetworkCallsignRelationNode[], edges: NetworkCallsignRelationsEdgeView[]): GraphLayout {
  if (nodes.length === 0) {
    return {
      nodes: [],
      positions: new Map(),
      bounds: { x: -MIN_VIEWBOX_SIZE / 2, y: -MIN_VIEWBOX_SIZE / 2, width: MIN_VIEWBOX_SIZE, height: MIN_VIEWBOX_SIZE },
    };
  }

  const layoutNodes: LayoutNode[] = nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1);
    const radius = 28 + Math.min(node.weight, 32);
    return {
      ...node,
      x: Math.cos(angle) * 220,
      y: Math.sin(angle) * 220,
      radius,
    };
  });

  const layoutLinks: LayoutLink[] = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.visibleWeight,
  }));

  const simulation = forceSimulation(layoutNodes)
    .force('charge', forceManyBody().strength(-300))
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(layoutLinks as any)
        .id((node) => node.id)
        .distance((link) => 140 - Math.min((link.weight ?? 1) * 4, 70))
        .strength(0.25),
    )
    .force('center', forceCenter(0, 0))
    .force('collision', forceCollide<LayoutNode>().radius((node) => node.radius + 18).strength(0.9));
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

function zoomViewBox(viewBox: ViewBox, factor: number): ViewBox {
  const nextWidth = Math.max(MIN_VIEWBOX_SIZE / 2, viewBox.width * factor);
  const nextHeight = Math.max(MIN_VIEWBOX_SIZE / 2, viewBox.height * factor);
  const centerX = viewBox.x + viewBox.width / 2;
  const centerY = viewBox.y + viewBox.height / 2;
  return clampViewBox({
    x: centerX - nextWidth / 2,
    y: centerY - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  });
}

function moveViewBox(viewBox: ViewBox, deltaX: number, deltaY: number, viewportWidth: number, viewportHeight: number): ViewBox {
  const xScale = viewBox.width / Math.max(viewportWidth, 1);
  const yScale = viewBox.height / Math.max(viewportHeight, 1);
  return clampViewBox({
    ...viewBox,
    x: viewBox.x - deltaX * xScale,
    y: viewBox.y - deltaY * yScale,
  });
}

function getFreqColor(freq: string, freqs: NetworkCallsignRelationFreqView[]): string {
  return freqs.find((item) => item.freq === freq)?.color ?? '#8b8b8b';
}

function getEdgeStroke(edge: NetworkCallsignRelationsEdgeView, freqs: NetworkCallsignRelationFreqView[]): string {
  const topFreq = edge.visibleByFreq[0]?.freq ?? edge.byFreq[0]?.freq ?? null;
  return topFreq ? getFreqColor(topFreq, freqs) : 'rgba(255, 255, 255, 0.3)';
}

function getNodeFill(node: NetworkCallsignRelationNode, selected: boolean, highlighted: boolean): string {
  if (selected) return '#e0a25e';
  if (highlighted) return '#c7965c';
  return '#9a8568';
}

function getEdgeLabel(edge: NetworkCallsignRelationsEdgeView): string {
  const firstFreq = edge.visibleByFreq[0];
  if (!firstFreq) return String(edge.visibleWeight);
  if (edge.visibleByFreq.length === 1) return String(firstFreq.weight);
  return `${firstFreq.weight}`;
}

function buildNeighborIds(edge: NetworkCallsignRelationEdge): Set<string> {
  return new Set([edge.source, edge.target]);
}

function getEdgeBounds(edge: NetworkCallsignRelationsEdgeView, positions: Map<string, { x: number; y: number }>): ViewBox | null {
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

function intersectsViewBox(bounds: ViewBox | null, viewBox: ViewBox, padding = 0): boolean {
  if (!bounds) return false;
  return !(
    bounds.x + bounds.width < viewBox.x - padding ||
    bounds.x > viewBox.x + viewBox.width + padding ||
    bounds.y + bounds.height < viewBox.y - padding ||
    bounds.y > viewBox.y + viewBox.height + padding
  );
}

export function NetworkCallsignRelationsPanel({
  relations,
  relationsLoaded,
  relationsLoading,
  relationsError,
  relationsSearch,
  relationsEnabledFreqs,
  relationsMinIntensity,
  relationsShowLabels,
  relationsSelectedNodeId,
  relationsSelectedEdgeId,
  relationsSince,
  relationsTill,
  onReload,
  onSearchChange,
  onEnabledFreqsChange,
  onMinIntensityChange,
  onShowLabelsChange,
  onSelectNodeId,
  onSelectEdgeId,
  onRelationsSinceChange,
  onRelationsTillChange,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const filterButtonId = `${headingId}-filters`;
  const filterPopoverId = `${headingId}-filters-popover`;
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const graphFrameBg = isDarkMode ? '#0f0f0f' : theme.palette.background.paper;
  const graphFrameBorder = alpha(theme.palette.divider, isDarkMode ? 0.6 : 0.85);
  const graphGridLine = isDarkMode ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
  const graphOverlayBg = isDarkMode ? 'rgba(12,12,12,0.94)' : alpha(theme.palette.background.paper, 0.98);
  const graphOverlayBorder = alpha(theme.palette.divider, isDarkMode ? 0.5 : 0.85);
  const graphOverlayShadow = isDarkMode ? '0 12px 28px rgba(0,0,0,0.35)' : '0 12px 24px rgba(0,0,0,0.10)';
  const graphOverlayText = theme.palette.text.primary;
  const graphOverlayTextSecondary = alpha(theme.palette.text.primary, isDarkMode ? 0.72 : 0.62);
  const graphZoomControlBg = isDarkMode ? '#24272d' : alpha(theme.palette.background.paper, 0.96);
  const graphZoomControlBorder = isDarkMode ? 'rgba(255,255,255,0.28)' : alpha(theme.palette.text.primary, 0.35);
  const graphZoomControlHoverBg = isDarkMode ? 'rgba(255,255,255,0.08)' : alpha(theme.palette.text.primary, 0.06);
  const graphZoomControlText = isDarkMode ? '#f3f5f7' : theme.palette.text.primary;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; viewBox: ViewBox } | null>(null);
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({ x: -MIN_VIEWBOX_SIZE / 2, y: -MIN_VIEWBOX_SIZE / 2, width: MIN_VIEWBOX_SIZE, height: MIN_VIEWBOX_SIZE });

  const graphView = useMemo(
    () => buildNetworkCallsignRelationsGraphView(relations, relationsSearch, relationsEnabledFreqs, relationsMinIntensity),
    [relations, relationsEnabledFreqs, relationsMinIntensity, relationsSearch],
  );
  const layoutKey = useMemo(
    () => `${graphView.nodes.filter((node) => node.visible).map((node) => node.id).join('|')}::${graphView.edges.map((edge) => edge.id).join('|')}`,
    [graphView.edges, graphView.nodes],
  );
  const visibleNodes = useMemo(() => graphView.nodes.filter((node) => node.visible), [graphView.nodes]);
  const layout = useMemo(() => createLayout(visibleNodes, graphView.edges), [layoutKey]);

  useEffect(() => {
    setViewBox(layout.bounds);
  }, [layout.bounds, layoutKey]);

  const selectedNode = useMemo(
    () => graphView.nodes.find((node) => node.id === relationsSelectedNodeId) ?? null,
    [graphView.nodes, relationsSelectedNodeId],
  );
  const selectedEdge = useMemo(
    () => graphView.edges.find((edge) => edge.id === relationsSelectedEdgeId) ?? null,
    [graphView.edges, relationsSelectedEdgeId],
  );
  const selectedEdgeVisibleMessages = useMemo(() => filterNetworkCallsignRelationEdgeMessages(selectedEdge), [selectedEdge]);
  const selectedNodeEdges = useMemo(
    () => graphView.edges.filter((edge) => edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId),
    [graphView.edges, relationsSelectedNodeId],
  );
  const selectedNeighborIds = useMemo(() => {
    if (selectedNode) {
      const ids = new Set<string>([selectedNode.id]);
      for (const edge of selectedNodeEdges) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
      return ids;
    }
    if (selectedEdge) return buildNeighborIds(selectedEdge);
    return new Set<string>();
  }, [selectedEdge, selectedNode, selectedNodeEdges]);

  const graphCounts = useMemo(() => ({
    nodes: visibleNodes.length,
    edges: graphView.edges.length,
  }), [graphView.edges.length, visibleNodes.length]);
  const hasRenderableGraph = Boolean(relations && graphCounts.nodes > 0 && graphCounts.edges > 0);

  const totalIntensity = graphView.edges.reduce((total, edge) => total + edge.visibleWeight, 0);
  const maxIntensity = Math.max(1, ...graphView.edges.map((edge) => edge.visibleWeight));
  const intensitySliderMax = Math.max(maxIntensity, NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY);
  const legendFreqs = graphView.freqs;
  const denseGraph = visibleNodes.length > 40 || graphView.edges.length > 90 || viewBox.width > layout.bounds.width * 1.6;
  const relationsDateMin = useMemo(() => dayjs(APP_DATETIME_INPUT_MIN).startOf('day'), []);
  const relationsDateMax = useMemo(() => dayjs().startOf('day'), []);
  const relationsSinceMax = useMemo(() => {
    const parsed = dayjs(relationsTill);
    return parsed.isValid() ? parsed.startOf('day') : relationsDateMax;
  }, [relationsTill, relationsDateMax]);
  const relationsTillMin = useMemo(() => {
    const parsed = dayjs(relationsSince);
    return parsed.isValid() ? parsed.startOf('day') : relationsDateMin;
  }, [relationsSince, relationsDateMin]);

  const handleZoom = (factor: number) => {
    setViewBox((current) => zoomViewBox(current, factor));
  };

  const handleFilterToggle = (freq: string, checked: boolean) => {
    const nextFreqs = checked
      ? [...new Set([...relationsEnabledFreqs, freq])]
      : relationsEnabledFreqs.filter((item) => item !== freq);
    onEnabledFreqsChange(nextFreqs);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !hasRenderableGraph) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? GRAPH_WHEEL_ZOOM_OUT_FACTOR : GRAPH_WHEEL_ZOOM_IN_FACTOR;
      setViewBox((current) => zoomViewBox(current, factor));
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', handleWheel);
    };
  }, [hasRenderableGraph]);

  const visibleEdgeIdsForRender = useMemo(() => {
    if (!hasRenderableGraph) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of graphView.edges) {
      const bounds = getEdgeBounds(edge, layout.positions);
      const isSelected = relationsSelectedEdgeId === edge.id;
      const touchesSelectedNode = relationsSelectedNodeId !== null && (edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId);
      const shouldRender = isSelected || touchesSelectedNode || intersectsViewBox(bounds, viewBox, 180);
      if (shouldRender) {
        ids.add(edge.id);
      }
    }
    return ids;
  }, [graphView.edges, hasRenderableGraph, layout.positions, relationsSelectedEdgeId, relationsSelectedNodeId, viewBox]);

  const visibleNodeIdsForRender = useMemo(() => {
    if (!hasRenderableGraph) return new Set<string>();
    const ids = new Set<string>();
    for (const node of graphView.nodes) {
      if (!node.visible) continue;
      const position = layout.positions.get(node.id);
      if (!position) continue;
      const selected = relationsSelectedNodeId === node.id;
      const matched = node.matchedSearch;
      const connectedToSelected =
        relationsSelectedEdgeId !== null &&
        graphView.edges.some((edge) => edge.id === relationsSelectedEdgeId && (edge.source === node.id || edge.target === node.id));
      const shouldRender = selected || matched || connectedToSelected || isPointVisibleInViewBox(position.x, position.y, viewBox, 240);
      if (shouldRender) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [graphView.edges, graphView.nodes, hasRenderableGraph, layout.positions, relationsSelectedEdgeId, relationsSelectedNodeId, viewBox]);

  const graphIsFilteredEmpty = relations !== null && !hasRenderableGraph;

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || event.target !== event.currentTarget) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      viewBox,
    };
    svg.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) return;
    const viewport = svg.getBoundingClientRect();
    setViewBox(moveViewBox(drag.viewBox, event.clientX - drag.x, event.clientY - drag.y, viewport.width, viewport.height));
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    dragRef.current = null;
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch (_) {
      // ignore
    }
  };

  if (relationsError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, alignItems: 'center' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {relationsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReload}>
            Спробувати ще раз
          </Button>
        </Stack>
      </Box>
    );
  }

  if (relationsLoading || (!relationsLoaded && relations === null)) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <NetworkDetailsLoadingState message="Завантажуємо граф зв'язків…" />
        </Stack>
      </Box>
    );
  }

  if (!relations) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <NetworkDetailsEmptyState
            icon={<AccountTreeOutlinedIcon />}
            title="Немає графових даних"
            description="Граф будується після першого зв'язку між позивними."
            minHeight={360}
            action={
              <Button variant="outlined" onClick={onReload}>
                Оновити
              </Button>
            }
          />
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <Typography variant="body2" sx={{ color: graphOverlayTextSecondary, textAlign: 'right' }}>
            {graphCounts.nodes} вузлів · {graphCounts.edges} зв'язків · {totalIntensity} перехоплень
          </Typography>
        </Stack>

        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Stack direction="row" alignItems="center" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
            <TextField
              size="small"
              value={relationsSearch}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Пошук"
              sx={{ width: { xs: 180, sm: 220 }, flexShrink: 0 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchOutlinedIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: relationsSearch.trim() !== '' ? (
                  <InputAdornment position="end">
                    <Tooltip title="Очистити пошук">
                      <IconButton aria-label="Очистити пошук" size="small" onClick={() => onSearchChange('')} sx={{ p: 0.25 }}>
                        <ClearOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
              }}
            />
            <NetworkDatePickerField
              label="Від"
              value={relationsSince}
              onChange={onRelationsSinceChange}
              minDate={relationsDateMin}
              maxDate={relationsSinceMax}
              allowEmpty={false}
              width={148}
            />
            <NetworkDatePickerField
              label="До"
              value={relationsTill}
              onChange={onRelationsTillChange}
              minDate={relationsTillMin}
              maxDate={relationsDateMax}
              allowEmpty={false}
              width={148}
            />
            <FormControlLabel
              control={<Switch checked={relationsShowLabels} onChange={(_, checked) => onShowLabelsChange(checked)} />}
              label="Підписи"
              sx={{ m: 0, flexShrink: 0 }}
            />
          </Stack>

          <Box sx={{ flexShrink: 0 }}>
            <Tooltip title="Налаштування">
              <IconButton
                id={filterButtonId}
                aria-label="Налаштування"
                aria-describedby={filterAnchorEl ? filterPopoverId : undefined}
                onClick={(event) => setFilterAnchorEl(event.currentTarget)}
              >
                <SettingsRoundedIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Stack>

        <Paper
          variant="outlined"
          sx={{
            minHeight: 0,
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            borderRadius: 2,
            borderColor: graphFrameBorder,
            bgcolor: graphFrameBg,
            boxShadow: isDarkMode ? 'inset 0 1px 0 rgba(255,255,255,0.03)' : 'inset 0 1px 0 rgba(0,0,0,0.03)',
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                `linear-gradient(${graphGridLine} 1px, transparent 1px), linear-gradient(90deg, ${graphGridLine} 1px, transparent 1px)`,
              backgroundSize: '48px 48px',
              opacity: isDarkMode ? 0.5 : 0.38,
              pointerEvents: 'none',
            }}
          />

          <Box
            sx={{
              position: 'absolute',
              top: 16,
              right: 16,
              zIndex: 2,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                overflow: 'hidden',
                borderRadius: '8px',
                bgcolor: graphZoomControlBg,
                border: `1px solid ${graphZoomControlBorder}`,
                boxShadow: isDarkMode ? '0 2px 10px rgba(0,0,0,0.22)' : '0 2px 10px rgba(0,0,0,0.12)',
                '& .MuiIconButton-root + .MuiIconButton-root': {
                  borderLeft: `1px solid ${graphZoomControlBorder}`,
                },
              }}
            >
              <IconButton
                onClick={() => handleZoom(GRAPH_WHEEL_ZOOM_IN_FACTOR)}
                aria-label="Збільшити"
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: 0,
                  color: graphZoomControlText,
                  flex: '0 0 44px',
                  minWidth: 44,
                  bgcolor: 'transparent',
                  '&:hover': {
                    bgcolor: graphZoomControlHoverBg,
                    color: graphZoomControlText,
                  },
                  '&:focus-visible': {
                    outline: `2px solid ${alpha(theme.palette.primary.main, 0.75)}`,
                    outlineOffset: -3,
                  },
                  '&:active': {
                    bgcolor: graphZoomControlHoverBg,
                    color: graphZoomControlText,
                  },
                  '& .MuiSvgIcon-root': {
                    color: 'inherit',
                  },
                }}
              >
                <AddIcon sx={{ fontSize: 24 }} />
              </IconButton>
              <IconButton
                onClick={() => handleZoom(GRAPH_WHEEL_ZOOM_OUT_FACTOR)}
                aria-label="Зменшити"
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: 0,
                  color: graphZoomControlText,
                  flex: '0 0 44px',
                  minWidth: 44,
                  bgcolor: 'transparent',
                  '&:hover': {
                    bgcolor: graphZoomControlHoverBg,
                    color: graphZoomControlText,
                  },
                  '&:focus-visible': {
                    outline: `2px solid ${alpha(theme.palette.primary.main, 0.75)}`,
                    outlineOffset: -3,
                  },
                  '&:active': {
                    bgcolor: graphZoomControlHoverBg,
                    color: graphZoomControlText,
                  },
                  '& .MuiSvgIcon-root': {
                    color: 'inherit',
                  },
                }}
              >
                <RemoveIcon sx={{ fontSize: 24 }} />
              </IconButton>
            </Box>
          </Box>

          {graphIsFilteredEmpty ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                display: 'grid',
                placeItems: 'center',
                px: 3,
                textAlign: 'center',
              }}
            >
              <Stack spacing={1.25} alignItems="center">
                <Typography variant="body1" sx={{ color: graphOverlayTextSecondary }}>
                  {EMPTY_STATE_NO_RESULTS_TEXT}
                </Typography>
                <Button
                  variant="text"
                  onClick={() => {
                    onEnabledFreqsChange(legendFreqs.map((freq) => freq.freq));
                    onMinIntensityChange(NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY);
                  }}
                  data-testid="clear-empty-filters"
                  sx={{
                    fontWeight: 400,
                    p: 0.5,
                    px: 2.5,
                    '&:hover': {
                      bgcolor: theme.palette.action.hover,
                    },
                  }}
                >
                  Очистити фільтри
                </Button>
              </Stack>
            </Box>
          ) : (
            <>
              <Box
                sx={{
                  position: 'absolute',
                  top: 16,
                  left: 16,
                  zIndex: 2,
                  px: 1.25,
                  py: 0.75,
                  borderRadius: 2,
                  bgcolor: graphOverlayBg,
                  border: `1px solid ${graphOverlayBorder}`,
                  color: graphOverlayText,
                }}
              >
                <Stack spacing={0.5}>
                  <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                    Інтенсивність
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {relationsMinIntensity}
                  </Typography>
                </Stack>
              </Box>

              <Box
                sx={{
                  position: 'absolute',
                  left: 16,
                  bottom: 16,
                  zIndex: 2,
                  px: 1.5,
                  py: 1.25,
                  minWidth: 150,
                  borderRadius: 2,
                  bgcolor: graphOverlayBg,
                  border: `1px solid ${graphOverlayBorder}`,
                  color: graphOverlayText,
                }}
              >
                <Typography variant="overline" sx={{ color: graphOverlayTextSecondary, letterSpacing: 1 }}>
                  Частоти
                </Typography>
                <Stack spacing={0.8} sx={{ mt: 0.5 }}>
                  {legendFreqs.map((freq) => {
                    const enabled = relationsEnabledFreqs.includes(freq.freq);
                    return (
                      <Stack key={freq.freq} direction="row" spacing={1} alignItems="center" sx={{ opacity: enabled ? 1 : 0.35 }}>
                        <Box sx={{ width: 18, height: 3, borderRadius: 999, bgcolor: freq.color, flexShrink: 0 }} />
                        <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          {freq.freq}
                        </Typography>
                      </Stack>
                    );
                  })}
                </Stack>
              </Box>

              <Stack
                spacing={1.5}
                sx={{
                  position: 'absolute',
                  right: 16,
                  bottom: 16,
                  zIndex: 3,
                  width: { xs: 'calc(100% - 32px)', md: 360 },
                  maxHeight: 'calc(100% - 32px)',
                  alignItems: 'stretch',
                  color: graphOverlayText,
                }}
              >
                <Box
                  sx={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    borderRadius: 2,
                    bgcolor: graphOverlayBg,
                    border: `1px solid ${graphOverlayBorder}`,
                    boxShadow: graphOverlayShadow,
                  }}
                >
                  <Box
                    sx={{
                      p: 1.5,
                      position: 'relative',
                      pr: selectedNode ? 4.5 : 1.5,
                      borderBottom: selectedEdge || selectedNode ? `1px solid ${graphOverlayBorder}` : 'none',
                      flexShrink: 0,
                    }}
                  >
                    {selectedEdge ? (
                      <Stack spacing={0.5}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {selectedEdge.source} ↔ {selectedEdge.target}
                        </Typography>
                        <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                          {selectedEdge.visibleWeight} перехоплень у {selectedEdge.visibleByFreq.length} частотах
                        </Typography>
                      </Stack>
                    ) : selectedNode ? (
                      <Stack spacing={0.5}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {selectedNode.label}
                        </Typography>
                        <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                          {selectedNode.position ?? 'Позиція не вказана'} · {selectedNode.unitName ?? 'Підрозділ не вказаний'}
                        </Typography>
                      </Stack>
                    ) : (
                      <Stack spacing={0.5}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          Виберіть вузол або зв'язок
                        </Typography>
                        <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                          Підсвітка сусідів і перехоплень з'явиться тут
                        </Typography>
                      </Stack>
                    )}
                    {selectedNode ? (
                      <IconButton
                        size="small"
                        onClick={() => onSelectNodeId(null)}
                        aria-label="Закрити деталі вузла"
                        sx={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                        }}
                      >
                        <CloseOutlinedIcon fontSize="small" />
                      </IconButton>
                    ) : null}
                  </Box>

                  {(selectedEdge || selectedNode) ? (
                    <Box sx={{ p: 1.5, overflow: 'auto', minHeight: 0 }}>
                      {selectedEdge ? (
                        <Stack spacing={1.5}>
                          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            {selectedEdge.visibleByFreq.map((item) => (
                              <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: 'rgba(255,255,255,0.06)' }} />
                            ))}
                          </Stack>
                          <Divider sx={{ borderColor: graphOverlayBorder }} />
                          <Stack spacing={1}>
                            {selectedEdgeVisibleMessages.map((message) => (
                              <Paper
                                key={message.id}
                                variant="outlined"
                                sx={{
                                  p: 1,
                                  bgcolor: 'rgba(255,255,255,0.02)',
                                  borderColor: graphOverlayBorder,
                                }}
                              >
                                <Stack spacing={0.5}>
                                  <Stack direction="row" justifyContent="space-between" spacing={1}>
                                    <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                                      #{message.id}
                                    </Typography>
                                    <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                                      {message.freq ?? 'без частоти'}
                                    </Typography>
                                  </Stack>
                                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                                    {message.text || 'Без тексту'}
                                  </Typography>
                                  <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                                    {message.callsigns.join(' · ')}
                                  </Typography>
                                </Stack>
                              </Paper>
                            ))}
                            {selectedEdgeVisibleMessages.length === 0 ? (
                              <Typography variant="body2" sx={{ color: graphOverlayTextSecondary }}>
                                Немає перехоплень у поточних фільтрах
                              </Typography>
                            ) : null}
                          </Stack>
                        </Stack>
                      ) : selectedNode ? (
                        <Stack spacing={1.5}>
                          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Chip size="small" label={`Активність: ${selectedNode.activityCount}`} />
                            <Chip size="small" label={`Зв'язків: ${selectedNode.relationCount}`} />
                            {selectedNode.knownCallsignId ? <Chip size="small" label={`ID: ${selectedNode.knownCallsignId}`} /> : null}
                          </Stack>
                          <Divider sx={{ borderColor: graphOverlayBorder }} />
                          <Stack spacing={0.75}>
                            <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                              Хто говорив з цим позивним
                            </Typography>
                            {selectedNodeEdges.length === 0 ? (
                              <Typography variant="body2" sx={{ color: graphOverlayTextSecondary }}>
                                Немає зв'язків у поточних фільтрах
                              </Typography>
                            ) : (
                              selectedNodeEdges.map((edge) => {
                                const partner = edge.source === selectedNode.id ? edge.target : edge.source;
                                const topFreq = edge.visibleByFreq[0];
                                const visiblePreview = filterNetworkCallsignRelationEdgeMessages(edge)[0];
                                return (
                                  <Paper
                                    key={edge.id}
                                    variant="outlined"
                                    sx={{
                                      p: 1,
                                      bgcolor: 'rgba(255,255,255,0.02)',
                                      borderColor: relationsSelectedEdgeId === edge.id ? 'rgba(224, 162, 94, 0.9)' : graphOverlayBorder,
                                      cursor: 'pointer',
                                    }}
                                    onClick={() => onSelectEdgeId(edge.id)}
                                  >
                                    <Stack spacing={0.5}>
                                      <Stack direction="row" justifyContent="space-between" spacing={1}>
                                        <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                          {partner}
                                        </Typography>
                                        <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                                          {edge.visibleWeight}
                                        </Typography>
                                      </Stack>
                                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                                        {edge.visibleByFreq.slice(0, 3).map((item) => (
                                          <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: 'rgba(255,255,255,0.06)' }} />
                                        ))}
                                      </Stack>
                                      {topFreq && visiblePreview ? (
                                        <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }} noWrap title={visiblePreview.text ?? ''}>
                                          {visiblePreview.text || 'Без тексту'}
                                        </Typography>
                                      ) : null}
                                    </Stack>
                                  </Paper>
                                );
                              })
                            )}
                          </Stack>
                        </Stack>
                      ) : null}
                    </Box>
                  ) : null}
                </Box>

              </Stack>

              <svg
                ref={svgRef}
                role="img"
                aria-label="Граф зв'язків позивних"
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                preserveAspectRatio="xMidYMid meet"
                style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
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
                  if (!sourcePosition || !targetPosition || !edge.visibleByFreq.length) return null;
                  const selected = relationsSelectedEdgeId === edge.id;
                  const highlighted =
                    selected ||
                    (relationsSelectedNodeId !== null && (edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId));
                  const stroke = getEdgeStroke(edge, legendFreqs);
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
                      {relationsShowLabels && !denseGraph && isPointVisibleInViewBox(ctrlX, ctrlY, viewBox, 48) ? (
                          <text
                          x={ctrlX}
                          y={ctrlY - 8}
                          textAnchor="middle"
                          fill={isDarkMode ? 'rgba(255,255,255,0.62)' : '#111111'}
                          fontSize="14"
                          fontWeight="600"
                          style={{ pointerEvents: 'none' }}
                        >
                          {getEdgeLabel(edge)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                {graphView.nodes.map((node) => {
                  if (!visibleNodeIdsForRender.has(node.id)) return null;
                  const position = layout.positions.get(node.id);
                  if (!position || !node.visible) return null;
                  const selected = relationsSelectedNodeId === node.id;
                  const highlighted =
                    selected || (selectedNode !== null ? selectedNeighborIds.has(node.id) : node.matchedSearch);
                  const opacity = selectedNode !== null || selectedEdge !== null ? (highlighted ? 1 : 0.28) : node.matchedSearch ? 1 : 0.9;
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
                        fill={getNodeFill(node, selected, highlighted)}
                        stroke={stroke}
                        strokeWidth={selected ? 4 : 2}
                        filter={`url(#${headingId}-node-shadow)`}
                      />
                      {((relationsShowLabels && !denseGraph && isPointVisibleInViewBox(position.x, position.y, viewBox, radius * 3)) || selected || node.matchedSearch) && (
                        <text
                          x={position.x}
                          y={position.y + radius + 18}
                          textAnchor="middle"
                          fill={isDarkMode ? 'rgba(255,255,255,0.88)' : '#111111'}
                          fontSize="18"
                          fontWeight="700"
                          style={{ pointerEvents: 'none' }}
                        >
                          {node.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </>
          )}
        </Paper>
      </Stack>

      <Popover
        id={filterPopoverId}
        open={filterAnchorEl !== null}
        anchorEl={filterAnchorEl}
        onClose={() => setFilterAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              borderRadius: 2,
              overflow: 'hidden',
              bgcolor: graphOverlayBg,
              border: `1px solid ${graphOverlayBorder}`,
              boxShadow: graphOverlayShadow,
            },
          },
        }}
      >
        <Box sx={{ width: 320, p: 2, color: graphOverlayText }}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              Налаштування
            </Typography>
            <Stack spacing={0.75}>
              {legendFreqs.map((freq) => {
                const enabled = relationsEnabledFreqs.includes(freq.freq);
                return (
                  <FormControlLabel
                    key={freq.freq}
                    control={<Checkbox checked={enabled} onChange={(_, checked) => handleFilterToggle(freq.freq, checked)} />}
                    label={
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Box sx={{ width: 18, height: 3, borderRadius: 999, bgcolor: freq.color }} />
                        <span>{freq.freq}</span>
                      </Stack>
                    }
                    sx={{ m: 0 }}
                  />
                );
              })}
            </Stack>
            <Divider />
            <Stack spacing={0.5}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Інтенсивність
                </Typography>
                <Typography variant="caption" sx={{ color: graphOverlayTextSecondary }}>
                  {relationsMinIntensity}
                </Typography>
              </Stack>
              <Slider
                value={relationsMinIntensity}
                min={1}
                max={intensitySliderMax}
                step={1}
                track="normal"
                onChange={(_, value) => onMinIntensityChange(Array.isArray(value) ? value[0] ?? NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY : value)}
                sx={{
                  '& .MuiSlider-track': {
                    border: 'none',
                  },
                  '& .MuiSlider-rail': {
                    opacity: 0.38,
                  },
                  '& .MuiSlider-mark': {
                    display: 'none',
                  },
                }}
              />
            </Stack>
          </Stack>
        </Box>
      </Popover>
    </Box>
  );
}
