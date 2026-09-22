import { Box, Button, IconButton, Typography } from '@mui/material';
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
import {
  getCoordinateMgrsText,
  getCoordinateTextIfAvailable,
} from '../../../../../maps/coordinate-format';
import { formatCoordinateLocality } from '../../../../../maps/coordinate-locality';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { MessageCardMapPreview } from '../MessageCardMapPreview';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { CoordinatePreviewPoint } from '../message-coordinate-preview';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';

const PREVIEW_ZOOM = 13;
const PREVIEW_MAX_ZOOM = 13;
const PREVIEW_BOUNDS_PADDING: [number, number] = [80, 80];
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

function PalitraPointContext({ point }: { point: CoordinatePreviewPoint }) {
  if (point.source !== 'palitra') return null;
  return (
    <Typography
      variant="subtitle2"
      data-coordinate-palitra-identity="true"
      sx={{ maxWidth: '100%', overflowWrap: 'anywhere', color: 'text.primary' }}
      style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}
    >
      {point.label}
    </Typography>
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
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<L.CircleMarker[]>([]);
  const pointsRef = useRef(points);
  const activeIndexRef = useRef(activeIndex);
  const previousActiveIndexRef = useRef(activeIndex);
  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  const invalidateFrameRef = useRef<number | null>(null);
  const copyResetTimeoutsRef = useRef<Partial<Record<CoordinateFormat, number>>>({});
  const copyGenerationRef = useRef(0);
  const copyRequestIdsRef = useRef<Partial<Record<CoordinateFormat, number>>>({});
  const [copyStatuses, setCopyStatuses] =
    useState<Record<CoordinateFormat, CopyStatus>>(INITIAL_COPY_STATUSES);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

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

  const initializeCoordinateMap = useCallback((map: L.Map) => {
    const visiblePoints = pointsRef.current;
    const currentPoint = visiblePoints[activeIndexRef.current] ?? visiblePoints[0];
    if (currentPoint == null) return;

    mapRef.current = map;
    map.on('click', () => setIsPanelOpen(false));
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

    markerRefs.current = visiblePoints.map(({ lat, lng }, index) => {
      const marker = L.circleMarker([lat, lng], {
        radius: index === activeIndexRef.current ? 10 : 8,
        color: '#ffffff',
        weight: 3,
        fillColor: index === activeIndexRef.current ? '#1976d2' : '#ff4d2d',
        fillOpacity: 1,
        interactive: true,
        bubblingMouseEvents: false,
      });
      const mgrsText = getCoordinateMgrsText({ lat, lng });
      if (mgrsText != null) {
        const label = document.createElement('span');
        label.textContent = mgrsText;
        marker.bindTooltip(label, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          opacity: 1,
          className: 'coordinate-preview-mgrs-label',
          interactive: false,
        });
      }
      marker.addTo(map);
      marker.on('click', () => {
        map.setView([lat, lng], map.getZoom());
        setIsPanelOpen(true);
        onActiveIndexChangeRef.current(index);
      });
      return marker;
    });

    return () => {
      if (invalidateFrameRef.current !== null) {
        window.cancelAnimationFrame(invalidateFrameRef.current);
        invalidateFrameRef.current = null;
      }
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      mapRef.current = null;
    };
  }, []);

  const resizeCoordinateMap = useCallback((map: L.Map) => {
    const latLngs = pointsRef.current.map(({ lat, lng }): [number, number] => [lat, lng]);
    if (latLngs.length > 1) {
      map.fitBounds(L.latLngBounds(latLngs), {
        animate: false,
        maxZoom: PREVIEW_MAX_ZOOM,
        padding: PREVIEW_BOUNDS_PADDING,
      });
    }
  }, []);

  const point = points[activeIndex] ?? points[0];
  if (point == null) {
    return null;
  }
  const mgrsText = getCoordinateMgrsText({ lat: point.lat, lng: point.lng });
  const wgs84Text = `${renderWgsFloat(point.lat)}, ${renderWgsFloat(point.lng)}`;
  const dmsText = getCoordinateTextIfAvailable('dms', point);
  const sk42Text = getCoordinateTextIfAvailable('sk42', point);
  const usk2000Text = getCoordinateTextIfAvailable('usk2000', point);
  const utmText = getCoordinateTextIfAvailable('utm', point);
  const coordinateRows: CoordinateRow[] = [
    { id: 'wgs84', label: 'WGS84', value: wgs84Text },
    { id: 'mgrs', label: 'MGRS', value: mgrsText },
    { id: 'dms', label: 'DMS', value: dmsText },
    { id: 'sk42', label: 'СК-42', value: sk42Text },
    { id: 'usk2000', label: 'УСК-2000', value: usk2000Text },
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
    <MessageCardMapPreview
      baseLayerId={baseLayerId}
      className="coordinate-fullscreen-map"
      dataAttributes={{ 'data-coordinate-marker-count': points.length }}
      onMapReady={initializeCoordinateMap}
      onMapResize={resizeCoordinateMap}
    >
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
          <PalitraPointContext point={point} />
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
    </MessageCardMapPreview>
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
  const displayValue = value == null ? 'Недоступно' : value.replace(`${label}: `, '');
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
            onCopy(format, value);
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
