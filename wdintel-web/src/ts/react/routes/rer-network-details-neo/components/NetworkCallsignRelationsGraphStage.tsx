import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, Button, CircularProgress, IconButton, Paper, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import type { NetworkCallsignRelationMessage } from '../../../../../Bindings';

import { ELLIPSIS } from '../../../utils/misc';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../shared/empty-state-text';
import { NetworkCallsignRelationsGraphCanvas } from './NetworkCallsignRelationsGraphCanvas';
import { NetworkCallsignRelationsGraphDetails } from './NetworkCallsignRelationsGraphDetails';
import { getNetworkRelationsGraphTheme } from './network-relations-graph-theme';
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
  drilldownNode: NetworkCallsignRelationsNodeView | null;
  selectedNodeEdges: NetworkCallsignRelationsEdgeView[];
  selectedMessages: NetworkCallsignRelationMessage[];
  selectedMessagesLoading: boolean;
  selectedMessagesError: string | null;
  selectedNeighborIds: Set<string>;
  visibleEdgeIdsForRender: Set<string>;
  visibleNodeIdsForRender: Set<string>;
  relationsShowLabels: boolean;
  denseGraph: boolean;
  graphIsFilteredEmpty: boolean;
  relationsSearch: string;
  graphWarning: boolean;
  legendFreqs: NetworkCallsignRelationFreqView[];
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsLoading: boolean;
  onSearchChange: (value: string) => void;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onOpenNodeEdgeId: (edgeId: string) => void;
  onBackToNode: () => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
  handleZoom: (factor: number) => void;
  zoomInFactor: number;
  zoomOutFactor: number;
};

function getDefaultEnabledFreqs(legendFreqs: NetworkCallsignRelationFreqView[]): string[] {
  const enabledByDefaultFreqs = legendFreqs.filter((freq) => freq.enabledByDefault).map((freq) => freq.freq);
  return enabledByDefaultFreqs.length > 0 ? enabledByDefaultFreqs : legendFreqs.map((freq) => freq.freq);
}

function sameFreqs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;

  const rightFreqs = new Set(right);
  return left.every((freq) => rightFreqs.has(freq));
}

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
  drilldownNode,
  selectedNodeEdges,
  selectedMessages,
  selectedMessagesLoading,
  selectedMessagesError,
  selectedNeighborIds,
  visibleEdgeIdsForRender,
  visibleNodeIdsForRender,
  relationsShowLabels,
  denseGraph,
  graphIsFilteredEmpty,
  relationsSearch,
  graphWarning,
  legendFreqs,
  relationsEnabledFreqs,
  relationsMinIntensity,
  relationsLoading,
  onSearchChange,
  onEnabledFreqsChange,
  onMinIntensityChange,
  onSelectNodeId,
  onSelectEdgeId,
  onOpenNodeEdgeId,
  onBackToNode,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  handleZoom,
  zoomInFactor,
  zoomOutFactor,
}: Props) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const graphTheme = getNetworkRelationsGraphTheme(theme);
  const defaultEnabledFreqs = getDefaultEnabledFreqs(legendFreqs);
  const hasResettableGraphFilters =
    relationsSearch.trim() !== '' ||
    relationsMinIntensity !== NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY ||
    !sameFreqs(relationsEnabledFreqs, defaultEnabledFreqs);

  return (
    <Paper
      variant="outlined"
      sx={{
        minHeight: 0,
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 2,
        borderColor: graphTheme.frameBorder,
        bgcolor: graphTheme.frameBg,
        boxShadow: theme.palette.mode === 'dark' ? 'inset 0 1px 0 rgba(255,255,255,0.03)' : 'inset 0 1px 0 rgba(0,0,0,0.03)',
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `linear-gradient(${graphTheme.gridLine} 1px, transparent 1px), linear-gradient(90deg, ${graphTheme.gridLine} 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
          opacity: theme.palette.mode === 'dark' ? 0.5 : 0.38,
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
            bgcolor: graphTheme.zoomControlBg,
            border: `1px solid ${graphTheme.zoomControlBorder}`,
            boxShadow: theme.palette.mode === 'dark' ? '0 2px 10px rgba(0,0,0,0.22)' : '0 2px 10px rgba(0,0,0,0.12)',
            '& .MuiIconButton-root + .MuiIconButton-root': {
              borderLeft: `1px solid ${graphTheme.zoomControlBorder}`,
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
              color: graphTheme.zoomControlText,
              flex: '0 0 44px',
              minWidth: 44,
              bgcolor: 'transparent',
              '&:hover': {
                bgcolor: graphTheme.zoomControlHoverBg,
                color: graphTheme.zoomControlText,
              },
              '&:focus-visible': {
                outline: `2px solid ${alpha(theme.palette.primary.main, 0.75)}`,
                outlineOffset: -3,
              },
              '&:active': {
                bgcolor: graphTheme.zoomControlHoverBg,
                color: graphTheme.zoomControlText,
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
              color: graphTheme.zoomControlText,
              flex: '0 0 44px',
              minWidth: 44,
              bgcolor: 'transparent',
              '&:hover': {
                bgcolor: graphTheme.zoomControlHoverBg,
                color: graphTheme.zoomControlText,
              },
              '&:focus-visible': {
                outline: `2px solid ${alpha(theme.palette.primary.main, 0.75)}`,
                outlineOffset: -3,
              },
              '&:active': {
                bgcolor: graphTheme.zoomControlHoverBg,
                color: graphTheme.zoomControlText,
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

      {graphWarning ? (
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
          <Stack spacing={1} alignItems="center">
            <Typography variant="h6" sx={{ color: graphTheme.overlayText }}>
              Забагато зв'язків для відображення
            </Typography>
            <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary, maxWidth: 480 }}>
              Збільшіть інтенсивність, звузьте період або вимкніть частоти.
            </Typography>
          </Stack>
        </Box>
      ) : graphIsFilteredEmpty ? (
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
            <Typography variant="body1" sx={{ color: graphTheme.overlayTextSecondary }}>
              {EMPTY_STATE_NO_RESULTS_TEXT}
            </Typography>
            {hasResettableGraphFilters ? (
              <Button
                variant="text"
                onClick={() => {
                  onSearchChange('');
                  onEnabledFreqsChange(defaultEnabledFreqs);
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
            ) : null}
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
              bgcolor: graphTheme.overlayBg,
              border: `1px solid ${graphTheme.overlayBorder}`,
              color: graphTheme.overlayText,
            }}
          >
            <Stack spacing={0.5}>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
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
              bgcolor: graphTheme.overlayBg,
              border: `1px solid ${graphTheme.overlayBorder}`,
              color: graphTheme.overlayText,
            }}
          >
            <Typography variant="overline" sx={{ color: graphTheme.overlayTextSecondary, letterSpacing: 1 }}>
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
            drilldownNode={drilldownNode}
            selectedNodeEdges={selectedNodeEdges}
            selectedMessages={selectedMessages}
            selectedMessagesLoading={selectedMessagesLoading}
            selectedMessagesError={selectedMessagesError}
            selectedEdgeId={selectedEdgeId}
            onBackToNode={onBackToNode}
            onSelectNodeId={onSelectNodeId}
            onSelectEdgeId={onSelectEdgeId}
            onOpenNodeEdgeId={onOpenNodeEdgeId}
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

      {relationsLoading ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            display: 'grid',
            placeItems: 'center',
            bgcolor: alpha(theme.palette.background.default, isDarkMode ? 0.78 : 0.58),
            backdropFilter: 'blur(2px)',
          }}
        >
          <Stack spacing={1.5} alignItems="center" sx={{ color: graphTheme.overlayText }}>
            <CircularProgress size={28} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {`Оновлюємо граф зв'язків${ELLIPSIS}`}
            </Typography>
          </Stack>
        </Box>
      ) : null}
    </Paper>
  );
}
