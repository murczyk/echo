import AddIcon from '@mui/icons-material/Add';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { NetworkCallsignRelationMessage } from '../../../../../Bindings';

import { ELLIPSIS } from '../../../utils/misc';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';
import { NetworkCallsignRelationsGraphCanvas } from './NetworkCallsignRelationsGraphCanvas';
import { NetworkCallsignRelationsGraphDetails } from './NetworkCallsignRelationsGraphDetails';
import {
  NETWORK_RELATIONS_FULLSCREEN_Z_INDEX,
  getNetworkRelationsGraphTheme,
} from './network-relations-graph-theme';
import type {
  NetworkCallsignRelationFreqView,
  NetworkCallsignRelationsEdgeView,
  NetworkCallsignRelationsGraphView,
  NetworkCallsignRelationsNodeView,
  NetworkCallsignRelationFreqState,
  RelationGraphLayout,
  RelationGraphViewBox,
} from '../network-relations';

type Props = {
  headingId: string;
  svgRef: MutableRefObject<SVGSVGElement | null>;
  graphView: NetworkCallsignRelationsGraphView;
  layout: RelationGraphLayout;
  viewBox: RelationGraphViewBox;
  graphNodeCount: number;
  graphEdgeCount: number;
  onReload: () => void;
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
  relationFreqState: NetworkCallsignRelationFreqState;
  relationsMinIntensity: number;
  relationsLoading: boolean;
  intensityAnchorEl: HTMLElement | null;
  filterPopoverId: string;
  onSearchChange: (value: string) => void;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onOpenIntensitySettings: (anchorEl: HTMLElement) => void;
  onOpenFrequencySettings: (anchorEl: HTMLElement) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onOpenNodeEdgeId: (edgeId: string) => void;
  onBackToNode: () => void;
  onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
  onWheel: (event: WheelEvent) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  handleZoom: (factor: number) => void;
  zoomInFactor: number;
  zoomOutFactor: number;
};

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
  graphNodeCount,
  graphEdgeCount,
  onReload,
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
  relationFreqState,
  relationsMinIntensity,
  relationsLoading,
  intensityAnchorEl,
  filterPopoverId,
  onSearchChange,
  onEnabledFreqsChange,
  onMinIntensityChange,
  onOpenIntensitySettings,
  onOpenFrequencySettings,
  onSelectNodeId,
  onSelectEdgeId,
  onOpenNodeEdgeId,
  onBackToNode,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  onFullscreenChange,
  handleZoom,
  zoomInFactor,
  zoomOutFactor,
}: Props) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const graphTheme = getNetworkRelationsGraphTheme(theme);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { defaultEnabledFreqs, resolvedEnabledFreqs } = relationFreqState;
  const hasResettableGraphFilters =
    relationsSearch.trim() !== '' ||
    relationsMinIntensity !== NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY ||
    !sameFreqs(resolvedEnabledFreqs, defaultEnabledFreqs);
  const graphHasNoData = graphNodeCount === 0 && graphEdgeCount === 0;
  const graphHasNodesButNoEdges = graphNodeCount > 0 && graphEdgeCount === 0;
  const graphFilteredEmpty =
    graphIsFilteredEmpty && !graphWarning && !graphHasNoData && !graphHasNodesButNoEdges;

  useEffect(() => {
    document.body.classList.toggle('small-map-fullscreen-open', isFullscreen);
    onFullscreenChange?.(isFullscreen);
    return () => {
      document.body.classList.remove('small-map-fullscreen-open');
    };
  }, [isFullscreen, onFullscreenChange]);

  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  const handleSelectNodeId = (nodeId: string | null) => {
    onSelectNodeId(nodeId);
  };

  const handleSelectEdgeId = (edgeId: string | null) => {
    onSelectEdgeId(edgeId);
  };

  const handleOpenNodeEdgeId = (edgeId: string) => {
    onOpenNodeEdgeId(edgeId);
  };

  const handleBackToNode = () => {
    onBackToNode();
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    onPointerDown(event);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    onPointerMove(event);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    onPointerUp(event);
  };

  const stagePanel = (
    <Paper
      component="section"
      variant="outlined"
      sx={{
        minHeight: 0,
        minWidth: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        position: isFullscreen ? 'fixed' : 'relative',
        inset: isFullscreen ? 0 : undefined,
        overflow: 'hidden',
        borderRadius: isFullscreen ? 0 : 2,
        borderColor: graphTheme.frameBorder,
        bgcolor: graphTheme.frameBg,
        boxShadow: isFullscreen
          ? 'none'
          : theme.palette.mode === 'dark'
            ? 'inset 0 1px 0 rgba(255,255,255,0.03)'
            : 'inset 0 1px 0 rgba(0,0,0,0.03)',
        zIndex: isFullscreen ? NETWORK_RELATIONS_FULLSCREEN_Z_INDEX : 'auto',
        maxWidth: isFullscreen ? '100vw' : '100%',
        maxHeight: isFullscreen ? '100svh' : '100%',
        m: isFullscreen ? 0 : undefined,
        p: isFullscreen ? 0 : undefined,
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
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 2px 10px rgba(0,0,0,0.22)'
                : '0 2px 10px rgba(0,0,0,0.12)',
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
          <IconButton
            onClick={() => setIsFullscreen((current) => !current)}
            aria-label={isFullscreen ? 'Згорнути граф' : 'Розгорнути граф'}
            title={isFullscreen ? 'Згорнути граф' : 'Розгорнути граф'}
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
              '& i': {
                color: 'inherit',
                fontSize: 18,
                lineHeight: 1,
              },
            }}
          >
            <Box
              component="i"
              className={isFullscreen ? 'bi bi-fullscreen-exit' : 'bi bi-arrows-fullscreen'}
              aria-hidden="true"
            />
          </IconButton>
          {isFullscreen ? (
            <IconButton
              onClick={(event) => onOpenFrequencySettings(event.currentTarget)}
              aria-label="Налаштувати частоти"
              aria-controls={filterPopoverId}
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
              <TuneOutlinedIcon sx={{ fontSize: 22 }} />
            </IconButton>
          ) : null}
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
            <Typography
              variant="body2"
              sx={{ color: graphTheme.overlayTextSecondary, maxWidth: 480 }}
            >
              Збільшіть інтенсивність, звузьте період або вимкніть частоти.
            </Typography>
          </Stack>
        </Box>
      ) : graphHasNoData ? (
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
          <Stack spacing={1.25} alignItems="center" sx={{ maxWidth: 520 }}>
            <Typography variant="h6" sx={{ color: graphTheme.overlayText, fontWeight: 700 }}>
              Граф зв&apos;язків позивних
            </Typography>
            <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
              Немає даних про зв&apos;язки для вибраних мережі, періоду та частот.
            </Typography>
            <Button
              variant="text"
              onClick={onReload}
              sx={{
                fontWeight: 400,
                p: 0.5,
                px: 2.5,
                '&:hover': {
                  bgcolor: theme.palette.action.hover,
                },
              }}
            >
              Оновити
            </Button>
          </Stack>
        </Box>
      ) : graphHasNodesButNoEdges ? (
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
          <Stack spacing={1.25} alignItems="center" sx={{ maxWidth: 520 }}>
            <Typography variant="h6" sx={{ color: graphTheme.overlayText, fontWeight: 700 }}>
              Немає зв&apos;язків між позивними за вибраний період
            </Typography>
            <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
              Спробуйте оновити дані або розширити період пошуку.
            </Typography>
            <Button
              variant="text"
              onClick={onReload}
              sx={{
                fontWeight: 400,
                p: 0.5,
                px: 2.5,
                '&:hover': {
                  bgcolor: theme.palette.action.hover,
                },
              }}
            >
              Оновити
            </Button>
          </Stack>
        </Box>
      ) : graphFilteredEmpty ? (
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
          <Stack spacing={1.25} alignItems="center" sx={{ maxWidth: 520 }}>
            <Typography variant="body1" sx={{ color: graphTheme.overlayTextSecondary }}>
              Фільтри приховали всі зв&apos;язки
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
            }}
          >
            <ButtonBase
              type="button"
              onClick={(event) => onOpenIntensitySettings(event.currentTarget)}
              aria-label={`Налаштувати інтенсивність: ${relationsMinIntensity}`}
              aria-haspopup="dialog"
              aria-expanded={intensityAnchorEl !== null}
              aria-controls={
                intensityAnchorEl !== null ? `${headingId}-intensity-popover` : undefined
              }
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: 0.75,
                borderRadius: 2,
                bgcolor: graphTheme.overlayBg,
                border: `1px solid ${graphTheme.overlayBorder}`,
                color: graphTheme.overlayText,
                cursor: 'pointer',
                font: 'inherit',
                textAlign: 'left',
                boxShadow: 'none',
                '&:hover': {
                  bgcolor: theme.palette.action.hover,
                },
                '&:focus-visible': {
                  outline: `2px solid ${alpha(theme.palette.primary.main, 0.78)}`,
                  outlineOffset: 2,
                },
              }}
            >
              <Stack spacing={0.15}>
                <Typography
                  variant="caption"
                  sx={{ color: graphTheme.overlayTextSecondary, lineHeight: 1.1 }}
                >
                  Інтенсивність
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                  {relationsMinIntensity}
                </Typography>
              </Stack>
              <Tooltip title="Мінімальна кількість перехоплень для видимого ребра або вузла.">
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    color: graphTheme.overlayTextSecondary,
                  }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                </Box>
              </Tooltip>
            </ButtonBase>
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
            <Typography
              variant="overline"
              sx={{ color: graphTheme.overlayTextSecondary, letterSpacing: 1 }}
            >
              Частоти
            </Typography>
            <Stack spacing={0.8} sx={{ mt: 0.5 }}>
              {legendFreqs.map((freq) => {
                const enabled = resolvedEnabledFreqs.includes(freq.freq);
                return (
                  <Stack
                    key={freq.freq}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ opacity: enabled ? 1 : 0.35 }}
                  >
                    <Box
                      sx={{
                        width: 18,
                        height: 3,
                        borderRadius: 999,
                        bgcolor: freq.color,
                        flexShrink: 0,
                      }}
                    />
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
            onBackToNode={handleBackToNode}
            onSelectNodeId={handleSelectNodeId}
            onSelectEdgeId={handleSelectEdgeId}
            onOpenNodeEdgeId={handleOpenNodeEdgeId}
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
            onSelectNodeId={handleSelectNodeId}
            onSelectEdgeId={handleSelectEdgeId}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onWheel={onWheel}
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
              {`Оновлюємо граф зв'язків позивних${ELLIPSIS}`}
            </Typography>
          </Stack>
        </Box>
      ) : null}
    </Paper>
  );

  return isFullscreen && typeof document !== 'undefined'
    ? createPortal(stagePanel, document.body)
    : stagePanel;
}
