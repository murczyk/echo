import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import { Box, FormControlLabel, IconButton, InputAdornment, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import { APP_DATETIME_INPUT_MIN } from '../../../utils/misc';
import { NetworkDatePickerField } from './NetworkDatePickerField';
import { NetworkCallsignRelationsGraphFilters } from './NetworkCallsignRelationsGraphFilters';
import { NetworkCallsignRelationsGraphStage } from './NetworkCallsignRelationsGraphStage';
import {
  buildRelationNeighborIds,
  buildNetworkCallsignRelationsGraphView,
  buildRenderableNetworkCallsignRelationsGraphView,
  createRelationGraphLayout,
  filterNetworkCallsignRelationEdgeMessages,
  getRelationEdgeBounds,
  NETWORK_RELATIONS_MAX_RENDER_EDGES,
  NETWORK_RELATIONS_MAX_RENDER_NODES,
  intersectsRelationViewBox,
  isPointVisibleInRelationViewBox,
  moveRelationGraphViewBox,
  type RelationGraphViewBox,
  zoomRelationGraphViewBox,
} from '../network-relations';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';

type Props = {
  relations: NetworkCallsignRelationsRsp;
  relationsSearch: string;
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsShowLabels: boolean;
  relationsSelectedNodeId: string | null;
  relationsSelectedEdgeId: string | null;
  relationsSince: string;
  relationsTill: string;
  onSearchChange: (value: string) => void;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onShowLabelsChange: (value: boolean) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onRelationsSinceChange: (value: string) => void;
  onRelationsTillChange: (value: string) => void;
};

const GRAPH_WHEEL_ZOOM_IN_FACTOR = 0.88;
const GRAPH_WHEEL_ZOOM_OUT_FACTOR = 1.14;

export function NetworkCallsignRelationsGraph({
  relations,
  relationsSearch,
  relationsEnabledFreqs,
  relationsMinIntensity,
  relationsShowLabels,
  relationsSelectedNodeId,
  relationsSelectedEdgeId,
  relationsSince,
  relationsTill,
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
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ x: number; y: number; viewBox: RelationGraphViewBox } | null>(null);
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [viewBox, setViewBox] = useState<RelationGraphViewBox>({ x: -450, y: -450, width: 900, height: 900 });
  const labelsAutoDisabledRef = useRef(false);

  const graphView = useMemo(
    () => buildNetworkCallsignRelationsGraphView(relations, relationsSearch, relationsEnabledFreqs, relationsMinIntensity),
    [relations, relationsEnabledFreqs, relationsMinIntensity, relationsSearch],
  );
  const visibleNodes = useMemo(() => graphView.nodes.filter((node) => node.visible), [graphView.nodes]);
  const graphTooDense = visibleNodes.length > NETWORK_RELATIONS_MAX_RENDER_NODES || graphView.edges.length > NETWORK_RELATIONS_MAX_RENDER_EDGES;
  const renderGraphView = useMemo(
    () =>
      graphTooDense
        ? buildRenderableNetworkCallsignRelationsGraphView(graphView, visibleNodes)
        : { ...graphView, nodes: visibleNodes, edges: graphView.edges, warning: false },
    [graphTooDense, graphView, visibleNodes],
  );
  const layout = useMemo(
    () => (renderGraphView.warning ? createRelationGraphLayout([], []) : createRelationGraphLayout(renderGraphView.nodes, renderGraphView.edges)),
    [renderGraphView],
  );
  const selectedNode = useMemo(
    () => renderGraphView.nodes.find((node) => node.id === relationsSelectedNodeId) ?? null,
    [renderGraphView.nodes, relationsSelectedNodeId],
  );
  const selectedEdge = useMemo(
    () => renderGraphView.edges.find((edge) => edge.id === relationsSelectedEdgeId) ?? null,
    [renderGraphView.edges, relationsSelectedEdgeId],
  );
  const selectedEdgeVisibleMessages = useMemo(() => filterNetworkCallsignRelationEdgeMessages(selectedEdge), [selectedEdge]);
  const selectedNodeEdges = useMemo(
    () => renderGraphView.edges.filter((edge) => edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId),
    [renderGraphView.edges, relationsSelectedNodeId],
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
    if (selectedEdge) return buildRelationNeighborIds(selectedEdge);
    return new Set<string>();
  }, [selectedEdge, selectedNode, selectedNodeEdges]);

  const graphCounts = useMemo(
    () => ({
      nodes: visibleNodes.length,
      edges: graphView.edges.length,
    }),
    [graphView.edges.length, visibleNodes.length],
  );
  const displayGraphCounts = renderGraphView.warning
    ? graphCounts
    : {
        nodes: renderGraphView.nodes.length,
        edges: renderGraphView.edges.length,
      };
  const graphSubsetHintVisible = graphTooDense && !renderGraphView.warning;
  const summaryEdges = renderGraphView.warning ? graphView.edges : renderGraphView.edges;
  const hasRenderableGraph = renderGraphView.nodes.length > 0 && renderGraphView.edges.length > 0;
  const totalIntensity = summaryEdges.reduce((total, edge) => total + edge.visibleWeight, 0);
  const maxIntensity = Math.max(1, ...summaryEdges.map((edge) => edge.visibleWeight));
  const intensitySliderMax = Math.max(maxIntensity, NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY);
  const legendFreqs = graphView.freqs;
  const denseGraph = renderGraphView.nodes.length > 40 || renderGraphView.edges.length > 90 || viewBox.width > layout.bounds.width * 1.6;
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
  const visibleEdgeIdsForRender = useMemo(() => {
    if (!hasRenderableGraph) return new Set<string>();
    const ids = new Set<string>();
    for (const edge of renderGraphView.edges) {
      const bounds = getRelationEdgeBounds(edge, layout.positions);
      const isSelected = relationsSelectedEdgeId === edge.id;
      const touchesSelectedNode = relationsSelectedNodeId !== null && (edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId);
      if (isSelected || touchesSelectedNode || intersectsRelationViewBox(bounds, viewBox, 180)) {
        ids.add(edge.id);
      }
    }
    return ids;
  }, [hasRenderableGraph, layout.positions, relationsSelectedEdgeId, relationsSelectedNodeId, renderGraphView.edges, viewBox]);
  const visibleNodeIdsForRender = useMemo(() => {
    if (!hasRenderableGraph) return new Set<string>();
    const ids = new Set<string>();
    for (const node of renderGraphView.nodes) {
      if (!node.visible) continue;
      const position = layout.positions.get(node.id);
      if (!position) continue;
      const selected = relationsSelectedNodeId === node.id;
      const matched = node.matchedSearch;
      const connectedToSelected = selectedEdge !== null && (selectedEdge.source === node.id || selectedEdge.target === node.id);
      const shouldRender = selected || matched || connectedToSelected;
      if (shouldRender || isPointVisibleInRelationViewBox(position.x, position.y, viewBox, 240)) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [hasRenderableGraph, layout.positions, relationsSelectedNodeId, renderGraphView.nodes, selectedEdge, viewBox]);

  useEffect(() => {
    setViewBox(layout.bounds);
  }, [layout.bounds]);

  useEffect(() => {
    if (relationsShowLabels && (denseGraph || renderGraphView.warning)) {
      labelsAutoDisabledRef.current = true;
      onShowLabelsChange(false);
      return;
    }

    if (!relationsShowLabels && labelsAutoDisabledRef.current && !denseGraph && !renderGraphView.warning) {
      labelsAutoDisabledRef.current = false;
      onShowLabelsChange(true);
    }
  }, [denseGraph, onShowLabelsChange, relationsShowLabels, renderGraphView.warning]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !hasRenderableGraph) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? GRAPH_WHEEL_ZOOM_OUT_FACTOR : GRAPH_WHEEL_ZOOM_IN_FACTOR;
      setViewBox((current) => zoomRelationGraphViewBox(current, factor));
    };

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', handleWheel);
    };
  }, [hasRenderableGraph]);

  const handleZoom = (factor: number) => {
    setViewBox((current) => zoomRelationGraphViewBox(current, factor));
  };

  const handleFilterToggle = (freq: string, checked: boolean) => {
    const nextFreqs = checked ? [...new Set([...relationsEnabledFreqs, freq])] : relationsEnabledFreqs.filter((item) => item !== freq);
    onEnabledFreqsChange(nextFreqs);
  };

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
    setViewBox(moveRelationGraphViewBox(drag.viewBox, event.clientX - drag.x, event.clientY - drag.y, viewport.width, viewport.height));
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

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right' }}>
            {displayGraphCounts.nodes} вузлів · {displayGraphCounts.edges} зв'язків · {totalIntensity} перехоплень
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

          <Box
            sx={{
              flexShrink: 0,
              minWidth: 0,
              maxWidth: { xs: 180, sm: 240, md: 320 },
              textAlign: 'right',
            }}
          >
            {graphSubsetHintVisible ? (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', lineHeight: 1.35 }}>
                Показано лише найсильніші зв&apos;язки для швидкодії
              </Typography>
            ) : null}
          </Box>
        </Stack>

        <NetworkCallsignRelationsGraphStage
          headingId={headingId}
          filterButtonId={filterButtonId}
          filterPopoverId={filterPopoverId}
          filterAnchorEl={filterAnchorEl}
          svgRef={svgRef}
          graphView={renderGraphView}
          layout={layout}
          viewBox={viewBox}
          selectedNodeId={relationsSelectedNodeId}
          selectedEdgeId={relationsSelectedEdgeId}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          selectedEdgeVisibleMessages={selectedEdgeVisibleMessages}
          selectedNodeEdges={selectedNodeEdges}
          selectedNeighborIds={selectedNeighborIds}
          visibleEdgeIdsForRender={visibleEdgeIdsForRender}
          visibleNodeIdsForRender={visibleNodeIdsForRender}
          relationsShowLabels={relationsShowLabels}
          denseGraph={denseGraph}
          graphIsFilteredEmpty={!hasRenderableGraph}
          graphWarning={renderGraphView.warning}
          legendFreqs={legendFreqs}
          relationsEnabledFreqs={relationsEnabledFreqs}
          relationsMinIntensity={relationsMinIntensity}
          onEnabledFreqsChange={onEnabledFreqsChange}
          onMinIntensityChange={onMinIntensityChange}
          onOpenFilters={(anchorEl) => setFilterAnchorEl(anchorEl)}
          onSelectNodeId={onSelectNodeId}
          onSelectEdgeId={onSelectEdgeId}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          handleZoom={handleZoom}
          zoomInFactor={GRAPH_WHEEL_ZOOM_IN_FACTOR}
          zoomOutFactor={GRAPH_WHEEL_ZOOM_OUT_FACTOR}
        />
      </Stack>

      <NetworkCallsignRelationsGraphFilters
        anchorEl={filterAnchorEl}
        popoverId={filterPopoverId}
        legendFreqs={legendFreqs}
        enabledFreqs={relationsEnabledFreqs}
        minIntensity={relationsMinIntensity}
        intensitySliderMax={intensitySliderMax}
        onClose={() => setFilterAnchorEl(null)}
        onEnabledFreqToggle={handleFilterToggle}
        onMinIntensityChange={onMinIntensityChange}
      />
    </Box>
  );
}
