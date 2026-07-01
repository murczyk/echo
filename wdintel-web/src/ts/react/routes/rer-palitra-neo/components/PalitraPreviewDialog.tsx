import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { Palitra as ReadPalitra, PalitraGeometryDetails as ReadGeometry, PalitraReadV2 } from '../../../../../Bindings';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, Typography } from '@mui/material';
import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { PalitraCacheManager } from '../../../../maps/palitra-cache-manager';
import { PalitraPointClusterRenderer } from '../../../../maps/palitra-point-cluster-renderer';
import { PalitraPointsController } from '../../../../maps/palitra-points-controller';
import { createMapWindowControl, type MapWindowControl } from '../../../../maps/control-modules';
import type {
  Coords,
  Geometry,
  Palitra as MapPalitra,
  PalitraDetails,
  PalitraManagerCallbacks,
  PalitraManagerOptions,
  PalitraPoint,
} from '../../../../maps/palitra-types';
import '../../../analysis-map-window-control-element';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';

type Props = {
  open: boolean;
  palitra: ReadPalitra | null;
  preview: PalitraReadV2 | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
};

const DEFAULT_PREVIEW_CENTER: [number, number] = [49, 32];
const DEFAULT_PREVIEW_ZOOM = 6;
const PREVIEW_MAX_ZOOM = 17;
const PREVIEW_POINT_OPTIONS: PalitraManagerOptions = {
  minZoomForPoints: 15,
  requestDelayMs: 200,
  cacheTtlMs: 5 * 60 * 1000,
  maxCachedTiles: 100,
};

const NOOP_CALLBACKS: PalitraManagerCallbacks = {
  onVisibilityToggle: () => undefined,
  onSearchResultsCountChanged: () => undefined,
  onSearchLoadingChanged: () => undefined,
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizeCoords(raw: { lat: number | string; lng: number | string } | null | undefined): Coords | null {
  if (!raw) {
    return null;
  }

  const lat = normalizeNumber(raw.lat);
  const lng = normalizeNumber(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return { lat, lng };
}

function normalizeGeometry(raw: ReadGeometry['geometry'] | null | undefined): Geometry | null {
  if (!raw) {
    return null;
  }

  return {
    center: normalizeCoords(raw.center),
    perimeter_linear_ring: (raw.perimeterLinearRing ?? [])
      .map((coords) => normalizeCoords(coords))
      .filter((coords): coords is Coords => coords !== null),
    line_strings: (raw.lineStrings ?? []).map((lineString) =>
      lineString
        .map((coords) => normalizeCoords(coords))
        .filter((coords): coords is Coords => coords !== null),
    ),
  };
}

function hasRenderableGeometry(geometry: Geometry | null | undefined): boolean {
  if (!geometry) {
    return false;
  }

  const perimeter = geometry.perimeter_linear_ring;
  if (Array.isArray(perimeter) && perimeter.length >= 3) {
    return true;
  }

  const lineStrings = geometry.line_strings;
  if (Array.isArray(lineStrings) && lineStrings.some((lineString) => Array.isArray(lineString) && lineString.length >= 2)) {
    return true;
  }

  return Boolean(geometry.center);
}

function toPreviewPalitras(preview: PalitraReadV2 | null): PalitraDetails[] {
  if (!preview) {
    return [];
  }

  const basePalitra = preview.palitra;
  const geometries = preview.geometries.length > 0
    ? preview.geometries
    : basePalitra.geometry
      ? [{
          id: basePalitra.id,
          colorHex: basePalitra.colorHex,
          sourceFileName: basePalitra.sourceFileName,
          lastUploadedAtTs: basePalitra.lastUploadedAtTs,
          geometry: basePalitra.geometry,
          points: [],
        }]
      : [];

  return geometries
    .map((geometry) => {
      const normalizedGeometry = normalizeGeometry(geometry.geometry);
      if (!normalizedGeometry) {
        return null;
      }

      const palitra: MapPalitra = {
        id: normalizeNumber(geometry.id),
        api_palitra_id: normalizeNumber(basePalitra.id),
        name: basePalitra.name,
        folder: basePalitra.folder,
        color_hex: geometry.colorHex ?? basePalitra.colorHex ?? '#00bcd4',
        geometry: normalizedGeometry,
        source_file_name: geometry.sourceFileName ?? basePalitra.sourceFileName ?? undefined,
      };

      return {
        palitra,
        points: [] as PalitraPoint[],
      };
    })
    .filter((entry): entry is PalitraDetails => entry !== null);
}

function createPolygonLayer(palitraDetails: PalitraDetails) {
  const perimeter = palitraDetails.palitra.geometry?.perimeter_linear_ring;
  if (!Array.isArray(perimeter) || perimeter.length < 3) {
    return null;
  }

  return L.polygon(perimeter.map((coords) => [coords.lat, coords.lng] as [number, number]), {
    interactive: false,
    color: palitraDetails.palitra.color_hex,
    weight: 2,
    fillColor: palitraDetails.palitra.color_hex,
    fillOpacity: 0.14,
    lineJoin: 'round',
    lineCap: 'round',
  });
}

function createPolylineLayers(palitraDetails: PalitraDetails) {
  const lineStrings = palitraDetails.palitra.geometry?.line_strings;
  if (!Array.isArray(lineStrings) || lineStrings.length === 0) {
    return [];
  }

  return lineStrings
    .filter((lineString) => Array.isArray(lineString) && lineString.length >= 2)
    .map((lineString) =>
      L.polyline(lineString.map((coords) => [coords.lat, coords.lng] as [number, number]), {
        interactive: false,
        color: palitraDetails.palitra.color_hex,
        weight: 2,
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
      }),
    );
}

function createCenterLayer(palitraDetails: PalitraDetails) {
  const center = palitraDetails.palitra.geometry?.center;
  if (!center) {
    return null;
  }

  return L.circleMarker([center.lat, center.lng], {
    interactive: false,
    radius: 4,
    color: palitraDetails.palitra.color_hex,
    weight: 1,
    fillColor: palitraDetails.palitra.color_hex,
    fillOpacity: 1,
  });
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
      background: 'transparent',
    },
  };
}

function createPreviewPointStack(
  map: L.Map,
  palitras: PalitraDetails[],
  listenersRef: MutableRefObject<{ onViewportChanged: (() => void) | null }>,
  stateRef: MutableRefObject<PalitraDetails[]>,
  cacheManagerRef: MutableRefObject<PalitraCacheManager | null>,
  pointClustersRendererRef: MutableRefObject<PalitraPointClusterRenderer | null>,
  pointsControllerRef: MutableRefObject<PalitraPointsController | null>,
): void {
  const cacheManager = new PalitraCacheManager(PREVIEW_POINT_OPTIONS.cacheTtlMs, PREVIEW_POINT_OPTIONS.maxCachedTiles);
  const pointClustersRenderer = new PalitraPointClusterRenderer(map);
  const pointsController = new PalitraPointsController(
    map,
    PREVIEW_POINT_OPTIONS,
    NOOP_CALLBACKS,
    cacheManager,
    pointClustersRenderer,
    {
      getPalitras: () => stateRef.current,
      getEnabled: () => true,
    },
    {
      getBufferedBounds: () => map.getBounds().pad(0.1),
    },
    {
      apiPalitraId: (palitra) => palitra.api_palitra_id ?? palitra.id,
    },
  );

  const onViewportChanged = () => {
    pointsController.onViewportChanged();
  };

  stateRef.current = palitras;
  listenersRef.current.onViewportChanged = onViewportChanged;
  map.on('zoomend', onViewportChanged);
  map.on('moveend', onViewportChanged);

  cacheManagerRef.current = cacheManager;
  pointClustersRendererRef.current = pointClustersRenderer;
  pointsControllerRef.current = pointsController;

  pointsController.onPalitrasChanged();
  pointsController.onViewportChanged();
}

function destroyPreviewPointStack(
  map: L.Map | null,
  listenersRef: MutableRefObject<{ onViewportChanged: (() => void) | null }>,
  cacheManagerRef: MutableRefObject<PalitraCacheManager | null>,
  pointClustersRendererRef: MutableRefObject<PalitraPointClusterRenderer | null>,
  pointsControllerRef: MutableRefObject<PalitraPointsController | null>,
  stateRef: MutableRefObject<PalitraDetails[]>,
): void {
  if (map && listenersRef.current.onViewportChanged) {
    map.off('zoomend', listenersRef.current.onViewportChanged);
    map.off('moveend', listenersRef.current.onViewportChanged);
  }

  listenersRef.current.onViewportChanged = null;
  pointsControllerRef.current?.destroy();
  pointsControllerRef.current = null;
  pointClustersRendererRef.current?.clear();
  pointClustersRendererRef.current = null;
  cacheManagerRef.current?.clear();
  cacheManagerRef.current = null;
  stateRef.current = [];
}

export function PalitraPreviewDialog({ open, palitra, preview, loading, error, onClose }: Props) {
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
  const showPreviewLoading = !hasPreviewError && (loading || !preview || !mapReady || !previewRenderReady);

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
      destroyPreviewPointStack(mapRef.current, listenersRef, cacheManagerRef, pointClustersRendererRef, pointsControllerRef, previewPalitrasRef);
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

    destroyPreviewPointStack(map, listenersRef, cacheManagerRef, pointClustersRendererRef, pointsControllerRef, previewPalitrasRef);
    layerGroup.clearLayers();

    if (!hasRenderablePreviewGeometry) {
      setPreviewRenderReady(false);
      return;
    }

    previewPalitras.forEach((palitraDetails) => {
      const polygon = createPolygonLayer(palitraDetails);
      if (polygon) {
        layerGroup.addLayer(polygon);
      }

      for (const line of createPolylineLayers(palitraDetails)) {
        layerGroup.addLayer(line);
      }

      const center = createCenterLayer(palitraDetails);
      if (center) {
        layerGroup.addLayer(center);
      }
    });

    fitGeometryLayers(map, layerGroup);
    createPreviewPointStack(map, previewPalitras, listenersRef, previewPalitrasRef, cacheManagerRef, pointClustersRendererRef, pointsControllerRef);
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
