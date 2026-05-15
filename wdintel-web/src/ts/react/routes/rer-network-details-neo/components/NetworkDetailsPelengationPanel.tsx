import FullscreenExitOutlinedIcon from '@mui/icons-material/FullscreenExitOutlined';
import FullscreenOutlinedIcon from '@mui/icons-material/FullscreenOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import WhatshotOutlinedIcon from '@mui/icons-material/WhatshotOutlined';
import { Box, Button, IconButton, Skeleton, Stack, Typography } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { NetworkPoint } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  onReloadPelengPoints: () => void;
};

const SATELLITE_TILE_URL = 'https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk';
const SATELLITE_TILE_SUBDOMAINS = ['mt0', 'mt1', 'mt2', 'mt3'];
const BASE_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const PELENG_TOOLTIP_ARROW_COLOR = '#000000';

function createPopupContent(point: NetworkPoint, label: string) {
  const content = document.createElement('div');
  content.style.minWidth = '180px';
  content.style.maxWidth = '260px';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '6px';

  const title = document.createElement('div');
  title.textContent = label;
  title.style.fontWeight = '700';
  title.style.fontSize = '14px';
  title.style.lineHeight = '1.2';

  const body = document.createElement('div');
  body.textContent = point.body?.trim() === '' ? 'Без тексту' : point.body;
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontSize = '13px';
  body.style.lineHeight = '1.45';

  const coords = document.createElement('div');
  coords.textContent = `Координати: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  coords.style.fontSize = '12px';
  coords.style.opacity = '0.8';

  content.append(title, body, coords);
  return content;
}

function PelengationSkeleton() {
  return (
    <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap' }}>
        <Skeleton variant="text" width={180} height={32} />
        <Skeleton variant="rounded" width={180} height={38} sx={{ borderRadius: 2 }} />
      </Stack>
      <Skeleton variant="rounded" sx={{ height: { xs: 220, sm: 280, md: 340 }, borderRadius: 3 }} />
    </Stack>
  );
}

export function NetworkDetailsPelengationPanel({
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
  pelengPointsError,
  onReloadPelengPoints,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const satelliteLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const heatLayerRef = useRef<L.LayerGroup | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [satelliteEnabled, setSatelliteEnabled] = useState(true);
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const pelengPointsRef = useRef(pelengPoints);

  const pointCountLabel = useMemo(() => {
    const count = pelengPoints.length;
    return `точок: ${count}`;
  }, [pelengPoints.length]);

  const activeLayerLabel = useMemo(() => {
    const baseLabel = satelliteEnabled ? 'Супутник' : 'Карта';
    return heatmapEnabled ? `${baseLabel} • Heatmap` : baseLabel;
  }, [heatmapEnabled, satelliteEnabled]);

  useEffect(() => {
    pelengPointsRef.current = pelengPoints;
  }, [pelengPoints]);

  useEffect(() => {
    document.body.classList.toggle('small-map-fullscreen-open', isFullscreen);
    return () => {
      document.body.classList.remove('small-map-fullscreen-open');
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const styleId = 'peleng-point-label-tooltip-styles';
    const existingStyle = document.getElementById(styleId);
    const style = existingStyle ?? document.createElement('style');
    const createdStyle = existingStyle === null;

    style.id = styleId;
    style.textContent = `
      .leaflet-popup.peleng-point-popup .leaflet-popup-content-wrapper {
        background: rgba(18, 20, 18, 0.95) !important;
        color: #ffffff !important;
      }
      .leaflet-popup.peleng-point-popup .leaflet-popup-tip {
        background: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
        box-shadow: none !important;
      }
      .peleng-heat-point {
        width: 156px;
        height: 156px;
        border-radius: 50%;
        background:
          radial-gradient(circle, rgba(233, 151, 70, 0.36) 0 14%, rgba(208, 111, 58, 0.24) 24%, rgba(207, 146, 68, 0.16) 48%, rgba(207, 146, 68, 0.08) 62%, rgba(207, 146, 68, 0) 78%);
        filter: blur(8px);
        mix-blend-mode: screen;
        opacity: 0.95;
        pointer-events: none;
      }
      .leaflet-tooltip.peleng-point-label {
        background: #11110f !important;
        border: 1px solid #000000 !important;
        box-shadow: none !important;
        color: #fff7ea !important;
        font-weight: 800 !important;
        font-size: 12px !important;
        letter-spacing: 0.04em !important;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
        padding: 3px 8px !important;
        border-radius: 999px !important;
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:before,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:before,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:before,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:before {
        display: none !important;
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:after,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:after,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:after,
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:after {
        position: absolute;
        width: 0;
        height: 0;
        border: 6px solid transparent;
        pointer-events: none;
        content: "";
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:after {
        left: 50% !important;
        bottom: 0 !important;
        margin-bottom: -12px !important;
        transform: translateX(-50%);
        border-top-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:after {
        left: 50% !important;
        top: 0 !important;
        margin-top: -12px !important;
        transform: translateX(-50%);
        border-bottom-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:after {
        top: 50% !important;
        right: 0 !important;
        margin-top: -6px !important;
        margin-right: -12px !important;
        border-left-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
      }
      .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:after {
        top: 50% !important;
        left: 0 !important;
        margin-top: -6px !important;
        margin-left: -12px !important;
        border-right-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
      }
    `;
    if (createdStyle) {
      document.head.appendChild(style);
    }

    return () => {
      if (createdStyle) {
        style.remove();
      }
    };
  }, []);

  useLayoutEffect(() => {
    const mapContainer = mapContainerRef.current;
    if (!mapContainer || mapRef.current) return;

    let cancelled = false;
    let rafId = 0;
    let cleanupMap: (() => void) | null = null;

    const initMap = () => {
      if (cancelled) return;
      const rect = mapContainer.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        rafId = window.requestAnimationFrame(initMap);
        return;
      }

      const map = L.map(mapContainer, {
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true,
        worldCopyJump: false,
        minZoom: 2,
      }).setView([49, 32], 5);

      const baseLayer = L.tileLayer(BASE_TILE_URL, {
        maxZoom: 19,
        crossOrigin: true,
      });
      const satelliteLayer = L.tileLayer(SATELLITE_TILE_URL, {
        maxZoom: 19,
        subdomains: SATELLITE_TILE_SUBDOMAINS,
        crossOrigin: true,
      });

      map.addLayer(baseLayer);
      map.addLayer(satelliteLayer);

      const markersLayer = L.layerGroup().addTo(map);
      const heatLayer = L.layerGroup();
      baseLayerRef.current = baseLayer;
      satelliteLayerRef.current = satelliteLayer;
      markersLayerRef.current = markersLayer;
      heatLayerRef.current = heatLayer;
      mapRef.current = map;
      setMapReady(true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserverRef.current = new ResizeObserver(() => {
          map.invalidateSize();
        });
        resizeObserverRef.current.observe(mapContainer);
      }

      window.requestAnimationFrame(() => {
        map.invalidateSize();
      });

      cleanupMap = () => {
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        markersLayer.clearLayers();
        heatLayer.clearLayers();
        map.remove();
        mapRef.current = null;
        baseLayerRef.current = null;
        satelliteLayerRef.current = null;
        markersLayerRef.current = null;
        heatLayerRef.current = null;
      };
    };

    rafId = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      cleanupMap?.();
      cleanupMap = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const heatLayer = heatLayerRef.current;
    if (!map || !baseLayerRef.current || !satelliteLayerRef.current || !heatLayer) return;

    if (satelliteEnabled) {
      if (!map.hasLayer(satelliteLayerRef.current)) {
        map.addLayer(satelliteLayerRef.current);
      }
    } else {
      if (map.hasLayer(satelliteLayerRef.current)) {
        map.removeLayer(satelliteLayerRef.current);
      }
    }

  }, [satelliteEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    const heatLayer = heatLayerRef.current;
    if (!map || !heatLayer) return;

    if (heatmapEnabled) {
      if (!map.hasLayer(heatLayer)) {
        map.addLayer(heatLayer);
      }
    } else if (map.hasLayer(heatLayer)) {
      map.removeLayer(heatLayer);
    }
  }, [heatmapEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    const markersLayer = markersLayerRef.current;
    const heatLayer = heatLayerRef.current;
    if (!map || !markersLayer || !heatLayer || !mapReady) return;

    markersLayer.clearLayers();
    heatLayer.clearLayers();

    if (pelengPoints.length === 0) {
      return;
    }

    const bounds = L.latLngBounds([]);
    pelengPoints.forEach((point, index) => {
      const label = `P-${index + 1}`;
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 7,
        color: '#caa275',
        weight: 2,
        fillColor: '#e0b589',
        fillOpacity: 0.92,
      });

      marker.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        offset: [0, -8],
        opacity: 1,
        className: 'peleng-point-label',
        sticky: false,
      });
      marker.bindPopup(createPopupContent(point, label), {
        closeButton: true,
        className: 'peleng-point-popup',
        maxWidth: 280,
        autoPanPadding: [24, 24],
      });

      markersLayer.addLayer(marker);
      bounds.extend([point.lat, point.lng]);

      heatLayer.addLayer(
        L.marker([point.lat, point.lng], {
          icon: L.divIcon({
            className: '',
            html: '<div class="peleng-heat-point"></div>',
            iconSize: [156, 156],
            iconAnchor: [78, 78],
          }),
          interactive: false,
          keyboard: false,
          zIndexOffset: -1000,
        }),
      );
    });

    if (bounds.isValid()) {
      if (pelengPoints.length === 1) {
        const point = pelengPoints[0];
        map.setView([point.lat, point.lng], 16, {
          animate: false,
        });
      } else {
        map.fitBounds(bounds.pad(0.12), {
          animate: false,
          maxZoom: 16,
        });
      }
    }
  }, [mapReady, pelengPoints]);

  useEffect(() => {
    if (!mapRef.current) return;
    const frame2Ref = { current: 0 };
    const frame1 = window.requestAnimationFrame(() => {
      mapRef.current?.invalidateSize();
      frame2Ref.current = window.requestAnimationFrame(() => {
        mapRef.current?.invalidateSize();
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      if (frame2Ref.current !== 0) {
        window.cancelAnimationFrame(frame2Ref.current);
      }
    };
  }, [isFullscreen, mapReady]);

  const showSkeleton = pelengPointsLoading || !pelengPointsLoaded;

  const mapShellSx = (theme: Theme) => ({
    position: isFullscreen ? 'fixed' : 'relative',
    ...(isFullscreen ? { inset: 0, top: 0, right: 0, bottom: 0, left: 0 } : {}),
    width: isFullscreen ? '100vw' : '100%',
    height: isFullscreen ? '100dvh' : 'auto',
    zIndex: isFullscreen ? 4000 : 'auto',
    minHeight: { xs: 320, sm: 360, md: 420 },
    flex: 1,
    overflow: 'hidden',
    borderRadius: isFullscreen ? 0 : 3,
    border: isFullscreen ? 'none' : '1px solid',
    borderColor: alpha(theme.palette.divider, 0.8),
    bgcolor: '#151510',
    backgroundImage: `
      radial-gradient(circle at 20% 18%, rgba(136, 162, 99, 0.22), transparent 28%),
      radial-gradient(circle at 72% 28%, rgba(181, 126, 68, 0.22), transparent 26%),
      radial-gradient(circle at 42% 72%, rgba(87, 132, 86, 0.18), transparent 30%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(0, 0, 0, 0.22)),
      linear-gradient(135deg, rgba(63, 83, 48, 0.25), rgba(29, 26, 20, 0.15))
    `,
    boxShadow: isFullscreen ? 'none' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.03)',
  });

  const mapPanel = (
    <Box component="section" sx={mapShellSx}>
      <Box
        ref={mapContainerRef}
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 100,
          '& .leaflet-container': {
            background: 'transparent',
          },
          '& .leaflet-popup-content-wrapper': {
            borderRadius: 2,
            bgcolor: 'rgba(18, 20, 18, 0.95)',
            color: 'common.white',
          },
          '& .leaflet-popup-tip': {
            bgcolor: 'rgba(18, 20, 18, 0.95)',
          },
          '& .leaflet-popup-content': {
            margin: 1.25,
            color: 'common.white',
          },
        }}
      />

      <IconButton
        aria-label={isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'}
        onClick={() => setIsFullscreen((current) => !current)}
        sx={(theme) => ({
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 1200,
          width: 44,
          height: 44,
          borderRadius: 2.5,
          bgcolor: 'rgba(17, 17, 15, 0.74)',
          color: 'rgba(255, 255, 255, 0.88)',
          border: '1px solid',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(8px)',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
          '&:hover': {
            bgcolor: 'rgba(24, 24, 20, 0.82)',
            borderColor: 'rgba(255, 255, 255, 0.2)',
          },
          '&.Mui-focusVisible': {
            outline: 'none',
            boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.4)}`,
          },
        })}
      >
        {isFullscreen ? <FullscreenExitOutlinedIcon fontSize="small" /> : <FullscreenOutlinedIcon fontSize="small" />}
      </IconButton>

      <Box
        sx={{
          position: 'absolute',
          right: 16,
          bottom: 14,
          zIndex: 1150,
          px: 1.25,
          py: 0.75,
          borderRadius: 2,
          bgcolor: 'rgba(15, 15, 12, 0.48)',
          backdropFilter: 'blur(8px)',
          border: '1px solid',
          borderColor: 'rgba(255, 255, 255, 0.08)',
        }}
      >
        <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.78)', fontWeight: 600 }}>
          {`${pointCountLabel} • ${activeLayerLabel}`}
        </Typography>
      </Box>

      {showSkeleton ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            pt: 2,
            bgcolor: 'rgba(10, 10, 8, 0.24)',
            pointerEvents: 'none',
          }}
        >
          <Box
            sx={{
              width: { xs: '88%', sm: '72%', md: '56%' },
              maxWidth: 520,
              minWidth: 240,
              px: 2,
            }}
          >
            <PelengationSkeleton />
          </Box>
        </Box>
      ) : null}

    </Box>
  );

  if (pelengPointsError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            ПЕЛЕНГАЦІЯ
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {pelengPointsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReloadPelengPoints} sx={{ alignSelf: 'flex-start' }}>
            Спробувати ще раз
          </Button>
        </Stack>
      </Box>
    );
  }

  if (pelengPointsLoaded && !pelengPointsLoading && pelengPoints.length === 0) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Пеленгація
          </Typography>
          <Box
            sx={{
              minHeight: 220,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: 'background.default',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Точки перехоплення відсутні
            </Typography>
          </Box>
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack spacing={1.5} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
        <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
            <Typography id={headingId} component="h2" variant="h6">
              Пеленгація
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.2 }}>
              {pointCountLabel}
            </Typography>
            {showSkeleton ? <Skeleton variant="rounded" width={84} height={18} sx={{ borderRadius: 1 }} /> : null}
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant={satelliteEnabled ? 'contained' : 'outlined'}
              onClick={() => setSatelliteEnabled((current) => !current)}
              startIcon={<LayersOutlinedIcon />}
              sx={(theme) => ({
                borderRadius: 2,
                px: 1.6,
                py: 0.8,
                minWidth: 0,
                textTransform: 'none',
                fontWeight: 700,
                bgcolor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.18) : undefined,
                color: satelliteEnabled ? theme.palette.warning.main : theme.palette.text.secondary,
                borderColor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.35) : undefined,
                '&:hover': {
                  bgcolor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.24) : alpha(theme.palette.text.primary, 0.04),
                  borderColor: satelliteEnabled ? alpha(theme.palette.warning.main, 0.5) : undefined,
                },
              })}
            >
              Супутник
            </Button>

            <Button
              type="button"
              variant={heatmapEnabled ? 'contained' : 'outlined'}
              onClick={() => setHeatmapEnabled((current) => !current)}
              startIcon={<WhatshotOutlinedIcon />}
              sx={(theme) => ({
                borderRadius: 2,
                px: 1.6,
                py: 0.8,
                minWidth: 0,
                textTransform: 'none',
                fontWeight: 700,
                bgcolor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.18) : undefined,
                color: heatmapEnabled ? theme.palette.warning.main : theme.palette.text.secondary,
                borderColor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.35) : undefined,
                '&:hover': {
                  bgcolor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.24) : alpha(theme.palette.text.primary, 0.04),
                  borderColor: heatmapEnabled ? alpha(theme.palette.warning.main, 0.5) : undefined,
                },
              })}
            >
              Heatmap
            </Button>
          </Stack>

        </Stack>
        {mapPanel}
      </Stack>
    </Box>
  );
}
