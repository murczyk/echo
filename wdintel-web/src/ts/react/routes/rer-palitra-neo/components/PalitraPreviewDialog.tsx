import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Palitra, PalitraGeometryDetails, PalitraReadV2 } from '../../../../../Bindings';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, Typography } from '@mui/material';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';

type Props = {
  open: boolean;
  palitra: Palitra | null;
  preview: PalitraReadV2 | null;
  loading: boolean;
  onClose: () => void;
};

const DEFAULT_PREVIEW_CENTER: [number, number] = [49, 32];
const DEFAULT_PREVIEW_ZOOM = 6;
const PREVIEW_MAX_ZOOM = 15;

function toLatLng(coords: { lat: number; lng: number }): L.LatLngExpression {
  return [coords.lat, coords.lng];
}

function createPolygonLayer(geometry: PalitraGeometryDetails) {
  const perimeter = geometry.geometry?.perimeterLinearRing;
  if (!Array.isArray(perimeter) || perimeter.length < 3) return null;

  return L.polygon(perimeter.map(toLatLng), {
    interactive: false,
    color: geometry.colorHex,
    weight: 2,
    fillColor: geometry.colorHex,
    fillOpacity: 0.14,
    lineJoin: 'round',
    lineCap: 'round',
  });
}

function createPolylineLayers(geometry: PalitraGeometryDetails) {
  const lineStrings = geometry.geometry?.lineStrings;
  if (!Array.isArray(lineStrings) || lineStrings.length === 0) return [];

  return lineStrings
    .filter((lineString) => Array.isArray(lineString) && lineString.length >= 2)
    .map((lineString) =>
      L.polyline((lineString as Array<{ lat: number; lng: number }>).map(toLatLng), {
        interactive: false,
        color: geometry.colorHex,
        weight: 2,
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
      }),
    );
}

function createCenterLayer(geometry: PalitraGeometryDetails) {
  const center = geometry.geometry?.center;
  if (!center) return null;

  return L.circleMarker(toLatLng(center), {
    interactive: false,
    radius: 4,
    color: geometry.colorHex,
    weight: 1,
    fillColor: geometry.colorHex,
    fillOpacity: 1,
  });
}

function hasRenderableGeometry(geometry: PalitraGeometryDetails): boolean {
  const perimeter = geometry.geometry?.perimeterLinearRing;
  if (Array.isArray(perimeter) && perimeter.length >= 3) return true;

  const lineStrings = geometry.geometry?.lineStrings;
  if (Array.isArray(lineStrings) && lineStrings.some((lineString) => Array.isArray(lineString) && lineString.length >= 2)) return true;

  return Boolean(geometry.geometry?.center);
}

function fitGeometryLayers(map: L.Map, layerGroup: L.FeatureGroup) {
  const bounds = layerGroup.getBounds();
  if (!bounds.isValid()) {
    map.setView(DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM, { animate: false });
    return;
  }

  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(bounds.getCenter(), PREVIEW_MAX_ZOOM, { animate: false });
    return;
  }

  map.fitBounds(bounds.pad(0.14), {
    animate: false,
    maxZoom: PREVIEW_MAX_ZOOM,
  });
}

function getPreviewShellSx() {
  return {
    position: 'relative',
    width: '100%',
    height: 'min(72vh, 760px)',
    minHeight: { xs: 360, sm: 480 },
    overflow: 'hidden',
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: 2,
    bgcolor: 'background.paper',
    '& .leaflet-container': {
      bgcolor: 'background.paper',
    },
  };
}

export function PalitraPreviewDialog({ open, palitra, preview, loading, onClose }: Props) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.FeatureGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initRafRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapVisible, setMapVisible] = useState(false);
  const [previewRenderReady, setPreviewRenderReady] = useState(false);
  const [tileLoadState, setTileLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const hasRenderablePreviewGeometry = (preview?.geometries ?? []).some(hasRenderableGeometry);
  const previewReadyToShow =
    Boolean(preview) &&
    mapReady &&
    mapVisible &&
    previewRenderReady &&
    tileLoadState !== 'loading';
  const hasRenderablePreviewGeometryRef = useRef(hasRenderablePreviewGeometry);
  const previewRenderReadyRef = useRef(previewRenderReady);
  const tileLoadStateRef = useRef(tileLoadState);

  useEffect(() => {
    hasRenderablePreviewGeometryRef.current = hasRenderablePreviewGeometry;
  }, [hasRenderablePreviewGeometry]);

  useEffect(() => {
    previewRenderReadyRef.current = previewRenderReady;
  }, [previewRenderReady]);

  useEffect(() => {
    tileLoadStateRef.current = tileLoadState;
  }, [tileLoadState]);

  useLayoutEffect(() => {
    setPreviewRenderReady(false);
  }, [open, loading, preview]);

  useEffect(() => {
    if (open) {
      setTileLoadState('loading');
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !mapVisible) return;

    const container = mapContainerRef.current;
    if (!container) return;

    let cancelled = false;

    const initMap = () => {
      if (cancelled) return;

      const rect = container.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        initRafRef.current = window.requestAnimationFrame(initMap);
        return;
      }

      const map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
        minZoom: 2,
      }).setView(DEFAULT_PREVIEW_CENTER, DEFAULT_PREVIEW_ZOOM);

      const tileLayer = getTileLayers().openStreetMap;
      tileLayer.on('load', () => setTileLoadState('loaded'));
      tileLayer.on('tileerror', () => setTileLoadState('error'));
      tileLayer.addTo(map);
      tileLayerRef.current = tileLayer;

      const layerGroup = L.featureGroup().addTo(map);
      mapRef.current = map;
      layerGroupRef.current = layerGroup;
      setMapReady(true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserverRef.current = new ResizeObserver(() => {
          map.invalidateSize();
          if (
            hasRenderablePreviewGeometryRef.current &&
            previewRenderReadyRef.current &&
            tileLoadStateRef.current !== 'loading'
          ) {
            fitGeometryLayers(map, layerGroup);
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
      layerGroupRef.current?.clearLayers();
      layerGroupRef.current = null;
      tileLayerRef.current?.off();
      tileLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [mapVisible, open]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!open || !mapVisible || !mapReady || !map || !layerGroup) return;

    layerGroup.clearLayers();

    const geometries = preview?.geometries ?? [];
    if (!hasRenderablePreviewGeometry) {
      setPreviewRenderReady(false);
      return;
    }

    for (const geometry of geometries) {
      const polygon = createPolygonLayer(geometry);
      if (polygon) {
        layerGroup.addLayer(polygon);
      }

      for (const line of createPolylineLayers(geometry)) {
        layerGroup.addLayer(line);
      }

      const center = createCenterLayer(geometry);
      if (center) {
        layerGroup.addLayer(center);
      }
    }

    setTileLoadState('loading');
    fitGeometryLayers(map, layerGroup);
    setPreviewRenderReady(true);
  }, [open, mapReady, mapVisible, preview, hasRenderablePreviewGeometry]);

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
      PaperProps={{ sx: { overflow: 'hidden' } }}
      disableRestoreFocus
      TransitionProps={{
        onEntered: () => setMapVisible(true),
        onExited: () => setMapVisible(false),
      }}
      aria-label={palitra?.name ? 'Попередній перегляд палітри ' + palitra.name : 'Попередній перегляд палітри'}
    >
      <DialogContent sx={{ px: 3, pt: 3, pb: 0, overflow: 'hidden' }}>
        <Box
          ref={mapContainerRef}
          sx={{
            ...getPreviewShellSx(),
            '& .leaflet-pane, & .leaflet-control-container': {
              opacity: previewReadyToShow ? 1 : 0,
              transition: 'opacity 140ms ease-out',
            },
          }}
        >
          {(!previewReadyToShow || loading) && (loading || !preview || !mapReady || hasRenderablePreviewGeometry) ? (
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
          {!loading && preview && mapReady && tileLoadState === 'error' ? (
            <Box
              sx={{
                position: 'absolute',
                left: 12,
                bottom: 12,
                px: 1.5,
                py: 0.75,
                borderRadius: 1.5,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                boxShadow: 3,
                zIndex: 1001,
                color: 'text.secondary',
              }}
            >
              <Typography variant='body2'>Не вдалося завантажити мапу</Typography>
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
