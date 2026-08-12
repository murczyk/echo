import AddIcon from '@mui/icons-material/Add';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
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
  showMessages?: boolean;
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
  defaultMinIntensity: number;
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
  showMessages = true,
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
  defaultMinIntensity,
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
  const [legendExpanded, setLegendExpanded] = useState(false);
  const [legendSearch, setLegendSearch] = useState('');
  const { defaultEnabledFreqs, resolvedEnabledFreqs } = relationFreqState;
  const normalizedLegendSearch = legendSearch.trim().toLocaleLowerCase();
  const visibleLegendFreqs = legendFreqs.filter(
    (freq) =>
      normalizedLegendSearch === '' ||
      freq.freq.toLocaleLowerCase().includes(normalizedLegendSearch),
  );
  const hasResettableGraphFilters =
    relationsSearch.trim() !== '' ||
    relationsMinIntensity !== defaultMinIntensity ||
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
            borderRadius: '6px',
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
              width: 36,
              height: 36,
              borderRadius: 0,
              color: graphTheme.zoomControlText,
              flex: '0 0 36px',
              minWidth: 36,
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
            <AddIcon sx={{ fontSize: 20 }} />
          </IconButton>
          <IconButton
            onClick={() => handleZoom(zoomOutFactor)}
            aria-label="Зменшити"
            sx={{
              width: 36,
              height: 36,
              borderRadius: 0,
              color: graphTheme.zoomControlText,
              flex: '0 0 36px',
              minWidth: 36,
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
            <RemoveIcon sx={{ fontSize: 20 }} />
          </IconButton>
          <IconButton
            onClick={() => setIsFullscreen((current) => !current)}
            aria-label={isFullscreen ? 'Згорнути граф' : 'Розгорнути граф'}
            title={isFullscreen ? 'Згорнути граф' : 'Розгорнути граф'}
            sx={{
              width: 36,
              height: 36,
              borderRadius: 0,
              color: graphTheme.zoomControlText,
              flex: '0 0 36px',
              minWidth: 36,
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
                fontSize: 16,
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
        </Box>
      </Box>

      {isFullscreen ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{ position: 'absolute', top: 16, left: 16, zIndex: 2 }}
        >
          <Button
            variant="outlined"
            size="small"
            onClick={(event) => onOpenIntensitySettings(event.currentTarget)}
            aria-label={`Налаштувати інтенсивність: ${relationsMinIntensity}`}
            aria-haspopup="dialog"
            aria-expanded={intensityAnchorEl !== null}
            aria-controls={
              intensityAnchorEl !== null ? `${headingId}-intensity-popover` : undefined
            }
            endIcon={<InfoOutlinedIcon sx={{ fontSize: 16 }} />}
            title="Мінімум перехоплень для видимого ребра або вузла."
            sx={{
              height: 32,
              px: 1.1,
              color: graphTheme.overlayTextSecondary,
              borderColor: graphTheme.overlayBorder,
              bgcolor: graphTheme.overlayBg,
              textTransform: 'none',
              fontSize: '0.75rem',
              fontWeight: 600,
              '& .MuiButton-endIcon': { ml: 0.5 },
              '&:hover': { borderColor: graphTheme.overlayTextSecondary },
            }}
          >
            Інтенсивність: {relationsMinIntensity}
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={(event) => onOpenFrequencySettings(event.currentTarget)}
            aria-label="Налаштувати частоти"
            aria-controls={filterPopoverId}
            startIcon={<TuneOutlinedIcon sx={{ fontSize: 16 }} />}
            sx={{
              height: 32,
              px: 1.1,
              color: graphTheme.overlayTextSecondary,
              borderColor: graphTheme.overlayBorder,
              bgcolor: graphTheme.overlayBg,
              textTransform: 'none',
              fontSize: '0.75rem',
              fontWeight: 600,
              '& .MuiButton-startIcon': { mr: 0.5 },
              '&:hover': { borderColor: graphTheme.overlayTextSecondary },
            }}
          >
            Частоти
          </Button>
        </Stack>
      ) : null}

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
              Граф зв'язків позивних
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
                  onMinIntensityChange(defaultMinIntensity);
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
              left: 16,
              bottom: 16,
              zIndex: 2,
              px: 1,
              py: 1.25,
              borderRadius: 1,
              bgcolor: alpha(theme.palette.background.paper, isDarkMode ? 0.82 : 0.92),
              border: `1px solid ${alpha(theme.palette.text.primary, isDarkMode ? 0.14 : 0.12)}`,
              color: graphTheme.overlayText,
            }}
          >
            <ButtonBase
              onClick={() => setLegendExpanded((expanded) => !expanded)}
              aria-expanded={legendExpanded}
              aria-label={legendExpanded ? 'Згорнути частоти' : 'Розгорнути частоти'}
              sx={{
                width: '100%',
                minHeight: 24,
                display: 'flex',
                justifyContent: 'space-between',
                gap: 0.5,
                color: 'inherit',
                borderRadius: 0.5,
              }}
            >
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  Частоти
                </Typography>
                <Box
                  component="span"
                  sx={{
                    minWidth: 18,
                    height: 18,
                    px: 0.5,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    bgcolor: alpha(theme.palette.text.primary, isDarkMode ? 0.12 : 0.08),
                    color: graphTheme.overlayTextSecondary,
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {legendFreqs.length}
                </Box>
              </Stack>
              {legendExpanded ? (
                <ExpandLessIcon sx={{ fontSize: 17 }} />
              ) : (
                <ExpandMoreIcon sx={{ fontSize: 17 }} />
              )}
            </ButtonBase>
            {legendExpanded ? (
              <>
                <TextField
                  size="small"
                  value={legendSearch}
                  onChange={(event) => setLegendSearch(event.target.value)}
                  placeholder="Частота"
                  InputProps={{
                    endAdornment:
                      legendSearch !== '' ? (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label="Очистити пошук частот у легенді"
                            size="small"
                            onClick={() => setLegendSearch('')}
                            sx={{ p: 0.125 }}
                          >
                            <ClearOutlinedIcon sx={{ fontSize: 15 }} />
                          </IconButton>
                        </InputAdornment>
                      ) : undefined,
                  }}
                  sx={{
                    width: 96,
                    mt: 0.5,
                    '& .MuiOutlinedInput-root': { height: 30 },
                    '& .MuiInputBase-input': { py: 0.25, fontSize: '0.75rem' },
                  }}
                />
                <Stack sx={{ mt: 0.5, maxHeight: 130, overflowY: 'auto' }}>
                  {visibleLegendFreqs.map((freq) => {
                    const enabled = resolvedEnabledFreqs.includes(freq.freq);
                    return (
                      <Stack
                        key={freq.freq}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        sx={{ opacity: enabled ? 1 : 0.35, minHeight: 26, flexShrink: 0 }}
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
                  {visibleLegendFreqs.length === 0 ? (
                    <Typography
                      variant="caption"
                      sx={{ py: 0.5, color: graphTheme.overlayTextSecondary }}
                    >
                      Частот не знайдено
                    </Typography>
                  ) : null}
                </Stack>
              </>
            ) : null}
          </Box>

          <NetworkCallsignRelationsGraphDetails
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            drilldownNode={drilldownNode}
            selectedNodeEdges={selectedNodeEdges}
            selectedMessages={selectedMessages}
            selectedMessagesLoading={selectedMessagesLoading}
            selectedMessagesError={selectedMessagesError}
            showMessages={showMessages}
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
