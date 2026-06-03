import * as L from 'leaflet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { NetworkPoint } from '../../../../../Bindings';
import {
  applyPelengationMapStyles,
  BASE_TILE_URL,
  buildPelengationLabelGroups,
  createPelengationPopupContent,
  SATELLITE_TILE_SUBDOMAINS,
  SATELLITE_TILE_URL,
} from './NetworkDetailsPelengationMap.shared';

export function useNetworkDetailsPelengationMap(
  pelengPoints: NetworkPoint[],
  showLabels: boolean,
  satelliteEnabled: boolean,
  heatmapEnabled: boolean,
) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const satelliteLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const labelLayerRef = useRef<L.LayerGroup | null>(null);
  const heatCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const heatScratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const heatRedrawRafRef = useRef<number | null>(null);
  const redrawHeatmapRef = useRef<(() => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const viewTransitionRef = useRef<{ center: L.LatLng; zoom: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const clearHeatmapCanvas = () => {
    const canvas = heatCanvasRef.current;
    const scratchCanvas = heatScratchCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      canvas.style.display = 'none';
    }
    if (scratchCanvas) {
      const scratchCtx = scratchCanvas.getContext('2d');
      if (scratchCtx) {
        scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
      }
    }
  };

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
    return applyPelengationMapStyles();
  }, []);

  useLayoutEffect(() => {
    const mapContainer = mapContainerRef.current;
    if (!mapContainer) return;

    setMapReady(false);
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

      const restoredView = viewTransitionRef.current;
      const map = L.map(mapContainer, {
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true,
        worldCopyJump: false,
        minZoom: 2,
      }).setView(restoredView?.center ?? [49, 32], restoredView?.zoom ?? 5);

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
      const labelLayer = L.layerGroup().addTo(map);
      const heatCanvas = document.createElement('canvas');
      heatCanvas.setAttribute('aria-hidden', 'true');
      heatCanvas.style.position = 'absolute';
      heatCanvas.style.inset = '0';
      heatCanvas.style.width = '100%';
      heatCanvas.style.height = '100%';
      heatCanvas.style.pointerEvents = 'none';
      heatCanvas.style.zIndex = '350';
      heatCanvas.style.display = 'none';
      mapContainer.appendChild(heatCanvas);

      mapRef.current = map;
      satelliteLayerRef.current = satelliteLayer;
      markersLayerRef.current = markersLayer;
      labelLayerRef.current = labelLayer;
      heatCanvasRef.current = heatCanvas;
      setMapReady(true);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserverRef.current = new ResizeObserver(() => {
          map.invalidateSize();
          redrawHeatmapRef.current?.();
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
        labelLayer.clearLayers();
        clearHeatmapCanvas();
        heatCanvas.remove();
        map.remove();
        mapRef.current = null;
        satelliteLayerRef.current = null;
        markersLayerRef.current = null;
        labelLayerRef.current = null;
        heatCanvasRef.current = null;
        heatScratchCanvasRef.current = null;
      };
    };

    rafId = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      cleanupMap?.();
      cleanupMap = null;
    };
  }, [isFullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    const satelliteLayer = satelliteLayerRef.current;
    if (!mapReady || !map || !satelliteLayer) return;

    if (satelliteEnabled) {
      if (!map.hasLayer(satelliteLayer)) {
        map.addLayer(satelliteLayer);
      }
      return;
    }

    if (map.hasLayer(satelliteLayer)) {
      map.removeLayer(satelliteLayer);
    }
  }, [mapReady, satelliteEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    const canvas = heatCanvasRef.current;
    if (!mapReady || !map || !canvas) return;

    const drawHeatmap = () => {
      const currentCanvas = heatCanvasRef.current;
      if (!currentCanvas) return;

      const size = map.getSize();
      const width = Math.max(1, Math.round(size.x));
      const height = Math.max(1, Math.round(size.y));
      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const drawWidth = Math.max(1, Math.round(width * devicePixelRatio));
      const drawHeight = Math.max(1, Math.round(height * devicePixelRatio));

      currentCanvas.width = drawWidth;
      currentCanvas.height = drawHeight;
      currentCanvas.style.width = `${width}px`;
      currentCanvas.style.height = `${height}px`;

      const context = currentCanvas.getContext('2d');
      if (!context) return;

      if (!heatmapEnabled || pelengPoints.length === 0) {
        context.clearRect(0, 0, drawWidth, drawHeight);
        currentCanvas.style.display = 'none';
        return;
      }

      const renderScale = 0.5;
      const scratchWidth = Math.max(1, Math.round(drawWidth * renderScale));
      const scratchHeight = Math.max(1, Math.round(drawHeight * renderScale));
      const scratchCanvas = heatScratchCanvasRef.current ?? document.createElement('canvas');
      heatScratchCanvasRef.current = scratchCanvas;
      scratchCanvas.width = scratchWidth;
      scratchCanvas.height = scratchHeight;

      const scratchContext = scratchCanvas.getContext('2d');
      if (!scratchContext) return;

      scratchContext.clearRect(0, 0, scratchWidth, scratchHeight);
      scratchContext.globalCompositeOperation = 'screen';

      const radius = Math.max(72, Math.round(160 * devicePixelRatio * renderScale));

      for (const point of pelengPoints) {
        const projected = map.latLngToContainerPoint([point.lat, point.lng]);
        const x = projected.x * devicePixelRatio * renderScale;
        const y = projected.y * devicePixelRatio * renderScale;

        if (x < -radius || y < -radius || x > scratchWidth + radius || y > scratchHeight + radius) {
          continue;
        }

        const gradient = scratchContext.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(233, 151, 70, 0.26)');
        gradient.addColorStop(0.2, 'rgba(233, 151, 70, 0.18)');
        gradient.addColorStop(0.42, 'rgba(208, 111, 58, 0.09)');
        gradient.addColorStop(0.68, 'rgba(207, 146, 68, 0.035)');
        gradient.addColorStop(1, 'rgba(207, 146, 68, 0)');

        scratchContext.fillStyle = gradient;
        scratchContext.beginPath();
        scratchContext.arc(x, y, radius, 0, Math.PI * 2);
        scratchContext.fill();
      }

      context.save();
      context.clearRect(0, 0, drawWidth, drawHeight);
      context.globalCompositeOperation = 'source-over';
      context.imageSmoothingEnabled = true;
      context.filter = 'blur(2px)';
      context.drawImage(scratchCanvas, 0, 0, drawWidth, drawHeight);
      context.filter = 'none';
      context.restore();
      currentCanvas.style.display = 'block';
    };

    const scheduleDraw = () => {
      if (heatRedrawRafRef.current !== null) {
        window.cancelAnimationFrame(heatRedrawRafRef.current);
      }
      heatRedrawRafRef.current = window.requestAnimationFrame(drawHeatmap);
    };

    redrawHeatmapRef.current = scheduleDraw;
    scheduleDraw();

    const handleViewChange = () => {
      scheduleDraw();
    };

    map.on('moveend zoomend', handleViewChange);

    return () => {
      map.off('moveend zoomend', handleViewChange);
      if (heatRedrawRafRef.current !== null) {
        window.cancelAnimationFrame(heatRedrawRafRef.current);
        heatRedrawRafRef.current = null;
      }
      redrawHeatmapRef.current = null;
      clearHeatmapCanvas();
    };
  }, [heatmapEnabled, mapReady, pelengPoints]);

  useEffect(() => {
    const map = mapRef.current;
    const labelLayer = labelLayerRef.current;
    if (!map || !labelLayer || !mapReady) return;

    const renderLabels = () => {
      labelLayer.clearLayers();

      if (!showLabels || pelengPoints.length === 0) {
        return;
      }

      const groups = buildPelengationLabelGroups(
        pelengPoints,
        (point) => {
          const projected = map.project([point.lat, point.lng], map.getZoom());
          return { x: projected.x, y: projected.y };
        },
        44,
      );

      for (const group of groups) {
        const labelMarker = L.marker([group.lat, group.lng], {
          icon: L.divIcon({
            className: 'peleng-label-anchor',
            html: '',
            iconSize: [1, 1],
            iconAnchor: [0, 0],
          }),
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        });

        labelMarker.bindTooltip(group.label, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          opacity: 1,
          className: 'peleng-point-label',
          sticky: false,
        });
        labelLayer.addLayer(labelMarker);
      }
    };

    renderLabels();
    map.on('zoomend moveend', renderLabels);
    return () => {
      map.off('zoomend moveend', renderLabels);
      labelLayer.clearLayers();
    };
  }, [mapReady, pelengPoints, showLabels]);

  useEffect(() => {
    const map = mapRef.current;
    const markersLayer = markersLayerRef.current;
    if (!map || !markersLayer || !mapReady) return;

    markersLayer.clearLayers();

    if (pelengPoints.length === 0) {
      return;
    }

    const bounds = L.latLngBounds([]);
    pelengPoints.forEach((point) => {
      const label = point.freq.trim() === '' ? 'P-n' : point.freq.trim();
      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 7,
        color: '#caa275',
        weight: 2,
        fillColor: '#e0b589',
        fillOpacity: 0.92,
      });
      marker.bindPopup(createPelengationPopupContent(point, label), {
        closeButton: true,
        className: 'peleng-point-popup',
        maxWidth: 280,
        autoPanPadding: [24, 24],
      });

      markersLayer.addLayer(marker);
      bounds.extend([point.lat, point.lng]);

    });

    if (viewTransitionRef.current) {
      const restoredView = viewTransitionRef.current;
      map.setView(restoredView.center, restoredView.zoom, { animate: false });
      viewTransitionRef.current = null;
      return;
    }

    if (!bounds.isValid()) {
      return;
    }

    if (pelengPoints.length === 1) {
      const point = pelengPoints[0];
      map.setView([point.lat, point.lng], 16, { animate: false });
      return;
    }

    map.fitBounds(bounds.pad(0.12), {
      animate: false,
      maxZoom: 16,
    });
    redrawHeatmapRef.current?.();
  }, [mapReady, pelengPoints, showLabels, heatmapEnabled]);

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

  const toggleFullscreen = () => {
    const map = mapRef.current;
    if (map) {
      viewTransitionRef.current = { center: map.getCenter(), zoom: map.getZoom() };
    }
    setIsFullscreen((current) => !current);
  };

  return {
    mapContainerRef,
    isFullscreen,
    toggleFullscreen,
    mapReady,
  };
}
