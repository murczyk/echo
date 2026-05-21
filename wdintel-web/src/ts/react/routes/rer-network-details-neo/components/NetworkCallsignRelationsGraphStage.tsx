import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, Button, IconButton, Paper, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';

import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../shared/empty-state-text';
import { NetworkCallsignRelationsGraphCanvas } from './NetworkCallsignRelationsGraphCanvas';
import { NetworkCallsignRelationsGraphDetails } from './NetworkCallsignRelationsGraphDetails';
import type {
  NetworkCallsignRelationFreqView,
  NetworkCallsignRelationsEdgeView,
  NetworkCallsignRelationsGraphView,
  NetworkCallsignRelationsNodeView,
  RelationGraphLayout,
  RelationGraphViewBox,
} from '../network-relations';

type Props = {
  headingId: string;
  svgRef: MutableRefObject<SVGSVGElement | null>;
  graphView: NetworkCallsignRelationsGraphView;
  layout: RelationGraphLayout;
  viewBox: RelationGraphViewBox;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedNode: NetworkCallsignRelationsNodeView | null;
  selectedEdge: NetworkCallsignRelationsEdgeView | null;
  selectedEdgeVisibleMessages: Array<{ id: number; timestamp: number | null; freq: string | null; text: string; callsigns: string[] }>;
  selectedNodeEdges: NetworkCallsignRelationsEdgeView[];
  selectedNeighborIds: Set<string>;
  visibleEdgeIdsForRender: Set<string>;
  visibleNodeIdsForRender: Set<string>;
  relationsShowLabels: boolean;
  denseGraph: boolean;
  graphIsFilteredEmpty: boolean;
  legendFreqs: NetworkCallsignRelationFreqView[];
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
  handleZoom: (factor: number) => void;
  zoomInFactor: number;
  zoomOutFactor: number;
};

export function NetworkCallsignRelationsGraphStage({
  headingId,
  svgRef,
  graphView,
  layout,
  viewBox,
  selectedNodeId,
  selectedEdgeId,
  selectedNode,
  selectedEdge,
  selectedEdgeVisibleMessages,
  selectedNodeEdges,
  selectedNeighborIds,
  visibleEdgeIdsForRender,
  visibleNodeIdsForRender,
  relationsShowLabels,
  denseGraph,
  graphIsFilteredEmpty,
  legendFreqs,
  relationsEnabledFreqs,
  relationsMinIntensity,
  onEnabledFreqsChange,
  onMinIntensityChange,
  onSelectNodeId,
  onSelectEdgeId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  handleZoom,
  zoomInFactor,
  zoomOutFactor,
}: Props) {
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

  return (
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
          backgroundImage: `linear-gradient(${graphGridLine} 1px, transparent 1px), linear-gradient(90deg, ${graphGridLine} 1px, transparent 1px)`,
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
            onClick={() => handleZoom(zoomInFactor)}
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
            onClick={() => handleZoom(zoomOutFactor)}
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

          <NetworkCallsignRelationsGraphDetails
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            selectedEdgeVisibleMessages={selectedEdgeVisibleMessages}
            selectedNodeEdges={selectedNodeEdges}
            selectedEdgeId={selectedEdgeId}
            overlayBorder={graphOverlayBorder}
            overlayTextSecondary={graphOverlayTextSecondary}
            onSelectNodeId={onSelectNodeId}
            onSelectEdgeId={onSelectEdgeId}
          />

          <NetworkCallsignRelationsGraphCanvas
            svgRef={svgRef}
            headingId={headingId}
            graphView={graphView}
            layout={layout}
            viewBox={viewBox}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            selectedNeighborIds={selectedNeighborIds}
            relationsShowLabels={relationsShowLabels}
            denseGraph={denseGraph}
            isDarkMode={isDarkMode}
            legendFreqs={legendFreqs}
            visibleEdgeIdsForRender={visibleEdgeIdsForRender}
            visibleNodeIdsForRender={visibleNodeIdsForRender}
            onSelectNodeId={onSelectNodeId}
            onSelectEdgeId={onSelectEdgeId}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </>
      )}
    </Paper>
  );
}
