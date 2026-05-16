import * as L from 'leaflet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { NetworkPoint } from '../../../../../Bindings';
import {
  applyPelengationMapStyles,
  BASE_TILE_URL,
  createPelengationPopupContent,
  SATELLITE_TILE_SUBDOMAINS,
  SATELLITE_TILE_URL,
} from './NetworkDetailsPelengationMap.shared';

export function useNetworkDetailsPelengationMap(pelengPoints: NetworkPoint[]) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const satelliteLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const heatLayerRef = useRef<L.LayerGroup | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const viewTransitionRef = useRef<{ center: L.LatLng; zoom: number } | null>(null);
  const [satelliteEnabled, setSatelliteEnabled] = useState(true);
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mapReady, setMapReady] = useState(false);

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
      const heatLayer = L.layerGroup();

      mapRef.current = map;
      satelliteLayerRef.current = satelliteLayer;
      markersLayerRef.current = markersLayer;
      heatLayerRef.current = heatLayer;
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
  }, [isFullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    const satelliteLayer = satelliteLayerRef.current;
    if (!mapReady || !map || !satelliteLayer || !heatLayerRef.current) return;

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
    const heatLayer = heatLayerRef.current;
    if (!mapReady || !map || !heatLayer) return;

    if (heatmapEnabled) {
      if (!map.hasLayer(heatLayer)) {
        map.addLayer(heatLayer);
      }
      return;
    }

    if (map.hasLayer(heatLayer)) {
      map.removeLayer(heatLayer);
    }
  }, [mapReady, heatmapEnabled]);

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
      marker.bindPopup(createPelengationPopupContent(point, label), {
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

  const toggleFullscreen = () => {
    const map = mapRef.current;
    if (map) {
      viewTransitionRef.current = { center: map.getCenter(), zoom: map.getZoom() };
    }
    setIsFullscreen((current) => !current);
  };

  return {
    mapContainerRef,
    satelliteEnabled,
    setSatelliteEnabled,
    heatmapEnabled,
    setHeatmapEnabled,
    isFullscreen,
    toggleFullscreen,
    mapReady,
  };
}
