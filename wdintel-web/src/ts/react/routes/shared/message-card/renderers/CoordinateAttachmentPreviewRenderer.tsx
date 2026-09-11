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
import type { SyntheticEvent } from 'react';

import { copyTextToClipboard } from '../../../../../copy-to-clipboard';
import { renderWgsFloat } from '../../../importer-beta/coordinates';
import { BaseLayerId, DEFAULT_BASE_LAYER_ID } from '../../../../../maps/base-layers';
import { getTileLayers } from '../../../../../web-components/analysis-map/tile-layers';
import { getCoordinateMgrsText, getCoordinateText } from '../../../../../maps/coordinate-format';
import { formatCoordinateLocality } from '../../../../../maps/coordinate-locality';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { CoordinatePreviewPoint } from '../message-coordinate-preview';
import { getAttachmentPreviewStageSx } from '../attachment-preview/message-card-attachment-preview';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';

type MapInitState = 'loading' | 'ready' | 'error';
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
const COPY_RESET_MS = 1200;

type CoordinateFormat = 'wgs84' | 'mgrs' | 'dms' | 'sk42' | 'usk2000' | 'utm';
type CopyStatus = 'idle' | 'copying' | 'copied' | 'error';
type CoordinateRow = {
  id: CoordinateFormat;
  label: string;
  value: string | null;
};

const INITIAL_COPY_STATUSES: Record<CoordinateFormat, CopyStatus> = {
  wgs84: 'idle',
  mgrs: 'idle',
  dms: 'idle',
  sk42: 'idle',
  usk2000: 'idle',
  utm: 'idle',
};

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
  onClose,
}: {
  points: CoordinatePreviewPoint[];
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
}) {
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>(DEFAULT_BASE_LAYER_ID);
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
    />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      stage={
        <CoordinateMapPreview
          points={points}
          activeIndex={activeIndex}
          onActiveIndexChange={changeActiveIndex}
          baseLayerId={baseLayerId}
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
    />
  );
}

function CoordinateMapPreview({
  points,
  activeIndex,
  onActiveIndexChange,
  baseLayerId,
}: {
  points: CoordinatePreviewPoint[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  baseLayerId: BaseLayerId;
}) {
  const theme = useTheme();
  const [mapHostEl, setMapHostEl] = useState<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<L.CircleMarker[]>([]);
  const layerRef = useRef<L.Layer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const baseLayerIdRef = useRef<BaseLayerId>(DEFAULT_BASE_LAYER_ID);
  const pointsRef = useRef(points);
  const activeIndexRef = useRef(activeIndex);
  const previousActiveIndexRef = useRef(activeIndex);
  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  const initFrameRef = useRef<number | null>(null);
  const invalidateFrameRef = useRef<number | null>(null);
  const initTimeoutRef = useRef<number | null>(null);
  const copyResetTimeoutsRef = useRef<Partial<Record<CoordinateFormat, number>>>({});
  const copyGenerationRef = useRef(0);
  const copyRequestIdsRef = useRef<Partial<Record<CoordinateFormat, number>>>({});
  const [mapInitState, setMapInitState] = useState<MapInitState>('loading');
  const [copyStatuses, setCopyStatuses] =
    useState<Record<CoordinateFormat, CopyStatus>>(INITIAL_COPY_STATUSES);
  const [retryToken, setRetryToken] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

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
    copyGenerationRef.current += 1;
    Object.values(copyResetTimeoutsRef.current).forEach((timeout) => window.clearTimeout(timeout));
    copyResetTimeoutsRef.current = {};
    copyRequestIdsRef.current = {};
    setCopyStatuses(INITIAL_COPY_STATUSES);
    if (previousActiveIndexRef.current !== activeIndex) {
      setIsPanelOpen(true);
      previousActiveIndexRef.current = activeIndex;
    }
  }, [activeIndex]);

  useEffect(() => {
    if (mapRef.current == null) {
      return;
    }

    const tileLayers = tileLayersRef.current;
    if (tileLayers == null) {
      return;
    }

    const nextLayer = tileLayers[baseLayerId];
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
      const baseLayer = tileLayers[baseLayerIdRef.current];
      baseLayer.addTo(map);

      const markers = visiblePoints.map(({ lat, lng }, index) => {
        const marker = L.circleMarker([lat, lng], {
          radius: index === activeIndexRef.current ? 10 : 8,
          color: '#ffffff',
          weight: 3,
          fillColor: index === activeIndexRef.current ? '#1976d2' : '#ff4d2d',
          fillOpacity: 1,
          interactive: true,
          bubblingMouseEvents: false,
        }).addTo(map);
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
  const coordinateRows: CoordinateRow[] = [
    { id: 'wgs84', label: 'WGS84', value: wgs84Text },
    { id: 'mgrs', label: 'MGRS', value: mgrsText },
    { id: 'dms', label: 'DMS', value: dmsText },
    { id: 'sk42', label: 'СК-42', value: sk42Text.replace('СК-42: ', '') },
    { id: 'usk2000', label: 'УСК-2000', value: usk2000Text.replace('УСК-2000: ', '') },
    { id: 'utm', label: 'UTM', value: utmText },
  ];
  const localityText = formatCoordinateLocality(point.locality ?? null);
  const handleCopy = useCallback((format: CoordinateFormat, value: string | null) => {
    if (value == null) {
      return;
    }

    const generation = copyGenerationRef.current;
    const requestId = (copyRequestIdsRef.current[format] ?? 0) + 1;
    copyRequestIdsRef.current[format] = requestId;
    const isCurrentRequest = () =>
      copyGenerationRef.current === generation && copyRequestIdsRef.current[format] === requestId;
    const scheduleReset = () => {
      if (!isCurrentRequest()) {
        return;
      }
      const existingTimeout = copyResetTimeoutsRef.current[format];
      if (existingTimeout != null) {
        window.clearTimeout(existingTimeout);
      }
      copyResetTimeoutsRef.current[format] = window.setTimeout(() => {
        if (!isCurrentRequest()) {
          return;
        }
        setCopyStatuses((statuses) => ({ ...statuses, [format]: 'idle' }));
        delete copyResetTimeoutsRef.current[format];
      }, COPY_RESET_MS);
    };

    setCopyStatuses((statuses) => ({ ...statuses, [format]: 'copying' }));
    void copyTextToClipboard(value)
      .then(() => {
        if (!isCurrentRequest()) {
          return;
        }
        setCopyStatuses((statuses) => ({ ...statuses, [format]: 'copied' }));
        scheduleReset();
      })
      .catch(() => {
        if (!isCurrentRequest()) {
          return;
        }
        setCopyStatuses((statuses) => ({ ...statuses, [format]: 'error' }));
        scheduleReset();
      });
  }, []);

  useEffect(() => {
    return () => {
      copyGenerationRef.current += 1;
      Object.values(copyResetTimeoutsRef.current).forEach((timeout) =>
        window.clearTimeout(timeout),
      );
      copyResetTimeoutsRef.current = {};
      copyRequestIdsRef.current = {};
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
  const stopDragPropagation = (event: SyntheticEvent) => {
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
        ...getAttachmentPreviewStageSx(),
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
          <div className="flex w-full items-center justify-between">
            <Typography
              component="h3"
              variant="subtitle2"
              data-coordinate-panel-heading="true"
              sx={{ color: panelTextColor }}
            >
              Координати
            </Typography>
            <IconButton
              aria-label="Закрити картку координати"
              title="Закрити"
              size="small"
              onClick={() => setIsPanelOpen(false)}
              sx={{
                width: 24,
                height: 24,
                color: 'text.secondary',
                bgcolor: 'transparent',
                '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
              }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </div>
          <DocumentPointContext point={point} />
          <div role="table" className="w-full">
            {(isExpanded ? coordinateRows : coordinateRows.slice(0, 2)).map((row) => (
              <CoordinateValueRow
                key={row.id}
                format={row.id}
                label={row.label}
                value={row.value}
                status={copyStatuses[row.id]}
                onCopy={handleCopy}
                labelSx={coordinateLabelSx}
                valueSx={coordinateValueSx}
              />
            ))}
          </div>

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
  format,
  label,
  value,
  status,
  onCopy,
  labelSx,
  valueSx,
}: {
  format: CoordinateFormat;
  label: string;
  value: string | null;
  status: CopyStatus;
  onCopy: (format: CoordinateFormat, value: string | null) => void;
  labelSx?: object;
  valueSx?: object;
}) {
  const displayValue = value == null ? 'MGRS недоступні' : value.replace(`${label}: `, '');
  const copyButtonTitle =
    status === 'copied'
      ? 'Скопійовано'
      : status === 'error'
        ? 'Не вдалося скопіювати'
        : `Копіювати ${label}`;
  const copyButtonIcon =
    status === 'copied' ? (
      <CheckIcon sx={{ fontSize: 13 }} />
    ) : status === 'error' ? (
      <ErrorOutlineIcon sx={{ fontSize: 13 }} />
    ) : (
      <ContentCopyIcon sx={{ fontSize: 13 }} />
    );
  return (
    <Box
      role="row"
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
      data-coordinate-row={format}
    >
      <Typography
        role="rowheader"
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
        data-coordinate-label={format}
      >
        {label}
      </Typography>
      <Typography
        role="cell"
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
        data-wgs84-text={format === 'wgs84' ? displayValue : undefined}
        data-mgrs-text={format === 'mgrs' ? displayValue : undefined}
        style={{ flex: '1 1 auto', minWidth: 0 }}
      >
        {displayValue}
      </Typography>
      <span role="cell" style={{ flex: `0 0 ${COORDINATE_COPY_SIZE}px`, marginLeft: '4px' }}>
        <IconButton
          aria-label={copyButtonTitle}
          title={copyButtonTitle}
          data-copy-status={status}
          size="small"
          disabled={value == null || status === 'copying'}
          onClick={(event) => {
            event.stopPropagation();
            onCopy(format, value == null ? null : displayValue);
          }}
          sx={{
            width: COORDINATE_COPY_SIZE,
            height: COORDINATE_COPY_SIZE,
            borderRadius: 1,
            color:
              status === 'copied'
                ? 'success.main'
                : status === 'error'
                  ? 'error.main'
                  : 'text.secondary',
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          }}
          style={{ backgroundColor: 'transparent' }}
        >
          {copyButtonIcon}
        </IconButton>
      </span>
    </Box>
  );
}
