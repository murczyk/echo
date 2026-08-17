import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import * as L from 'leaflet';
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyTextToClipboard } from '../../../../../copy-to-clipboard';
import { renderWgsFloat } from '../../../importer-beta/coordinates';
import { getTileLayers } from '../../../../../web-components/analysis-map/tile-layers';
import { getCoordinateMgrsText, getCoordinateText } from '../../../../../maps/coordinate-format';
import { formatCoordinateLocality } from '../../../../../maps/coordinate-locality';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { CoordinatePreviewPoint } from '../message-coordinate-preview';
import { getAttachmentPreviewStageSx } from '../attachment-preview/message-card-attachment-preview';
import { getMessageCardAttachmentPreviewConfig } from '../attachment-preview/message-card-preview-config';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';

type MapInitState = 'loading' | 'ready' | 'error';
type BaseLayerId = 'googleHybrid' | 'openStreetMap';

const PREVIEW_ZOOM = 13;
const PREVIEW_MAX_ZOOM = 13;
const PREVIEW_BOUNDS_PADDING: [number, number] = [40, 40];
const MAP_INIT_TIMEOUT_MS = 2000;
const MAP_HOST_MIN_SIZE_PX = 48;
const COORDINATE_ROW_HEIGHT = 24;
const COORDINATE_ROW_GAP = 6;
const COORDINATE_LABEL_WIDTH = 80;
const COORDINATE_PANEL_WIDTH = 300;
const COORDINATE_COPY_SIZE = 20;
const COORDINATE_COPY_GAP = 4;

function plainTextMarkerLabel(label: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.textContent = label;
  return element;
}

function DocumentPointContext({ point }: { point: CoordinatePreviewPoint }) {
  if (point.source !== 'document') return null;
  return (
    <Box sx={{ maxWidth: '100%', maxHeight: 180, overflowY: 'auto', pr: 0.5 }}>
      <Typography
        variant="subtitle2"
        data-coordinate-document-title="true"
        sx={{ overflowWrap: 'anywhere', color: 'text.primary' }}
      >
        {point.label}
      </Typography>
      {point.description?.trim() ? (
        <Typography
          variant="body2"
          data-coordinate-document-description="true"
          sx={{ mt: 0.5, color: 'text.primary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {point.description}
        </Typography>
      ) : null}
      {point.plannedMeans?.trim() ? (
        <Box sx={{ mt: 0.75 }}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
            Сплановані засоби
          </Typography>
          <Typography
            variant="body2"
            data-coordinate-document-planned-means="true"
            sx={{ color: 'text.primary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {point.plannedMeans}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}

export function CoordinateAttachmentPreviewRenderer({
  points,
  navigation,
  isFullscreen,
  onFullscreenChange,
  onClose,
}: {
  points: CoordinatePreviewPoint[];
  navigation: MessageCardPreviewNavigation;
  isFullscreen: boolean;
  onFullscreenChange: (isFullscreen: boolean) => void;
  onClose: () => void;
}) {
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>('googleHybrid');
  const previewConfig = getMessageCardAttachmentPreviewConfig('coordinate-map');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex((index) => (points.length === 0 ? 0 : Math.min(index, points.length - 1)));
  }, [points.length]);

  const changeActiveIndex = useCallback(
    (index: number) => {
      setActiveIndex(
        points.length === 0 ? 0 : ((index % points.length) + points.length) % points.length,
      );
    },
    [points.length],
  );

  const header = (
    <MessageCardAttachmentPreviewHeader
      fileName="Координати"
      navigation={navigation}
      onClose={onClose}
      isFullscreen={dialogIsFullscreen}
      canFullscreen={canFullscreen}
      onToggleFullscreen={() => onFullscreenChange(!dialogIsFullscreen)}
    />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      isFullscreen={dialogIsFullscreen}
      config={previewConfig}
      stage={
        <CoordinateMapPreview
          points={points}
          activeIndex={activeIndex}
          onActiveIndexChange={changeActiveIndex}
          baseLayerId={baseLayerId}
          isFullscreen={dialogIsFullscreen}
        />
      }
      header={header}
      controls={
        <CoordinateMapPreviewControls
          baseLayerId={baseLayerId}
          onBaseLayerChange={setBaseLayerId}
          pointNavigation={{
            index: activeIndex,
            count: points.length,
            onPrevious: () => changeActiveIndex(activeIndex - 1),
            onNext: () => changeActiveIndex(activeIndex + 1),
          }}
        />
      }
      navigation={navigation}
      swipeEnabled={false}
      onToggleFullscreen={() => onFullscreenChange(!dialogIsFullscreen)}
    />
  );
}

function CoordinateMapPreview({
  points,
  activeIndex,
  onActiveIndexChange,
  baseLayerId,
  isFullscreen,
}: {
  points: CoordinatePreviewPoint[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  baseLayerId: BaseLayerId;
  isFullscreen: boolean;
}) {
  const theme = useTheme();
  const [mapHostEl, setMapHostEl] = useState<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<L.CircleMarker[]>([]);
  const layerRef = useRef<L.TileLayer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const baseLayerIdRef = useRef<BaseLayerId>('googleHybrid');
  const pointsRef = useRef(points);
  const activeIndexRef = useRef(activeIndex);
  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  const initFrameRef = useRef<number | null>(null);
  const invalidateFrameRef = useRef<number | null>(null);
  const initTimeoutRef = useRef<number | null>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const [mapInitState, setMapInitState] = useState<MapInitState>('loading');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [retryToken, setRetryToken] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(true);

  useEffect(() => {
    baseLayerIdRef.current = baseLayerId;
  }, [baseLayerId]);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    onActiveIndexChangeRef.current = onActiveIndexChange;
  }, [onActiveIndexChange]);

  useEffect(() => {
    setCopyStatus('idle');
    setIsPanelOpen(true);
  }, [activeIndex]);

  useEffect(() => {
    if (mapRef.current == null) {
      return;
    }

    const tileLayers = tileLayersRef.current;
    if (tileLayers == null) {
      return;
    }

    const nextLayer =
      baseLayerId === 'googleHybrid' ? tileLayers.googleHybrid : tileLayers.openStreetMap;
    if (layerRef.current === nextLayer) {
      return;
    }

    layerRef.current?.remove();
    nextLayer.addTo(mapRef.current);
    layerRef.current = nextLayer;
  }, [baseLayerId]);

  useEffect(() => {
    if (mapRef.current == null) {
      return;
    }

    const activePoint = pointsRef.current[activeIndex];
    if (activePoint == null) {
      return;
    }

    mapRef.current.setView([activePoint.lat, activePoint.lng], mapRef.current.getZoom());
    markerRefs.current.forEach((marker, index) => {
      marker.setStyle(
        index === activeIndex
          ? { radius: 10, fillColor: '#1976d2' }
          : { radius: 8, fillColor: '#ff4d2d' },
      );
    });

    if (invalidateFrameRef.current !== null) {
      window.cancelAnimationFrame(invalidateFrameRef.current);
      invalidateFrameRef.current = null;
    }

    invalidateFrameRef.current = window.requestAnimationFrame(() => {
      invalidateFrameRef.current = null;
      mapRef.current?.invalidateSize();
    });
  }, [activeIndex]);

  useEffect(() => {
    if (invalidateFrameRef.current !== null) {
      window.cancelAnimationFrame(invalidateFrameRef.current);
      invalidateFrameRef.current = null;
    }

    invalidateFrameRef.current = window.requestAnimationFrame(() => {
      invalidateFrameRef.current = null;
      mapRef.current?.invalidateSize();
    });

    return () => {
      if (invalidateFrameRef.current !== null) {
        window.cancelAnimationFrame(invalidateFrameRef.current);
        invalidateFrameRef.current = null;
      }
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (mapHostEl == null) {
      return;
    }

    let cancelled = false;
    const currentHost = mapHostEl;

    const clearPendingInvalidate = () => {
      if (invalidateFrameRef.current === null) {
        return;
      }

      window.cancelAnimationFrame(invalidateFrameRef.current);
      invalidateFrameRef.current = null;
    };

    const scheduleInvalidate = () => {
      if (invalidateFrameRef.current !== null || cancelled || mapRef.current == null) {
        return;
      }

      invalidateFrameRef.current = window.requestAnimationFrame(() => {
        invalidateFrameRef.current = null;
        const map = mapRef.current;
        if (map == null) {
          return;
        }
        map.invalidateSize({ animate: false, pan: false });
        const latLngs = pointsRef.current.map(({ lat, lng }): [number, number] => [lat, lng]);
        if (latLngs.length > 1) {
          map.fitBounds(L.latLngBounds(latLngs), {
            animate: false,
            maxZoom: PREVIEW_MAX_ZOOM,
            padding: PREVIEW_BOUNDS_PADDING,
          });
        }
      });
    };

    const initializeMap = () => {
      if (cancelled || mapRef.current != null || mapHostEl !== currentHost) {
        return false;
      }

      if (!currentHost.isConnected) {
        return false;
      }

      const rect = currentHost.getBoundingClientRect();
      if (rect.width < MAP_HOST_MIN_SIZE_PX || rect.height < MAP_HOST_MIN_SIZE_PX) {
        return false;
      }

      const visiblePoints = pointsRef.current;
      const currentPoint = visiblePoints[activeIndexRef.current] ?? visiblePoints[0];
      if (currentPoint == null) {
        return false;
      }
      const map = L.map(currentHost, {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        touchZoom: true,
        boxZoom: true,
        keyboard: true,
        preferCanvas: true,
        minZoom: 2,
        maxZoom: 17,
      });
      map.on('click', () => setIsPanelOpen(false));
      L.control?.zoom?.({ position: 'bottomright' })?.addTo?.(map);

      const latLngs = visiblePoints.map(({ lat, lng }): [number, number] => [lat, lng]);
      if (latLngs.length === 1) {
        map.setView(latLngs[0], PREVIEW_ZOOM);
      } else {
        map.fitBounds(L.latLngBounds(latLngs), {
          animate: false,
          maxZoom: PREVIEW_MAX_ZOOM,
          padding: PREVIEW_BOUNDS_PADDING,
        });
      }

      const tileLayers = getTileLayers();
      tileLayersRef.current = tileLayers;
      const baseLayer =
        baseLayerIdRef.current === 'googleHybrid'
          ? tileLayers.googleHybrid
          : tileLayers.openStreetMap;
      baseLayer.addTo(map);

      const markers = visiblePoints.map(({ lat, lng, label }, index) => {
        const marker = L.circleMarker([lat, lng], {
          radius: index === activeIndexRef.current ? 10 : 8,
          color: '#ffffff',
          weight: 3,
          fillColor: index === activeIndexRef.current ? '#1976d2' : '#ff4d2d',
          fillOpacity: 1,
          interactive: true,
          bubblingMouseEvents: false,
        })
          .bindTooltip(plainTextMarkerLabel(label))
          .addTo(map);
        marker.on('click', () => {
          map.setView([lat, lng], map.getZoom());
          setIsPanelOpen(true);
          onActiveIndexChangeRef.current(index);
        });
        return marker;
      });

      mapRef.current = map;
      markerRefs.current = markers;
      layerRef.current = baseLayer;
      setMapInitState('ready');
      scheduleInvalidate();

      return true;
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (cancelled) {
              return;
            }

            if (mapRef.current == null) {
              initializeMap();
              return;
            }

            scheduleInvalidate();
          });

    resizeObserver?.observe(currentHost);
    initTimeoutRef.current = window.setTimeout(() => {
      if (!cancelled && mapRef.current == null) {
        setMapInitState('error');
      }
    }, MAP_INIT_TIMEOUT_MS);

    initFrameRef.current = window.requestAnimationFrame(() => {
      initFrameRef.current = null;
      initializeMap();
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (initFrameRef.current !== null) {
        window.cancelAnimationFrame(initFrameRef.current);
        initFrameRef.current = null;
      }
      if (initTimeoutRef.current !== null) {
        window.clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      clearPendingInvalidate();
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      layerRef.current?.remove();
      layerRef.current = null;
      tileLayersRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapHostEl, retryToken]);

  const point = points[activeIndex] ?? points[0];
  if (point == null) {
    return null;
  }
  const mgrsText = getCoordinateMgrsText({ lat: point.lat, lng: point.lng });
  const wgs84Text = `${renderWgsFloat(point.lat)}, ${renderWgsFloat(point.lng)}`;
  const dmsText = getCoordinateText('dms', point);
  const sk42Text = getCoordinateText('sk42', point);
  const usk2000Text = getCoordinateText('usk2000', point);
  const utmText = getCoordinateText('utm', point);
  const localityText = formatCoordinateLocality(point.locality ?? null);
  const handleCopyMgrs = useCallback(() => {
    if (mgrsText == null) {
      return;
    }

    setCopyStatus('copying');
    void copyTextToClipboard(mgrsText)
      .then(() => {
        setCopyStatus('copied');
        if (copyResetTimeoutRef.current !== null) {
          window.clearTimeout(copyResetTimeoutRef.current);
        }
        copyResetTimeoutRef.current = window.setTimeout(() => {
          setCopyStatus('idle');
          copyResetTimeoutRef.current = null;
        }, 1200);
      })
      .catch(() => {
        setCopyStatus('error');
        if (copyResetTimeoutRef.current !== null) {
          window.clearTimeout(copyResetTimeoutRef.current);
        }
        copyResetTimeoutRef.current = window.setTimeout(() => {
          setCopyStatus('idle');
          copyResetTimeoutRef.current = null;
        }, 1200);
      });
  }, [mgrsText]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const isDark = theme.palette.mode === 'dark';
  const panelBackground = isDark ? 'rgba(31, 36, 42, 0.96)' : 'rgba(255, 255, 255, 0.95)';
  const panelBorder = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';
  const panelTextColor = isDark ? 'rgba(255, 255, 255, 0.96)' : theme.palette.text.primary;
  const coordinateLabelSx = {
    color: isDark ? 'rgba(255, 255, 255, 0.76)' : 'text.secondary',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: '0.03em',
    fontFamily: 'inherit',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as const;
  const coordinateValueSx = {
    color: isDark ? 'rgba(255, 255, 255, 0.96)' : 'text.primary',
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1,
    letterSpacing: '0.03em',
    fontFamily: 'inherit',
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as const;
  const copyButtonTitle =
    copyStatus === 'copied'
      ? 'Скопійовано'
      : copyStatus === 'error'
        ? 'Не вдалося скопіювати'
        : 'Копіювати MGRS';
  const copyButtonIcon =
    copyStatus === 'copied' ? (
      <CheckIcon sx={{ fontSize: 13 }} />
    ) : copyStatus === 'error' ? (
      <ErrorOutlineIcon sx={{ fontSize: 13 }} />
    ) : (
      <ContentCopyIcon sx={{ fontSize: 13 }} />
    );

  const stopDragPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <Box
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: 0,
        backgroundColor: 'background.paper',
        ...getAttachmentPreviewStageSx(theme, isFullscreen),
      }}
    >
      <Box
        ref={setMapHostEl}
        data-coordinate-marker-count={mapInitState === 'ready' ? points.length : 0}
        sx={{
          position: 'absolute',
          inset: 0,
          '& .leaflet-container': {
            width: '100%',
            height: '100%',
          },
        }}
      />
      {mapInitState === 'ready' ? null : (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
            backgroundColor: 'rgba(10, 13, 18, 0.08)',
            zIndex: 1,
          }}
        >
          {mapInitState === 'loading' ? (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                borderRadius: 999,
                bgcolor: panelBackground,
                color: 'text.primary',
              }}
            >
              <CircularProgress size={18} color="inherit" />
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Завантаження мапи…
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1.25,
                px: 2,
                py: 1.5,
                borderRadius: 2,
                bgcolor: panelBackground,
                color: 'text.primary',
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                Не вдалося відкрити мапу
              </Typography>
              <Button
                aria-label="Повторити"
                size="small"
                variant="contained"
                onClick={() => {
                  setMapInitState('loading');
                  setRetryToken((value) => value + 1);
                }}
              >
                Повторити
              </Button>
            </Box>
          )}
        </Box>
      )}
      <Box
        sx={{
          position: 'absolute',
          left: 16,
          top: 16,
          zIndex: 1200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 1,
          pointerEvents: 'none',
        }}
        style={{
          position: 'absolute',
          left: '16px',
          top: '16px',
          zIndex: 1200,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '8px',
          pointerEvents: 'none',
        }}
      >
        <Box
          sx={{
            display: isPanelOpen ? 'inline-flex' : 'none',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: `${COORDINATE_ROW_GAP}px`,
            px: '12px',
            py: '12px',
            width: COORDINATE_PANEL_WIDTH,
            maxWidth: 'min(100%, calc(100vw - 120px))',
            borderRadius: 2.5,
            bgcolor: panelBackground,
            color: panelTextColor,
            border: 1,
            borderColor: panelBorder,
            boxShadow: '0 14px 32px rgba(0, 0, 0, 0.36)',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'auto',
          }}
          style={{
            display: isPanelOpen ? 'inline-flex' : 'none',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: `${COORDINATE_ROW_GAP}px`,
            padding: '12px',
            width: `${COORDINATE_PANEL_WIDTH}px`,
            maxWidth: 'min(100%, calc(100vw - 120px))',
            pointerEvents: 'auto',
          }}
          data-coordinate-panel="true"
          onMouseDown={stopDragPropagation}
          onMouseUp={stopDragPropagation}
          onPointerDown={stopDragPropagation}
          onPointerUp={stopDragPropagation}
          onTouchStart={stopDragPropagation}
          onTouchEnd={stopDragPropagation}
          onClick={stopDragPropagation}
          onDoubleClick={stopDragPropagation}
        >
          <IconButton
            aria-label="Закрити картку координати"
            title="Закрити"
            size="small"
            onClick={() => setIsPanelOpen(false)}
            sx={{
              alignSelf: 'flex-end',
              width: 24,
              height: 24,
              color: 'text.secondary',
              bgcolor: 'transparent',
              '&:hover': {
                color: 'text.primary',
                bgcolor: 'action.hover',
              },
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
          <DocumentPointContext point={point} />
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              height: COORDINATE_ROW_HEIGHT,
              minHeight: COORDINATE_ROW_HEIGHT,
              maxWidth: '100%',
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: `${COORDINATE_ROW_HEIGHT}px`,
              minHeight: `${COORDINATE_ROW_HEIGHT}px`,
              maxWidth: '100%',
            }}
            data-coordinate-row="wgs84"
          >
            <Typography
              variant="caption"
              sx={coordinateLabelSx}
              style={{
                flex: `0 0 ${COORDINATE_LABEL_WIDTH}px`,
                width: `${COORDINATE_LABEL_WIDTH}px`,
              }}
              data-coordinate-label="wgs84"
            >
              WGS84
            </Typography>
            <Typography
              variant="caption"
              sx={coordinateValueSx}
              style={{ flex: '1 1 auto', minWidth: 0 }}
              data-wgs84-text={wgs84Text}
              title={wgs84Text}
            >
              {wgs84Text}
            </Typography>
          </Box>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              height: COORDINATE_ROW_HEIGHT,
              minHeight: COORDINATE_ROW_HEIGHT,
              maxWidth: '100%',
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: `${COORDINATE_ROW_HEIGHT}px`,
              minHeight: `${COORDINATE_ROW_HEIGHT}px`,
              maxWidth: '100%',
            }}
            data-coordinate-row="mgrs"
          >
            <Typography
              variant="caption"
              sx={coordinateLabelSx}
              style={{
                flex: `0 0 ${COORDINATE_LABEL_WIDTH}px`,
                width: `${COORDINATE_LABEL_WIDTH}px`,
              }}
              data-coordinate-label="mgrs"
            >
              MGRS
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `minmax(0, 1fr) ${COORDINATE_COPY_SIZE}px`,
                alignItems: 'center',
                columnGap: `${COORDINATE_COPY_GAP}px`,
                height: COORDINATE_ROW_HEIGHT,
                width: '100%',
                minWidth: 0,
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: `minmax(0, 1fr) ${COORDINATE_COPY_SIZE}px`,
                alignItems: 'center',
                columnGap: `${COORDINATE_COPY_GAP}px`,
                height: `${COORDINATE_ROW_HEIGHT}px`,
                width: '100%',
                minWidth: 0,
              }}
              data-coordinate-row="mgrs-content"
            >
              <Typography
                variant="caption"
                sx={coordinateValueSx}
                style={{ minWidth: 0, width: 'auto', flex: '1 1 auto' }}
                data-mgrs-text={mgrsText ?? 'MGRS недоступні'}
                title={mgrsText ?? 'MGRS недоступні'}
              >
                {mgrsText ?? 'MGRS недоступні'}
              </Typography>
              <IconButton
                aria-label="Копіювати MGRS"
                title={copyButtonTitle}
                data-copy-status={copyStatus}
                size="small"
                onClick={handleCopyMgrs}
                disabled={mgrsText == null}
                sx={{
                  pointerEvents: 'auto',
                  width: COORDINATE_COPY_SIZE,
                  height: COORDINATE_COPY_SIZE,
                  borderRadius: 1,
                  color:
                    copyStatus === 'copied'
                      ? 'success.main'
                      : copyStatus === 'error'
                        ? 'error.main'
                        : 'text.secondary',
                  bgcolor: 'transparent',
                  border: 1,
                  borderColor: 'transparent',
                  '&:hover': {
                    bgcolor: 'action.hover',
                    color: 'text.primary',
                  },
                  '&.Mui-disabled': {
                    color: 'action.disabled',
                  },
                  '&.Mui-focusVisible': {
                    outline: 'none',
                    boxShadow: 'none',
                  },
                }}
                style={{
                  width: `${COORDINATE_COPY_SIZE}px`,
                  height: `${COORDINATE_COPY_SIZE}px`,
                }}
              >
                {copyButtonIcon}
              </IconButton>
            </Box>
          </Box>

          {isExpanded ? (
            <>
              <CoordinateValueRow
                label="DMS"
                value={dmsText}
                labelSx={coordinateLabelSx}
                valueSx={coordinateValueSx}
              />
              <CoordinateValueRow
                label="СК-42"
                value={sk42Text}
                labelSx={coordinateLabelSx}
                valueSx={coordinateValueSx}
              />
              <CoordinateValueRow
                label="УСК-2000"
                value={usk2000Text}
                labelSx={coordinateLabelSx}
                valueSx={coordinateValueSx}
              />
              <CoordinateValueRow
                label="UTM"
                value={utmText}
                labelSx={coordinateLabelSx}
                valueSx={coordinateValueSx}
              />
            </>
          ) : null}

          <Button
            size="small"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? 'Сховати інші формати' : 'Показати інші формати'}
            data-coordinate-expand-button="true"
            startIcon={
              isExpanded ? (
                <ExpandLessIcon sx={{ fontSize: '14px !important' }} />
              ) : (
                <ExpandMoreIcon sx={{ fontSize: '14px !important' }} />
              )
            }
            sx={{
              pointerEvents: 'auto',
              alignSelf: 'flex-start',
              fontSize: 11,
              fontWeight: 600,
              minWidth: 0,
              p: 0,
              minHeight: 20,
              color: isDark ? 'rgba(255, 255, 255, 0.7)' : 'text.secondary',
              textTransform: 'none',
              '&:hover': {
                bgcolor: 'transparent',
                color: isDark ? 'common.white' : 'text.primary',
              },
            }}
          >
            {isExpanded ? 'Сховати' : 'Інші формати'}
          </Button>

          {localityText ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ maxWidth: 420, lineHeight: 1.3 }}
              data-coordinate-locality="true"
            >
              {localityText}
            </Typography>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

function CoordinateValueRow({
  label,
  value,
  labelSx,
  valueSx,
}: {
  label: string;
  value: string;
  labelSx?: object;
  valueSx?: object;
}) {
  const displayValue = value.replace(new RegExp(`^${label}:\\s*`), '');
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: COORDINATE_ROW_HEIGHT,
        minHeight: COORDINATE_ROW_HEIGHT,
        maxWidth: '100%',
      }}
      data-coordinate-row={label.toLowerCase()}
    >
      <Typography
        variant="caption"
        sx={{
          flex: `0 0 ${COORDINATE_LABEL_WIDTH}px`,
          width: COORDINATE_LABEL_WIDTH,
          ...labelSx,
        }}
        style={{
          flex: `0 0 ${COORDINATE_LABEL_WIDTH}px`,
          width: `${COORDINATE_LABEL_WIDTH}px`,
        }}
        data-coordinate-label={label.toLowerCase()}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          ...valueSx,
        }}
        title={displayValue}
      >
        {displayValue}
      </Typography>
    </Box>
  );
}
