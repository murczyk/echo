import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, Typography } from '@mui/material';
import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { createMapWindowControl, type MapWindowControl } from '../../../../maps/control-modules';
import { PalitraCacheManager } from '../../../../maps/palitra-cache-manager';
import { PalitraPointClusterRenderer } from '../../../../maps/palitra-point-cluster-renderer';
import { PalitraPointsController } from '../../../../maps/palitra-points-controller';
import type { PalitraDetails } from '../../../../maps/palitra-types';
import '../../../analysis-map-window-control-element';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import { addPreviewGeometryLayers, fitGeometryLayers } from './PalitraPreviewDialog.layers';
import { toPreviewPalitras, hasRenderableGeometry } from './PalitraPreviewDialog.data';
import { createPreviewPointStack, destroyPreviewPointStack } from './PalitraPreviewDialog.points';
import { getPreviewShellSx } from './PalitraPreviewDialog.styles';
import { DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM, NOOP_CALLBACKS, PREVIEW_MAX_ZOOM, PREVIEW_POINT_OPTIONS } from './PalitraPreviewDialog.types';
import type { PalitraPreviewDialogProps } from './PalitraPreviewDialog.types';

export function PalitraPreviewDialog({ open, palitra, preview, loading, error, onClose }: PalitraPreviewDialogProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.FeatureGroup | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initRafRef = useRef<number | null>(null);
  const listenersRef = useRef<{ onViewportChanged: (() => void) | null }>({ onViewportChanged: null });
  const previewPalitrasRef = useRef<PalitraDetails[]>([]);
  const cacheManagerRef = useRef<PalitraCacheManager | null>(null);
  const pointClustersRendererRef = useRef<PalitraPointClusterRenderer | null>(null);
  const pointsControllerRef = useRef<PalitraPointsController | null>(null);
  const mapWindowControlRef = useRef<MapWindowControl | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapVisible, setMapVisible] = useState(false);
  const [previewRenderReady, setPreviewRenderReady] = useState(false);
  const previewPalitras = useMemo(() => toPreviewPalitras(preview), [preview]);
  const hasRenderablePreviewGeometry = previewPalitras.some((entry) => hasRenderableGeometry(entry.palitra.geometry));
  const hasRenderablePreviewGeometryRef = useRef(hasRenderablePreviewGeometry);
  const previewRenderReadyRef = useRef(previewRenderReady);
  const hasPreviewError = Boolean(error);
  const showPreviewLoading =
    !hasPreviewError &&
    (loading || !preview || !mapReady || (hasRenderablePreviewGeometry && !previewRenderReady));

  useEffect(() => {
    hasRenderablePreviewGeometryRef.current = hasRenderablePreviewGeometry;
  }, [hasRenderablePreviewGeometry]);

  useEffect(() => {
    previewRenderReadyRef.current = previewRenderReady;
  }, [previewRenderReady]);

  useLayoutEffect(() => {
    setPreviewRenderReady(false);
  }, [open, loading, preview]);

  useLayoutEffect(() => {
    if (!open || !mapVisible) {
      return;
    }

    const container = mapContainerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;

    const initMap = () => {
      if (cancelled) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        initRafRef.current = window.requestAnimationFrame(initMap);
        return;
      }

      const map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        touchZoom: true,
        boxZoom: true,
        keyboard: false,
        minZoom: 2,
        maxZoom: PREVIEW_MAX_ZOOM,
      }).setView(DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM);

      getTileLayers().openStreetMap.addTo(map);

      const mapWindowControl = createMapWindowControl(() => {
        return undefined;
      }, false, { showFullscreen: false });
      map.addControl(mapWindowControl);

      const layerGroup = L.featureGroup().addTo(map);
      mapRef.current = map;
      layerGroupRef.current = layerGroup;
      mapWindowControlRef.current = mapWindowControl;
      setMapReady(true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserverRef.current = new ResizeObserver(() => {
          map.invalidateSize();
          if (previewRenderReadyRef.current && hasRenderablePreviewGeometryRef.current) {
            fitGeometryLayers(map, layerGroup);
            pointsControllerRef.current?.onViewportChanged();
          }
        });
        resizeObserverRef.current.observe(container);
      }

      window.requestAnimationFrame(() => {
        if (!cancelled) {
          map.invalidateSize();
        }
      });
    };

    initRafRef.current = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      if (initRafRef.current !== null) {
        window.cancelAnimationFrame(initRafRef.current);
        initRafRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      destroyPreviewPointStack(mapRef.current, {
        listenersRef,
        stateRef: previewPalitrasRef,
        cacheManagerRef,
        pointClustersRendererRef,
        pointsControllerRef,
      });
      if (mapRef.current && mapWindowControlRef.current) {
        mapRef.current.removeControl(mapWindowControlRef.current);
      }
      mapWindowControlRef.current = null;
      layerGroupRef.current?.clearLayers();
      layerGroupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [mapVisible, open]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!open || !mapVisible || !mapReady || !map || !layerGroup) {
      return;
    }

    destroyPreviewPointStack(map, {
      listenersRef,
      stateRef: previewPalitrasRef,
      cacheManagerRef,
      pointClustersRendererRef,
      pointsControllerRef,
    });
    layerGroup.clearLayers();

    if (!hasRenderablePreviewGeometry) {
      setPreviewRenderReady(false);
      return;
    }

    addPreviewGeometryLayers(layerGroup, previewPalitras);

    fitGeometryLayers(map, layerGroup);
    createPreviewPointStack(
      map,
      previewPalitras,
      PREVIEW_POINT_OPTIONS,
      NOOP_CALLBACKS,
      {
        listenersRef,
        stateRef: previewPalitrasRef,
        cacheManagerRef,
        pointClustersRendererRef,
        pointsControllerRef,
      },
    );
    previewRenderReadyRef.current = true;
    setPreviewRenderReady(true);
  }, [open, mapReady, mapVisible, previewPalitras, hasRenderablePreviewGeometry]);

  useEffect(() => {
    if (!open) {
      setMapVisible(false);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth='lg'
      PaperProps={{
        sx: {
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
      disableRestoreFocus
      TransitionProps={{
        onEntered: () => setMapVisible(true),
        onExited: () => setMapVisible(false),
      }}
      aria-label={palitra?.name ? 'Попередній перегляд палітри ' + palitra.name : 'Попередній перегляд палітри'}
    >
      <DialogContent
        sx={{
          px: 3,
          pt: 3,
          pb: 0,
          overflow: 'hidden',
          display: 'flex',
          flex: 1,
          minHeight: 0,
        }}
      >
        <Box
          ref={mapContainerRef}
          className='palitra-map-surface'
          sx={{
            ...getPreviewShellSx(),
            flex: '1 1 auto',
          }}
        >
          {showPreviewLoading ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'background.paper',
                zIndex: 1000,
              }}
            >
              <CircularProgress />
            </Box>
          ) : null}
          {hasPreviewError ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: 3,
                zIndex: 1001,
                bgcolor: 'background.paper',
              }}
            >
              <PowerAlert severity='error' autoHideDuration={null} dismissible={false} sx={{ width: '100%', maxWidth: 560 }}>
                <Typography variant='h6' sx={{ mb: 1 }}>
                  Не вдалося завантажити попередній перегляд палітри
                </Typography>
                <Typography variant='body1' sx={{ lineHeight: 1.6 }}>
                  {error}
                </Typography>
              </PowerAlert>
            </Box>
          ) : null}
          {!loading && preview && mapReady && !hasRenderablePreviewGeometry ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: 3,
                textAlign: 'center',
                color: 'text.secondary',
                zIndex: 1001,
                pointerEvents: 'none',
                bgcolor: 'background.paper',
              }}
            >
              <Typography variant='body1'>Для цієї палітри немає геометрій для попереднього перегляду.</Typography>
            </Box>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}
