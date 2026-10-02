import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './KmzAttachmentPreviewMap.css';
import { useCallback, useRef } from 'react';

import type { KmzPreview, KmzPreviewCoords } from './kmz/kmz-preview-types';
import type { BaseLayerId } from '../../../../maps/base-layers';
import { MessageCardMapPreview } from './MessageCardMapPreview';

const FALLBACK_GEOMETRY_COLOR = '#060606';
const MIXED_CLUSTER_COLOR = '#606060';
const MAP_MAX_ZOOM = 17;
export const KMZ_POINT_DETAILS_MIN_ZOOM = MAP_MAX_ZOOM - 2;
const POINT_MARKER_RADIUS = 6;
const POINT_INDEX_GRID_SIZE = 4096;
const OVERVIEW_CLUSTER_PIXELS = 56;
const DETAIL_CLUSTER_PIXELS = 36;
const MAX_VIEWPORT_POINT_LAYERS = 2_000;
const MAX_SPIDERFY_POINTS = 100;
const MAX_PREVIEW_POLYGON_FILL_OPACITY = 0.25;

export function validCoords(coords: KmzPreviewCoords): coords is KmzPreviewCoords {
  return (
    Number.isFinite(coords.lat) &&
    Number.isFinite(coords.lng) &&
    coords.lat >= -90 &&
    coords.lat <= 90 &&
    coords.lng >= -180 &&
    coords.lng <= 180
  );
}

export function geometryColor(color: string | null): string {
  return color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color : FALLBACK_GEOMETRY_COLOR;
}

export function clusterTextColor(color: string): string {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 >= 160 ? '#060606' : '#fff';
}

function bindPointLabel(marker: L.CircleMarker, label: string | null): void {
  if (!label?.trim()) return;
  const content = document.createElement('span');
  content.textContent = label;
  marker.bindTooltip(content, {
    permanent: true,
    direction: 'top',
    offset: [0, -10],
    className: 'palitra-point-label',
  });
}

export function addPreviewLayers(
  layerGroup: L.FeatureGroup,
  preview: KmzPreview,
  includePoints = true,
): void {
  const renderer = L.canvas({ padding: 0.25 });
  for (const polygon of preview.polygons) {
    const [outer, ...inner] = polygon.rings;
    const outerRing = outer
      ?.filter(validCoords)
      .map(({ lat, lng }) => [lat, lng] as [number, number]);
    if (outerRing == null || outerRing.length < 3) continue;
    const rings = [
      outerRing,
      ...inner
        .map((ring) =>
          ring.filter(validCoords).map(({ lat, lng }) => [lat, lng] as [number, number]),
        )
        .filter((ring) => ring.length >= 3),
    ];
    const layer = L.polygon(rings, {
      renderer,
      interactive: false,
      color: geometryColor(polygon.strokeColor),
      opacity: polygon.strokeOpacity,
      fillColor: geometryColor(polygon.fillColor),
      fillOpacity: Math.min(Math.max(polygon.fillOpacity, 0), MAX_PREVIEW_POLYGON_FILL_OPACITY),
      weight: 2,
      lineJoin: 'round',
    });
    if (polygon.label?.trim()) {
      const label = document.createElement('span');
      label.textContent = polygon.label;
      layer.bindTooltip(label);
    }
    layerGroup.addLayer(layer);
  }
  for (const line of preview.lineStrings) {
    const coords = line.coords.filter(validCoords);
    if (coords.length < 2) continue;
    layerGroup.addLayer(
      L.polyline(
        coords.map(({ lat, lng }) => [lat, lng] as [number, number]),
        {
          renderer,
          interactive: false,
          color: geometryColor(line.color),
          weight: 2,
          opacity: line.opacity,
          lineJoin: 'round',
          lineCap: 'round',
        },
      ),
    );
  }
  if (!includePoints) return;
  for (const point of preview.points) {
    if (!validCoords(point.coords)) continue;
    const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
      renderer,
      radius: POINT_MARKER_RADIUS,
      color: '#fff',
      weight: 2,
      fillColor: geometryColor(point.color),
      fillOpacity: point.opacity,
    });
    bindPointLabel(marker, point.label);
    layerGroup.addLayer(marker);
  }
}

type PreviewPoint = KmzPreview['points'][number];
type IndexedPoint = PreviewPoint;
type PointIndex = Map<number, Map<number, IndexedPoint[]>>;

function pointBucket(coords: KmzPreviewCoords): [number, number] {
  const lat = Math.min(
    POINT_INDEX_GRID_SIZE - 1,
    Math.max(0, Math.floor(((coords.lat + 90) / 180) * POINT_INDEX_GRID_SIZE)),
  );
  const lng = Math.min(
    POINT_INDEX_GRID_SIZE - 1,
    Math.max(0, Math.floor(((coords.lng + 180) / 360) * POINT_INDEX_GRID_SIZE)),
  );
  return [lat, lng];
}

function indexedPreviewPoints(points: PreviewPoint[]): PointIndex {
  const index: PointIndex = new Map();
  for (const point of points) {
    if (!validCoords(point.coords)) continue;
    const [latBucket, lngBucket] = pointBucket(point.coords);
    const longitudeIndex = index.get(latBucket) ?? new Map<number, IndexedPoint[]>();
    const entries = longitudeIndex.get(lngBucket) ?? [];
    entries.push(point);
    longitudeIndex.set(lngBucket, entries);
    index.set(latBucket, longitudeIndex);
  }
  return index;
}

function pointsInViewport(index: PointIndex, bounds: L.LatLngBounds): IndexedPoint[] {
  const south = Math.max(-90, bounds.getSouth());
  const north = Math.min(90, bounds.getNorth());
  const west = Math.max(-180, bounds.getWest());
  const east = Math.min(180, bounds.getEast());
  const latStart = Math.floor(((south + 90) / 180) * POINT_INDEX_GRID_SIZE);
  const latEnd = Math.floor(((north + 90) / 180) * POINT_INDEX_GRID_SIZE);
  const lngStart = Math.floor(((west + 180) / 360) * POINT_INDEX_GRID_SIZE);
  const lngEnd = Math.floor(((east + 180) / 360) * POINT_INDEX_GRID_SIZE);
  const points: IndexedPoint[] = [];
  for (const [lat, longitudeIndex] of index) {
    if (lat < latStart || lat > latEnd) continue;
    for (const [lng, entries] of longitudeIndex) {
      if (lng < lngStart || lng > lngEnd) continue;
      for (const point of entries) {
        if (bounds.contains([point.coords.lat, point.coords.lng])) points.push(point);
      }
    }
  }
  return points;
}

function previewBounds(preview: KmzPreview): L.LatLngBounds {
  const bounds = L.latLngBounds([]);
  const extend = (coords: KmzPreviewCoords) => {
    if (validCoords(coords)) bounds.extend([coords.lat, coords.lng]);
  };
  preview.points.forEach((point) => extend(point.coords));
  preview.lineStrings.forEach((line) => line.coords.forEach(extend));
  preview.polygons.forEach((polygon) => polygon.rings.forEach((ring) => ring.forEach(extend)));
  return bounds;
}

function fitPreviewGeometry(map: L.Map, preview: KmzPreview): void {
  const bounds = previewBounds(preview);
  if (!bounds.isValid()) return;
  if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
    map.setView(bounds.getCenter(), MAP_MAX_ZOOM, { animate: false });
    return;
  }
  map.fitBounds(bounds.pad(0.14), { animate: false, maxZoom: MAP_MAX_ZOOM });
}

class KmzPreviewPointLayers {
  private index: PointIndex;
  private renderer = L.canvas({ padding: 0.25 });
  private activeLayers: L.Layer[] = [];
  private nextLayers: L.Layer[] | null = null;

  constructor(
    private layerGroup: L.FeatureGroup,
    points: PreviewPoint[],
    private showOverviewClusters: boolean,
  ) {
    this.index = indexedPreviewPoints(points);
  }

  update(map: L.Map): void {
    this.nextLayers = [];
    const closeView = map.getZoom() >= KMZ_POINT_DETAILS_MIN_ZOOM;
    map.getContainer().dataset.kmzPreviewPointMode = closeView ? 'detail' : 'overview';
    if (!closeView && !this.showOverviewClusters) {
      this.replaceLayers();
      return;
    }
    const points = pointsInViewport(this.index, map.getBounds().pad(0.1));
    let cellSize = closeView ? DETAIL_CLUSTER_PIXELS : OVERVIEW_CLUSTER_PIXELS;
    let clusters = this.clusterPoints(map, points, cellSize);
    while (clusters.size > MAX_VIEWPORT_POINT_LAYERS) {
      cellSize *= 2;
      clusters = this.clusterPoints(map, points, cellSize);
    }
    const radius = POINT_MARKER_RADIUS;
    for (const [cell, points] of clusters) {
      this.addCluster(map, points, radius, cell, cellSize);
    }
    this.replaceLayers();
  }

  private clusterPoints(
    map: L.Map,
    points: IndexedPoint[],
    cellSize: number,
  ): Map<string, IndexedPoint[]> {
    const clusters = new Map<string, IndexedPoint[]>();
    for (const point of points) {
      const pixel = map.project([point.coords.lat, point.coords.lng], map.getZoom());
      const key = `${Math.floor(pixel.x / cellSize)}:${Math.floor(pixel.y / cellSize)}`;
      const entries = clusters.get(key) ?? [];
      entries.push(point);
      clusters.set(key, entries);
    }
    return clusters;
  }

  private addLayer(layer: L.Layer): void {
    if (this.nextLayers != null) {
      this.nextLayers.push(layer);
      return;
    }
    this.activeLayers.push(layer);
    this.layerGroup.addLayer(layer);
  }

  private replaceLayers(): void {
    const nextLayers = this.nextLayers ?? [];
    nextLayers.forEach((layer) => this.layerGroup.addLayer(layer));
    this.activeLayers.forEach((layer) => this.layerGroup.removeLayer(layer));
    this.activeLayers = nextLayers;
    this.nextLayers = null;
  }

  private pointMarker(point: IndexedPoint, radius: number, coords = point.coords): L.CircleMarker {
    const marker = L.circleMarker([coords.lat, coords.lng], {
      renderer: this.renderer,
      radius,
      color: '#fff',
      weight: 2,
      fillColor: geometryColor(point.color),
      fillOpacity: point.opacity,
    });
    bindPointLabel(marker, point.label);
    return marker;
  }

  private addCluster(
    map: L.Map,
    points: IndexedPoint[],
    radius: number,
    cell: string,
    cellSize: number,
  ): void {
    const [first] = points;
    if (first == null) return;
    if (points.length === 1) {
      this.addLayer(this.pointMarker(first, radius));
      return;
    }
    const colors = new Set(points.map((point) => geometryColor(point.color)));
    const [singleColor] = colors;
    const color = colors.size === 1 ? singleColor : MIXED_CLUSTER_COLOR;
    const centre = points.reduce(
      (total, point) => ({ lat: total.lat + point.coords.lat, lng: total.lng + point.coords.lng }),
      { lat: 0, lng: 0 },
    );
    const coords = { lat: centre.lat / points.length, lng: centre.lng / points.length };
    const [column, row] = cell.split(':').map(Number);
    const position = map.unproject(
      L.point((column + 0.5) * cellSize, (row + 0.5) * cellSize),
      map.getZoom(),
    );
    const marker = L.marker(position, {
      icon: L.divIcon({
        className: 'kmz-preview-point-cluster',
        html: `<span style="align-items:center;background:${color};border:1px solid #060606;border-radius:9999px;color:${clusterTextColor(color)};display:flex;font-size:11px;font-weight:700;height:28px;justify-content:center;min-width:28px;padding:0 5px">${points.length}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    });
    marker.on('click', () => {
      if (map.getZoom() < MAP_MAX_ZOOM) {
        map.setView(coords, Math.min(map.getZoom() + 2, MAP_MAX_ZOOM));
      } else if (points.length <= MAX_SPIDERFY_POINTS) {
        this.spiderfy(map, marker, points, radius);
      } else {
        marker
          .bindPopup(
            `${points.length} точок у цьому місці. Завантажте оригінал, щоб переглянути всі.`,
          )
          .openPopup();
      }
    });
    this.addLayer(marker);
  }

  private spiderfy(map: L.Map, cluster: L.Marker, points: IndexedPoint[], radius: number): void {
    const centre = cluster.getLatLng();
    const centrePixel = map.project(centre, map.getZoom());
    const distance = Math.max(12, radius * 3);
    this.layerGroup.removeLayer(cluster);
    this.activeLayers = this.activeLayers.filter((layer) => layer !== cluster);
    points.forEach((point, index) => {
      const angle = (Math.PI * 2 * index) / points.length;
      const offset = L.point(
        centrePixel.x + Math.cos(angle) * distance,
        centrePixel.y + Math.sin(angle) * distance,
      );
      const coords = map.unproject(offset, map.getZoom());
      this.addLayer(this.pointMarker(point, radius, coords));
    });
  }
}

export function KmzAttachmentPreviewMap({
  preview,
  baseLayerId,
}: {
  preview: KmzPreview;
  baseLayerId: BaseLayerId;
}) {
  const pointLayersRef = useRef<KmzPreviewPointLayers | null>(null);
  const initializeMap = useCallback(
    (map: L.Map) => {
      const geometryLayers = L.featureGroup().addTo(map);
      const pointLayers = L.featureGroup().addTo(map);
      addPreviewLayers(geometryLayers, preview, false);
      const pointDisplay = new KmzPreviewPointLayers(
        pointLayers,
        preview.points,
        preview.lineStrings.length === 0 && preview.polygons.length === 0,
      );
      pointLayersRef.current = pointDisplay;
      fitPreviewGeometry(map, preview);
      pointDisplay.update(map);
      const updatePoints = () => pointDisplay.update(map);
      map.on('zoomend moveend', updatePoints);
      return () => {
        map.off('zoomend moveend', updatePoints);
        pointLayers.clearLayers();
        pointLayers.remove();
        geometryLayers.remove();
        pointLayersRef.current = null;
      };
    },
    [preview],
  );
  const resizeMap = useCallback((map: L.Map) => {
    pointLayersRef.current?.update(map);
  }, []);

  return (
    <MessageCardMapPreview
      baseLayerId={baseLayerId}
      className="coordinate-fullscreen-map"
      dataAttributes={{ 'data-kmz-preview-map': 'true' }}
      onMapReady={initializeMap}
      onMapResize={resizeMap}
    />
  );
}
