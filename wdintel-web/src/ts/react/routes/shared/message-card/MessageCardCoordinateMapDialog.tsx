import 'leaflet/dist/leaflet.css';

import {
  Box,
  Button,
  ButtonGroup,
  Dialog,
  DialogActions,
  DialogContent,
  Typography,
} from '@mui/material';
import * as L from 'leaflet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import type { CoordinatePreviewResult } from './message-coordinate-preview';
import {
  blurActivePreviewDialogElement,
  getMessageCardPreviewDialogPaperSx,
} from './message-card-preview-shell';

type BaseLayerId = 'googleHybrid' | 'openStreetMap';

type Props = {
  coordinate: CoordinatePreviewResult['point'];
  open: boolean;
  onClose: () => void;
};

const PREVIEW_ZOOM = 13;

export function MessageCardCoordinateMapDialog({ coordinate, open, onClose }: Props) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const layerRef = useRef<L.TileLayer | null>(null);
  const tileLayersRef = useRef<ReturnType<typeof getTileLayers> | null>(null);
  const initFrameRef = useRef<number | null>(null);
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>('googleHybrid');

  useEffect(() => {
    if (open) {
      setBaseLayerId('googleHybrid');
    }
  }, [coordinate.lat, coordinate.lng, open]);

  useEffect(() => {
    if (!open) {
      setBaseLayerId('googleHybrid');
    }
  }, [open]);

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
        baseLayerId === 'googleHybrid' ? tileLayers.googleHybrid : tileLayers.openStreetMap;
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

      window.requestAnimationFrame(() => {
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
      markerRef.current?.remove();
      markerRef.current = null;
      layerRef.current?.remove();
      layerRef.current = null;
      tileLayersRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [coordinate.lat, coordinate.lng, open]);

  const closeDialog = () => {
    blurActivePreviewDialogElement();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      fullWidth
      maxWidth={false}
      disableRestoreFocus
      PaperProps={{
        sx: {
          width: 'min(94vw, 1280px)',
          height: '92svh',
          m: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          ...getMessageCardPreviewDialogPaperSx(false),
        },
      }}
      aria-label="Карта координат"
    >
      <DialogContent
        sx={{
          p: 0,
          flex: '1 1 auto',
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
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
              justifyContent: 'space-between',
              alignItems: 'flex-start',
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
              }}
            >
              {coordinate.label}
            </Typography>
            <ButtonGroup size="small" variant="outlined" sx={{ pointerEvents: 'auto' }}>
              <Button
                onClick={() => setBaseLayerId('openStreetMap')}
                variant={baseLayerId === 'openStreetMap' ? 'contained' : 'outlined'}
              >
                OSM
              </Button>
              <Button
                onClick={() => setBaseLayerId('googleHybrid')}
                variant={baseLayerId === 'googleHybrid' ? 'contained' : 'outlined'}
              >
                Hybrid
              </Button>
            </ButtonGroup>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={closeDialog} variant="contained">
          Закрити
        </Button>
      </DialogActions>
    </Dialog>
  );
}
