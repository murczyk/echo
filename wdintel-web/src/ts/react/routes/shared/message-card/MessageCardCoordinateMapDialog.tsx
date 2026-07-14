import 'leaflet/dist/leaflet.css';

import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import {
  Box,
  Button,
  CircularProgress,
  DialogActions,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import * as L from 'leaflet';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import type { CoordinatePreviewResult } from './message-coordinate-preview';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';
import {
  blurActivePreviewDialogElement,
  getMessageCardPreviewActionBarSx,
  getMessageCardPreviewStageSx,
} from './message-card-preview-shell';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';
type MapInitState = 'loading' | 'ready' | 'error';

type Props = {
  coordinate: CoordinatePreviewResult['point'];
  open: boolean;
  onClose: () => void;
};

const PREVIEW_ZOOM = 13;
const MAP_INIT_TIMEOUT_MS = 2000;
const MAP_HOST_MIN_SIZE_PX = 48;

export function MessageCardCoordinateMapDialog({ coordinate, open, onClose }: Props) {
  const theme = useTheme();
  const [mapHostEl, setMapHostEl] = useState<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const layerRef = useRef<L.TileLayer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const initFrameRef = useRef<number | null>(null);
  const invalidateFrameRef = useRef<number | null>(null);
  const initTimeoutRef = useRef<number | null>(null);
  const baseLayerIdRef = useRef<BaseLayerId>('googleHybrid');
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>('googleHybrid');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mapInitState, setMapInitState] = useState<MapInitState>('loading');
  const [retryToken, setRetryToken] = useState(0);
  const previewConfig = getMessageCardPreviewShellConfig('coordinate-map');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;

  useEffect(() => {
    baseLayerIdRef.current = baseLayerId;
  }, [baseLayerId]);

  useEffect(() => {
    if (!open) {
      setBaseLayerId('googleHybrid');
      setIsFullscreen(false);
      setMapInitState('loading');
      return;
    }

    setBaseLayerId('googleHybrid');
    setIsFullscreen(false);
    setMapInitState('loading');
  }, [open, coordinate.lat, coordinate.lng]);

  useEffect(() => {
    if (!open || mapRef.current == null) {
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
  }, [baseLayerId, open]);

  useEffect(() => {
    if (!dialogIsFullscreen) {
      return;
    }

    const handleFullscreenEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setIsFullscreen(false);
    };

    window.addEventListener('keydown', handleFullscreenEscape as EventListener, true);
    return () => {
      window.removeEventListener('keydown', handleFullscreenEscape as EventListener, true);
    };
  }, [dialogIsFullscreen]);

  useEffect(() => {
    if (!open || mapRef.current == null) {
      return;
    }

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
  }, [dialogIsFullscreen, open]);

  useEffect(() => {
    if (!open || mapHostEl == null) {
      if (!open) {
        if (initFrameRef.current !== null) {
          window.cancelAnimationFrame(initFrameRef.current);
          initFrameRef.current = null;
        }
        if (initTimeoutRef.current !== null) {
          window.clearTimeout(initTimeoutRef.current);
          initTimeoutRef.current = null;
        }
        markerRef.current?.remove();
        markerRef.current = null;
        layerRef.current?.remove();
        layerRef.current = null;
        tileLayersRef.current = null;
        mapRef.current?.remove();
        mapRef.current = null;
      }
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
        mapRef.current?.invalidateSize();
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

      const map = L.map(currentHost, {
        zoomControl: true,
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
      }).setView([coordinate.lat, coordinate.lng], PREVIEW_ZOOM);

      const tileLayers = getTileLayers();
      tileLayersRef.current = tileLayers;
      const baseLayer =
        baseLayerIdRef.current === 'googleHybrid'
          ? tileLayers.googleHybrid
          : tileLayers.openStreetMap;
      baseLayer.addTo(map);

      const marker = L.circleMarker([coordinate.lat, coordinate.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#ff4d2d',
        fillOpacity: 1,
      }).addTo(map);

      mapRef.current = map;
      markerRef.current = marker;
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
      markerRef.current?.remove();
      markerRef.current = null;
      layerRef.current?.remove();
      layerRef.current = null;
      tileLayersRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [coordinate.lat, coordinate.lng, mapHostEl, open, retryToken]);

  const handleClose = useCallback(() => {
    blurActivePreviewDialogElement();
    onClose();
  }, [onClose]);

  const handleShellClose = useCallback(() => {
    handleClose();
  }, [handleClose]);

  const handleRetry = useCallback(() => {
    setMapInitState('loading');
    setRetryToken((value) => value + 1);
  }, []);

  return (
    <MessageCardPreviewShell
      open={open}
      isFullscreen={dialogIsFullscreen}
      ariaLabel="Карта координат"
      onClose={handleShellClose}
      config={previewConfig}
      stage={
        <Box
          sx={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            borderRadius: dialogIsFullscreen ? 0 : 1.5,
            backgroundColor: 'background.paper',
            ...getMessageCardPreviewStageSx(theme, dialogIsFullscreen),
          }}
        >
          <Box
            ref={setMapHostEl}
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
                    bgcolor: 'rgba(10, 13, 18, 0.72)',
                    color: 'common.white',
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
                    bgcolor: 'rgba(10, 13, 18, 0.78)',
                    color: 'common.white',
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    Не вдалося відкрити мапу
                  </Typography>
                  <Button
                    aria-label="Повторити"
                    size="small"
                    variant="contained"
                    onClick={handleRetry}
                  >
                    Повторити
                  </Button>
                </Box>
              )}
            </Box>
          )}
          <Box
            style={{
              right: '12px',
              top: '12px',
              zIndex: 1200,
              pointerEvents: 'none',
            }}
            sx={{
              position: 'absolute',
              right: 12,
              left: 'auto',
              top: 12,
              zIndex: 1200,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'flex-end',
              gap: 1,
              pointerEvents: 'none',
            }}
          >
            <Typography
              variant="caption"
              sx={{
                px: 1,
                py: 0.5,
                borderRadius: 1.5,
                bgcolor: 'rgba(10, 13, 18, 0.72)',
                color: 'common.white',
                fontWeight: 700,
                lineHeight: 1.2,
                backdropFilter: 'blur(6px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 'min(100%, calc(100vw - 120px))',
              }}
            >
              {coordinate.label}
            </Typography>
          </Box>
        </Box>
      }
      controls={
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            width: '100%',
            px: 3,
            py: 1.5,
            backgroundColor: 'background.paper',
          }}
        >
          <ToggleButtonGroup
            exclusive
            size="small"
            value={baseLayerId}
            onChange={(_, nextLayerId: BaseLayerId | null) => {
              if (nextLayerId != null) {
                setBaseLayerId(nextLayerId);
              }
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 0.5,
              backgroundColor: 'background.paper',
              '& .MuiToggleButtonGroup-grouped': {
                border: 0,
                borderRadius: 1.5,
                minWidth: 30,
                width: 30,
                height: 30,
                padding: 0,
                color: 'text.secondary',
                backgroundColor: 'transparent',
                '&:hover': {
                  backgroundColor: 'action.hover',
                },
                '&.Mui-selected': {
                  color: 'primary.main',
                  backgroundColor: 'action.selected',
                },
                '&.Mui-selected:hover': {
                  backgroundColor: 'action.selected',
                },
              },
            }}
          >
            <Tooltip title="Супутник" enterDelay={300}>
              <ToggleButton aria-label="Супутник" value="googleHybrid">
                <LayersOutlinedIcon fontSize="small" />
              </ToggleButton>
            </Tooltip>
            <Tooltip title="OpenStreetMap" enterDelay={300}>
              <ToggleButton aria-label="OpenStreetMap" value="openStreetMap">
                <MapOutlinedIcon fontSize="small" />
              </ToggleButton>
            </Tooltip>
          </ToggleButtonGroup>
          {canFullscreen ? (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                ml: 0.5,
                pl: 0.5,
                borderLeft: 1,
                borderColor: 'divider',
              }}
            >
              <Tooltip
                title={dialogIsFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
                enterDelay={300}
              >
                <IconButton
                  aria-label={
                    dialogIsFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'
                  }
                  size="small"
                  onClick={() => setIsFullscreen((current) => !current)}
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {dialogIsFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
                </IconButton>
              </Tooltip>
            </Box>
          ) : null}
        </Box>
      }
      actions={
        <DialogActions sx={getMessageCardPreviewActionBarSx(theme)}>
          <Box />
          <Box />
          <Box sx={{ justifySelf: 'end' }}>
            <Button aria-label="Закрити" onClick={handleClose} sx={{ flexShrink: 0, ml: 1 }}>
              Закрити
            </Button>
          </Box>
        </DialogActions>
      }
    />
  );
}
