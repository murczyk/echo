import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import { Box, Button, FormControlLabel, IconButton, InputAdornment, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import dayjs from 'dayjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { NetworkCallsignRelationMessage, NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import { APP_DATETIME_INPUT_MIN, parseDateInputExclusiveEndInTimeZone, parseDateInputInTimeZone } from '../../../utils/misc';
import { formatErrorMessage } from '../use-rer-network-details-neo-page.helpers';
import { NetworkDatePickerField } from './NetworkDatePickerField';
import { NetworkCallsignRelationsGraphFilters } from './NetworkCallsignRelationsGraphFilters';
import { NetworkCallsignRelationsGraphStage } from './NetworkCallsignRelationsGraphStage';
import { NetworkCallsignRelationsIntensityPopover } from './NetworkCallsignRelationsIntensityPopover';
import { getNetworkCallsignRelationMessages } from '../../../services/api/networks';
import {
  buildRelationNeighborIds,
  buildNetworkCallsignRelationsGraphView,
  buildRenderableNetworkCallsignRelationsGraphView,
  createRelationGraphLayout,
  getRelationEdgeBounds,
  NETWORK_RELATIONS_RENDER_LIMITS,
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
  networkId: number | null;
  relationsLoading: boolean;
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
  networkId,
  relationsLoading,
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
  const labelsAutoDisabledRef = useRef(false);
  const [filterAnchorEl, setFilterAnchorEl] = useState<HTMLElement | null>(null);
  const [intensityAnchorEl, setIntensityAnchorEl] = useState<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewBox, setViewBox] = useState<RelationGraphViewBox>({ x: -450, y: -450, width: 900, height: 900 });
  const [selectedMessages, setSelectedMessages] = useState<NetworkCallsignRelationMessage[]>([]);
  const [selectedMessagesLoading, setSelectedMessagesLoading] = useState(false);
  const [selectedMessagesError, setSelectedMessagesError] = useState<string | null>(null);
  const [edgeDrilldownNodeId, setEdgeDrilldownNodeId] = useState<string | null>(null);

  const graphView = useMemo(
    () => buildNetworkCallsignRelationsGraphView(relations, relationsSearch, relationsEnabledFreqs, relationsMinIntensity),
    [relations, relationsEnabledFreqs, relationsMinIntensity, relationsSearch],
  );
  const visibleNodes = useMemo(() => graphView.nodes.filter((node) => node.visible), [graphView.nodes]);
  const graphTooDense =
    visibleNodes.length > NETWORK_RELATIONS_RENDER_LIMITS.maxRenderNodes || graphView.edges.length > NETWORK_RELATIONS_RENDER_LIMITS.maxRenderEdges;
  const renderGraphView = useMemo(
    () =>
      graphTooDense
        ? buildRenderableNetworkCallsignRelationsGraphView(graphView, visibleNodes, NETWORK_RELATIONS_RENDER_LIMITS)
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
  const drilldownNode = useMemo(
    () => (relationsSelectedEdgeId !== null && edgeDrilldownNodeId !== null ? graphView.nodes.find((node) => node.id === edgeDrilldownNodeId) ?? null : null),
    [edgeDrilldownNodeId, graphView.nodes, relationsSelectedEdgeId],
  );
  const selectedEdge = useMemo(
    () => renderGraphView.edges.find((edge) => edge.id === relationsSelectedEdgeId) ?? null,
    [renderGraphView.edges, relationsSelectedEdgeId],
  );
  const selectedNodeEdges = useMemo(
    () => renderGraphView.edges.filter((edge) => edge.source === relationsSelectedNodeId || edge.target === relationsSelectedNodeId),
    [renderGraphView.edges, relationsSelectedNodeId],
  );
  const selectedMessageSelection = useMemo(() => {
    if (relationsSelectedNodeId !== null && selectedNode !== null) {
      return { callsign: selectedNode.id, source: null, target: null };
    }
    if (relationsSelectedEdgeId !== null && selectedEdge !== null) {
      return { callsign: null, source: selectedEdge.source, target: selectedEdge.target };
    }
    return null;
  }, [relationsSelectedEdgeId, relationsSelectedNodeId, selectedEdge?.source, selectedEdge?.target, selectedNode?.id]);
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
  const summaryEdges = renderGraphView.warning ? graphView.edges : renderGraphView.edges;
  const hasRenderableGraph = renderGraphView.nodes.length > 0 && renderGraphView.edges.length > 0;
  const totalIntensity = summaryEdges.reduce((total, edge) => total + edge.visibleWeight, 0);
  const maxIntensity = Math.max(1, ...summaryEdges.map((edge) => edge.visibleWeight));
  const intensitySliderMax = Math.max(maxIntensity, NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY);
  const legendFreqs = graphView.freqs;
  const denseGraph = renderGraphView.nodes.length > 40 || renderGraphView.edges.length > 90 || viewBox.width > layout.bounds.width * 1.6;
  const graphLabelsHintVisible = denseGraph && !renderGraphView.warning;
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

  useEffect(() => {
    const selection = selectedMessageSelection;
    const sinceDateInclusiveMs = parseDateInputInTimeZone(relationsSince);
    const tillDateNoninclusiveMs = parseDateInputExclusiveEndInTimeZone(relationsTill);

    if (networkId === null || selection === null || sinceDateInclusiveMs === null || tillDateNoninclusiveMs === null) {
      setSelectedMessages([]);
      setSelectedMessagesLoading(false);
      setSelectedMessagesError(null);
      return;
    }

    const controller = new AbortController();
    setSelectedMessages([]);
    setSelectedMessagesLoading(true);
    setSelectedMessagesError(null);

    void (async () => {
      try {
        const response = await getNetworkCallsignRelationMessages(
          {
            networkId,
            sinceDateInclusiveMs,
            tillDateNoninclusiveMs,
            callsign: selection.callsign,
            source: selection.source,
            target: selection.target,
            freqs: relationsEnabledFreqs,
            limit: 24,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setSelectedMessages(response.messages ?? []);
        setSelectedMessagesLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSelectedMessages([]);
        setSelectedMessagesLoading(false);
        setSelectedMessagesError(formatErrorMessage(error));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    networkId,
    relationsEnabledFreqs,
    relationsSince,
    relationsTill,
    selectedMessageSelection?.callsign,
    selectedMessageSelection?.source,
    selectedMessageSelection?.target,
  ]);
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
    if (relationsShowLabels && (renderGraphView.warning || denseGraph)) {
      labelsAutoDisabledRef.current = true;
      onShowLabelsChange(false);
      return;
    }

    if (!relationsShowLabels && labelsAutoDisabledRef.current && !renderGraphView.warning && !denseGraph) {
      labelsAutoDisabledRef.current = false;
      onShowLabelsChange(true);
    }
  }, [denseGraph, onShowLabelsChange, relationsShowLabels, renderGraphView.warning]);

  const handleZoom = (factor: number) => {
    setViewBox((current) => zoomRelationGraphViewBox(current, factor));
  };

  const handleFilterToggle = (freq: string, checked: boolean) => {
    const nextFreqs = checked ? [...new Set([...relationsEnabledFreqs, freq])] : relationsEnabledFreqs.filter((item) => item !== freq);
    onEnabledFreqsChange(nextFreqs);
  };

  const handleOpenIntensitySettings = (anchorEl: HTMLElement) => {
    setIntensityAnchorEl(anchorEl);
  };

  const handleCloseIntensitySettings = () => {
    setIntensityAnchorEl(null);
  };

  const handleFullscreenChange = (value: boolean) => {
    setIsFullscreen(value);
  };

  const handleSelectNodeId = (nodeId: string | null) => {
    setEdgeDrilldownNodeId(null);
    onSelectNodeId(nodeId);
  };

  const handleSelectEdgeId = (edgeId: string | null) => {
    setEdgeDrilldownNodeId(null);
    onSelectEdgeId(edgeId);
  };

  const handleOpenNodeEdgeId = (edgeId: string) => {
    if (selectedNode) {
      setEdgeDrilldownNodeId(selectedNode.id);
    }
    onSelectEdgeId(edgeId);
  };

  const handleBackToNode = () => {
    if (edgeDrilldownNodeId === null) {
      onSelectEdgeId(null);
      return;
    }
    const nodeId = edgeDrilldownNodeId;
    setEdgeDrilldownNodeId(null);
    onSelectNodeId(nodeId);
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

  const handleWheel = (event: WheelEvent) => {
    if (!hasRenderableGraph) return;
    event.preventDefault();
    const factor = event.deltaY > 0 ? GRAPH_WHEEL_ZOOM_OUT_FACTOR : GRAPH_WHEEL_ZOOM_IN_FACTOR;
    setViewBox((current) => zoomRelationGraphViewBox(current, factor));
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
          <Stack direction="row" alignItems="center" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
            <TextField
              size="small"
              value={relationsSearch}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Пошук"
              sx={{
                width: { xs: 180, sm: 220 },
                flexShrink: 0,
                '& .MuiOutlinedInput-root': {
                  height: 40,
                  minHeight: 40,
                  backgroundColor: 'transparent',
                  '& .MuiInputBase-input': {
                    fontSize: '0.875rem',
                    lineHeight: '20px',
                    boxSizing: 'border-box',
                    padding: '9px 8px 9px 0 !important',
                  },
                },
              }}
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
            <Stack direction="row" alignItems="center" spacing={2} sx={{ flexShrink: 0 }}>
              <FormControlLabel
                control={<Switch checked={relationsShowLabels} onChange={(_, checked) => onShowLabelsChange(checked)} disabled={renderGraphView.warning || denseGraph} />}
                label="Підписи"
                sx={{ m: 0, flexShrink: 0 }}
              />
              {graphLabelsHintVisible ? (
                <Tooltip title="Підписи приховано для збереження швидкодії. Звузьте період або підніміть інтенсивність.">
                  <IconButton
                    aria-label="Пояснення про підписи"
                    size="small"
                    sx={{
                      color: 'text.secondary',
                      width: 20,
                      height: 20,
                      ml: -0.25,
                      '&:hover': {
                        bgcolor: 'transparent',
                        color: 'text.primary',
                      },
                    }}
                  >
                    <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              ) : null}
              <Button
                id={filterButtonId}
                type="button"
                variant="outlined"
                onClick={(event) => setFilterAnchorEl(event.currentTarget)}
                startIcon={<TuneOutlinedIcon />}
                sx={{ borderRadius: 2, px: 1.6, py: 0.8, minWidth: 0, height: 40, textTransform: 'none', fontWeight: 700 }}
              >
                Частоти
              </Button>
            </Stack>
          </Stack>
        </Stack>

        <NetworkCallsignRelationsGraphStage
          headingId={headingId}
          svgRef={svgRef}
          graphView={renderGraphView}
          layout={layout}
          viewBox={viewBox}
          selectedNodeId={relationsSelectedNodeId}
          selectedEdgeId={relationsSelectedEdgeId}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          drilldownNode={drilldownNode}
          selectedNodeEdges={selectedNodeEdges}
          selectedMessages={selectedMessages}
          selectedMessagesLoading={selectedMessagesLoading}
          selectedMessagesError={selectedMessagesError}
          selectedNeighborIds={selectedNeighborIds}
          visibleEdgeIdsForRender={visibleEdgeIdsForRender}
          visibleNodeIdsForRender={visibleNodeIdsForRender}
          relationsShowLabels={relationsShowLabels}
          denseGraph={denseGraph}
          graphIsFilteredEmpty={!hasRenderableGraph}
          relationsSearch={relationsSearch}
          graphWarning={renderGraphView.warning}
          legendFreqs={legendFreqs}
          relationsEnabledFreqs={relationsEnabledFreqs}
          relationsMinIntensity={relationsMinIntensity}
          intensityAnchorEl={intensityAnchorEl}
          onSearchChange={onSearchChange}
          onEnabledFreqsChange={onEnabledFreqsChange}
          onMinIntensityChange={onMinIntensityChange}
          onOpenIntensitySettings={handleOpenIntensitySettings}
          relationsLoading={relationsLoading}
          onSelectNodeId={handleSelectNodeId}
          onSelectEdgeId={handleSelectEdgeId}
          onOpenNodeEdgeId={handleOpenNodeEdgeId}
          onBackToNode={handleBackToNode}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          onFullscreenChange={handleFullscreenChange}
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
        isFullscreen={isFullscreen}
        onClose={() => setFilterAnchorEl(null)}
        onEnabledFreqToggle={handleFilterToggle}
      />

      <NetworkCallsignRelationsIntensityPopover
        anchorEl={intensityAnchorEl}
        popoverId={`${headingId}-intensity-popover`}
        minIntensity={relationsMinIntensity}
        intensitySliderMax={intensitySliderMax}
        isFullscreen={isFullscreen}
        onClose={handleCloseIntensitySettings}
        onMinIntensityChange={onMinIntensityChange}
      />
    </Box>
  );
}
