import { Skeleton } from '@mui/material';
import * as L from 'leaflet';
import { useLayoutEffect, useRef, useState } from 'react';

import { DEFAULT_BASE_LAYER_ID } from '../../../../maps/base-layers';
import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import type { CoordinatePreviewPoint } from './message-coordinate-preview';

type SharedProps = {
  points: CoordinatePreviewPoint[];
  className?: string;
};
type Props =
  | (SharedProps & {
      mode: 'thumbnail';
      detailViewportBounds?: never;
      onDetailViewportBoundsChange?: never;
    })
  | (SharedProps & {
      mode: 'overview';
      detailViewportBounds: L.LatLngBounds | null;
      onDetailViewportBoundsChange?: never;
    })
  | (SharedProps & {
      mode: 'detail';
      detailViewportBounds?: never;
      onDetailViewportBoundsChange: (bounds: L.LatLngBounds) => void;
    });
const THUMBNAIL_ZOOM = 11;
const DETAIL_ZOOM = 16;
const MAX_FITTED_ZOOM = 13;
const BOUNDS_PADDING: [number, number] = [28, 28];
function applyView(map: L.Map, points: CoordinatePreviewPoint[], mode: Props['mode']): void {
  if (points.length === 0) return;
  if (mode === 'detail' || points.length === 1) {
    map.setView([points[0].lat, points[0].lng], mode === 'detail' ? DETAIL_ZOOM : THUMBNAIL_ZOOM, {
      animate: false,
    });
    return;
  }
  map.fitBounds(L.latLngBounds(points.map(({ lat, lng }): [number, number] => [lat, lng])), {
    animate: false,
    maxZoom: MAX_FITTED_ZOOM,
    padding: BOUNDS_PADDING,
  });
}
function createMarkers(
  map: L.Map,
  points: CoordinatePreviewPoint[],
  mode: Props['mode'],
): L.CircleMarker[] {
  const visibleBounds = mode === 'detail' ? map.getBounds() : null;
  return points
    .filter(({ lat, lng }) => visibleBounds == null || visibleBounds.contains([lat, lng]))
    .map(({ lat, lng }) =>
      L.circleMarker([lat, lng], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#ff4d2d',
        fillOpacity: 1,
        interactive: false,
      }).addTo(map),
    );
}

function findTileLayers(layer: L.Layer): L.GridLayer[] {
  if (layer instanceof L.GridLayer) return [layer];
  if (layer instanceof L.LayerGroup) {
    const layers: L.GridLayer[] = [];
    layer.eachLayer((child) => layers.push(...findTileLayers(child)));
    return layers;
  }
  return typeof layer.on === 'function' && typeof layer.off === 'function'
    ? [layer as L.GridLayer]
    : [];
}
export function CoordinatePreviewMapSurface(props: Props) {
  const { points, mode, className } = props;
  // The detail map reports its viewport; only the overview map consumes it.
  const overviewDetailViewportBounds = mode === 'overview' ? props.detailViewportBounds : null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<L.CircleMarker[]>([]);
  const rectangleRef = useRef<L.Rectangle | null>(null);
  const propsRef = useRef({ ...props, overviewDetailViewportBounds });
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  propsRef.current = { ...props, overviewDetailViewportBounds };
  const updateMap = () => {
    const map = mapRef.current;
    if (map == null) return;
    const current = propsRef.current;
    markerRefs.current.forEach((marker) => marker.remove());
    applyView(map, current.points, current.mode);
    markerRefs.current = createMarkers(map, current.points, current.mode);
    rectangleRef.current?.remove();
    rectangleRef.current =
      current.mode === 'overview' && current.overviewDetailViewportBounds != null
        ? L.rectangle(current.overviewDetailViewportBounds, {
            color: '#ff4d2d',
            weight: 2,
            fillOpacity: 0.08,
            interactive: false,
          }).addTo(map)
        : null;
    if (current.mode === 'detail') {
      current.onDetailViewportBoundsChange(map.getBounds());
    }
  };
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container == null) return;
    let cancelled = false;
    let frameId = 0;
    let resizeObserver: ResizeObserver | null = null;
    let readinessLayer: L.GridLayer | null = null;
    let map: L.Map | null = null;
    let receivedPrimaryTile = false;
    const markReady = () => {
      if (!cancelled) setState('ready');
    };
    const markFailedWhenEmpty = () => {
      if (!cancelled && !receivedPrimaryTile) setState('failed');
    };
    const markPrimaryTile = () => {
      receivedPrimaryTile = true;
      markReady();
    };
    const initialize = () => {
      if (cancelled || mapRef.current != null || containerRef.current !== container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        frameId = window.requestAnimationFrame(initialize);
        return;
      }
      try {
        const leafletMap = L.map(container, {
          zoomControl: false,
          attributionControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          touchZoom: false,
          boxZoom: false,
          keyboard: false,
          preferCanvas: false,
          minZoom: 2,
          maxZoom: 17,
        });
        map = leafletMap;
        mapRef.current = leafletMap;
        const baseLayer = getTileLayers()[DEFAULT_BASE_LAYER_ID];
        if (baseLayer == null) throw new Error('The configured base layer is unavailable');
        readinessLayer = findTileLayers(baseLayer)[0] ?? null;
        if (readinessLayer == null) throw new Error('The base layer does not contain a tile layer');
        readinessLayer.on('tileload', markPrimaryTile);
        readinessLayer.on('load', markFailedWhenEmpty);
        baseLayer.addTo(leafletMap);
        leafletMap.getContainer().style.pointerEvents = 'none';
        updateMap();
        frameId = window.requestAnimationFrame(() => {
          if (cancelled || mapRef.current !== leafletMap) return;
          leafletMap.invalidateSize({ animate: false, pan: false });
          if (propsRef.current.mode === 'detail') {
            propsRef.current.onDetailViewportBoundsChange(leafletMap.getBounds());
          }
        });
        resizeObserver =
          typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => {
                if (cancelled || mapRef.current !== leafletMap) return;
                leafletMap.invalidateSize({ animate: false, pan: false });
                updateMap();
              });
        resizeObserver?.observe(container);
      } catch {
        if (!cancelled) setState('failed');
        readinessLayer?.off('tileload', markPrimaryTile);
        readinessLayer?.off('load', markFailedWhenEmpty);
        readinessLayer = null;
        map?.remove();
        if (mapRef.current === map) mapRef.current = null;
        markerRefs.current.forEach((marker) => marker.remove());
        markerRefs.current = [];
        rectangleRef.current?.remove();
        rectangleRef.current = null;
      }
    };
    frameId = window.requestAnimationFrame(initialize);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      readinessLayer?.off('tileload', markPrimaryTile);
      readinessLayer?.off('load', markFailedWhenEmpty);
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      rectangleRef.current?.remove();
      rectangleRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);
  useLayoutEffect(() => updateMap(), [points, mode, overviewDetailViewportBounds]);
  return (
    <div className={className} aria-hidden="true">
      <div ref={containerRef} className="coordinate-preview-map-surface" />
      {state === 'loading' ? (
        <Skeleton variant="rounded" className="coordinate-preview-map-skeleton" />
      ) : null}
      {state === 'failed' ? (
        <span className="coordinate-preview-map-error">Не вдалося завантажити мапу</span>
      ) : null}
    </div>
  );
}
