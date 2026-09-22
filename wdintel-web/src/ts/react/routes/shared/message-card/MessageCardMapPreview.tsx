import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import * as L from 'leaflet';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { BaseLayerId } from '../../../../maps/base-layers';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import { getAttachmentPreviewStageSx } from './attachment-preview/message-card-attachment-preview';

type MapInitState = 'loading' | 'ready' | 'error';

const MAP_INIT_TIMEOUT_MS = 2_000;
const MAP_HOST_MIN_SIZE_PX = 48;

export function MessageCardMapPreview({
  baseLayerId,
  className,
  dataAttributes,
  onMapReady,
  onMapResize,
  children,
}: {
  baseLayerId: BaseLayerId;
  className?: string;
  dataAttributes?: Record<`data-${string}`, string | number>;
  onMapReady: (map: L.Map) => void | (() => void);
  onMapResize?: (map: L.Map) => void;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const [mapHostEl, setMapHostEl] = useState<HTMLDivElement | null>(null);
  const [mapInitState, setMapInitState] = useState<MapInitState>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.Layer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const baseLayerIdRef = useRef(baseLayerId);
  const initializeFrameRef = useRef<number | null>(null);
  const invalidateFrameRef = useRef<number | null>(null);
  const initializeTimeoutRef = useRef<number | null>(null);
  const onMapReadyRef = useRef(onMapReady);
  const onMapResizeRef = useRef(onMapResize);
  onMapReadyRef.current = onMapReady;
  onMapResizeRef.current = onMapResize;
  baseLayerIdRef.current = baseLayerId;

  useEffect(() => {
    const map = mapRef.current;
    const tileLayers = tileLayersRef.current;
    if (map == null || tileLayers == null) return;

    const nextLayer = tileLayers[baseLayerId];
    if (layerRef.current === nextLayer) return;

    layerRef.current?.remove();
    nextLayer.addTo(map);
    layerRef.current = nextLayer;
  }, [baseLayerId]);

  useEffect(() => {
    if (mapHostEl == null) return;

    let cancelled = false;
    let mapCleanup: (() => void) | void;
    const currentHost = mapHostEl;

    const clearPendingInvalidate = () => {
      if (invalidateFrameRef.current === null) return;
      window.cancelAnimationFrame(invalidateFrameRef.current);
      invalidateFrameRef.current = null;
    };

    const scheduleInvalidate = () => {
      if (invalidateFrameRef.current !== null || cancelled || mapRef.current == null) return;

      invalidateFrameRef.current = window.requestAnimationFrame(() => {
        invalidateFrameRef.current = null;
        const map = mapRef.current;
        if (map == null) return;
        map.invalidateSize({ animate: false, pan: false });
        onMapResizeRef.current?.(map);
      });
    };

    const initializeMap = () => {
      if (cancelled || mapRef.current != null || mapHostEl !== currentHost) return false;
      if (!currentHost.isConnected) return false;

      const rect = currentHost.getBoundingClientRect();
      if (rect.width < MAP_HOST_MIN_SIZE_PX || rect.height < MAP_HOST_MIN_SIZE_PX) return false;

      try {
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
        L.control?.zoom?.({ position: 'bottomright' })?.addTo?.(map);

        const tileLayers = getTileLayers();
        const baseLayer = tileLayers[baseLayerIdRef.current];
        baseLayer.addTo(map);
        mapRef.current = map;
        tileLayersRef.current = tileLayers;
        layerRef.current = baseLayer;
        mapCleanup = onMapReadyRef.current(map);
        setMapInitState('ready');
        scheduleInvalidate();
        return true;
      } catch {
        mapCleanup?.();
        mapCleanup = undefined;
        layerRef.current?.remove();
        layerRef.current = null;
        tileLayersRef.current = null;
        mapRef.current?.remove();
        mapRef.current = null;
        setMapInitState('error');
        return false;
      }
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (cancelled) return;
            if (mapRef.current == null) {
              initializeMap();
              return;
            }
            scheduleInvalidate();
          });

    resizeObserver?.observe(currentHost);
    initializeTimeoutRef.current = window.setTimeout(() => {
      if (!cancelled && mapRef.current == null) setMapInitState('error');
    }, MAP_INIT_TIMEOUT_MS);
    initializeFrameRef.current = window.requestAnimationFrame(() => {
      initializeFrameRef.current = null;
      initializeMap();
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (initializeFrameRef.current !== null) {
        window.cancelAnimationFrame(initializeFrameRef.current);
        initializeFrameRef.current = null;
      }
      if (initializeTimeoutRef.current !== null) {
        window.clearTimeout(initializeTimeoutRef.current);
        initializeTimeoutRef.current = null;
      }
      clearPendingInvalidate();
      mapCleanup?.();
      layerRef.current?.remove();
      layerRef.current = null;
      tileLayersRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapHostEl, retryToken]);

  const panelBackground =
    theme.palette.mode === 'dark' ? 'rgba(31, 36, 42, 0.96)' : 'rgba(255, 255, 255, 0.95)';

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
        className={className}
        {...dataAttributes}
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
      {children}
    </Box>
  );
}
