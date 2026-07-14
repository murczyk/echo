import 'leaflet/dist/leaflet.css';

import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import {
  Box,
  Button,
  ButtonGroup,
  DialogActions,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import * as L from 'leaflet';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

type Props = {
  coordinate: CoordinatePreviewResult['point'];
  open: boolean;
  onClose: () => void;
};

const PREVIEW_ZOOM = 13;

export function MessageCardCoordinateMapDialog({ coordinate, open, onClose }: Props) {
  const theme = useTheme();
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const layerRef = useRef<L.TileLayer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const initFrameRef = useRef<number | null>(null);
  const invalidateFrameRef = useRef<number | null>(null);
  const previousFullscreenRef = useRef<boolean | null>(null);
  const initialLayerIdRef = useRef<BaseLayerId>('googleHybrid');
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>('googleHybrid');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewConfig = getMessageCardPreviewShellConfig('coordinate-map');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;

  useEffect(() => {
    if (!open) {
      setBaseLayerId('googleHybrid');
      setIsFullscreen(false);
      return;
    }

    initialLayerIdRef.current = 'googleHybrid';
    setBaseLayerId('googleHybrid');
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
    if (!open || mapRef.current == null) {
      if (!open) {
        previousFullscreenRef.current = null;
      }
      return;
    }

    if (previousFullscreenRef.current === null) {
      previousFullscreenRef.current = dialogIsFullscreen;
      return;
    }

    if (previousFullscreenRef.current === dialogIsFullscreen) {
      return;
    }

    previousFullscreenRef.current = dialogIsFullscreen;

    if (invalidateFrameRef.current !== null) {
      window.cancelAnimationFrame(invalidateFrameRef.current);
      invalidateFrameRef.current = null;
    }

    invalidateFrameRef.current = window.requestAnimationFrame(() => {
      mapRef.current?.invalidateSize();
      invalidateFrameRef.current = null;
    });

    return () => {
      if (invalidateFrameRef.current !== null) {
        window.cancelAnimationFrame(invalidateFrameRef.current);
        invalidateFrameRef.current = null;
      }
    };
  }, [dialogIsFullscreen, open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const container = mapContainerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    const initMap = () => {
      if (cancelled || mapRef.current || mapContainerRef.current !== container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        initFrameRef.current = window.requestAnimationFrame(initMap);
        return;
      }

      const map = L.map(container, {
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
        initialLayerIdRef.current === 'googleHybrid'
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

      invalidateFrameRef.current = window.requestAnimationFrame(() => {
        if (!cancelled) {
          map.invalidateSize();
        }
      });
    };

    initFrameRef.current = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      if (initFrameRef.current !== null) {
        window.cancelAnimationFrame(initFrameRef.current);
        initFrameRef.current = null;
      }
      if (invalidateFrameRef.current !== null) {
        window.cancelAnimationFrame(invalidateFrameRef.current);
        invalidateFrameRef.current = null;
      }
      markerRef.current?.remove();
      markerRef.current = null;
      layerRef.current?.remove();
      layerRef.current = null;
      tileLayersRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [coordinate.lat, coordinate.lng, open]);

  const handleClose = useCallback(() => {
    blurActivePreviewDialogElement();
    onClose();
  }, [onClose]);

  const handleShellClose = useCallback(() => {
    handleClose();
  }, [handleClose]);

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
            ref={mapContainerRef}
            sx={{
              position: 'absolute',
              inset: 0,
              '& .leaflet-container': {
                width: '100%',
                height: '100%',
              },
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              left: 12,
              right: 12,
              top: 12,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
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
                maxWidth: '100%',
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
            px: 2,
            pt: 1.5,
            pb: 0.5,
          }}
        >
          <ButtonGroup size="small" variant="outlined">
            <Button
              onClick={() => setBaseLayerId('googleHybrid')}
              variant={baseLayerId === 'googleHybrid' ? 'contained' : 'outlined'}
            >
              Супутник
            </Button>
            <Button
              onClick={() => setBaseLayerId('openStreetMap')}
              variant={baseLayerId === 'openStreetMap' ? 'contained' : 'outlined'}
            >
              OpenStreetMap
            </Button>
          </ButtonGroup>
        </Box>
      }
      actions={
        <DialogActions sx={getMessageCardPreviewActionBarSx(theme)}>
          <Box />
          <Box sx={{ justifySelf: 'center' }}>
            {canFullscreen ? (
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
                  sx={{ color: 'text.secondary' }}
                >
                  {dialogIsFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
                </IconButton>
              </Tooltip>
            ) : null}
          </Box>
          <Box sx={{ justifySelf: 'end' }}>
            <Button onClick={handleClose} variant="contained">
              Закрити
            </Button>
          </Box>
        </DialogActions>
      }
    />
  );
}
