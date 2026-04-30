import * as L from 'leaflet';

import { MapPointDetailed } from '../../maps/types';
import { CoordinateMenuTarget, DataCircleMarker } from './types';

type CreatePointsMarkersGroupOptions = {
  points: MapPointDetailed[];
  pelengLabelsPermanent: boolean;
  onPointClick: (point: MapPointDetailed, circle: DataCircleMarker) => void;
  onPointContextMenu: (
    target: CoordinateMenuTarget,
    latlng: L.LatLng,
    originalEvent?: MouseEvent | PointerEvent | Event,
  ) => void;
  onClusterClick: (messageIds: number[], latlng: L.LatLng | null) => void;
};

export function replacePointsLayer(params: {
  map: L.Map | null;
  markersGroup: L.MarkerClusterGroup | null;
  pelengsLayerGroup: L.LayerGroup | null;
  points: MapPointDetailed[];
  boundedAlready: boolean;
  buildMarkersGroup: (points: MapPointDetailed[]) => {
    bounds: L.LatLngBounds;
    markersGroup: L.MarkerClusterGroup;
  };
}): { markersGroup: L.MarkerClusterGroup; boundedAlready: boolean } {
  const { map, markersGroup, pelengsLayerGroup, points, boundedAlready, buildMarkersGroup } = params;
  cleanupMarkersGroup(markersGroup, pelengsLayerGroup, map);

  const nextBoundedAlready = fitBoundsOnInitialLowZoom(map, points, boundedAlready);
  const { bounds, markersGroup: nextMarkersGroup } = buildMarkersGroup(points);
  pelengsLayerGroup?.addLayer(nextMarkersGroup);

  if (bounds.isValid() && !nextBoundedAlready && map) {
    if (map.getZoom() <= 10) {
      map.fitBounds(bounds);
    }
    return { markersGroup: nextMarkersGroup, boundedAlready: true };
  }

  return { markersGroup: nextMarkersGroup, boundedAlready: nextBoundedAlready };
}

export function createPointsMarkersGroup({
  points,
  pelengLabelsPermanent,
  onPointClick,
  onPointContextMenu,
  onClusterClick,
}: CreatePointsMarkersGroupOptions): {
  bounds: L.LatLngBounds;
  markersGroup: L.MarkerClusterGroup;
} {
  const markersGroup = L.markerClusterGroup({
    maxClusterRadius: points.length > 100 ? 30 : 10,
    zoomToBoundsOnClick: false,
    spiderfyOnMaxZoom: false,
    iconCreateFunction: function (cluster) {
      const colors = cluster.isPopupOpen()
        ? 'background-color: #fff;color:black;'
        : 'background-color: #ED1C23; border: 1px solid #000;color: white;';
      const childCount = cluster.getChildCount();
      return L.divIcon({
        html: `<div style="${colors} border-radius: 50%; width: 17px; height: 17px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 10px; line-height: 17px;">
                ${childCount}
            </div>`,
        className: '',
      });
    },
  });
  const bounds = L.latLngBounds(points);

  points.forEach((point) => {
    const circle = new DataCircleMarker([point.lat, point.lng], { messageId: point.message_id }, {
      color: '#000',
      fillColor: '#ED1C23',
      fillOpacity: 1,
      radius: 4,
      weight: 1,
    });

    bindPelengLabel(circle, point, pelengLabelsPermanent);

    circle.on('click', () => {
      onPointClick(point, circle);
    });
    circle.on('mousedown', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
      if (event.originalEvent?.button !== 2) {
        return;
      }
      onPointContextMenu(
        { lat: point.lat, lng: point.lng, mgrsCoords: point.mgrs_coords },
        circle.getLatLng(),
        event.originalEvent,
      );
    });
    circle.on('contextmenu', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
      event.originalEvent?.preventDefault();
      event.originalEvent?.stopPropagation();
    });
    circle.on('popupopen', () => {
      circle.setStyle({ fillColor: '#fff', color: '#000' });
    });
    circle.on('popupclose', () => {
      circle.setStyle({ fillColor: '#ED1C23', color: '#000' });
    });

    markersGroup.addLayer(circle);
  });

  markersGroup.on('clusterclick', (leafletEvent) => {
    const cluster = leafletEvent.layer as unknown as { getAllChildMarkers: () => L.Layer[] };
    const childMarkers = cluster.getAllChildMarkers() as unknown as DataCircleMarker[];
    const latlng =
      (leafletEvent as L.LeafletMouseEvent).latlng ??
      (typeof (cluster as unknown as { getLatLng?: () => L.LatLng }).getLatLng === 'function'
        ? (cluster as unknown as { getLatLng: () => L.LatLng }).getLatLng()
        : null);
    onClusterClick(
      childMarkers.map((marker) => marker.data.messageId),
      latlng,
    );
  });

  return { bounds, markersGroup };
}

export function updatePelengLabelsPermanent(
  markersGroup: L.MarkerClusterGroup | null,
  pelengLabelsPermanent: boolean,
): void {
  if (!markersGroup) {
    return;
  }

  const opts = {
    permanent: pelengLabelsPermanent,
    direction: 'top' as const,
    offset: [0, -8] as [number, number],
    className: 'peleng-point-label',
  };

  markersGroup.eachLayer((layer: L.Layer) => {
    getChildLayers(layer).forEach((childLayer) => {
      if (!(childLayer instanceof DataCircleMarker)) {
        return;
      }
      const label = (childLayer as DataCircleMarker & { _pelengFreqLabel?: string })._pelengFreqLabel;
      if (!label) {
        return;
      }
      childLayer.unbindTooltip();
      childLayer.bindTooltip(label, opts);
    });
  });
}

export function findPointMarkerByMessageId(
  markersGroup: L.MarkerClusterGroup | null,
  messageId: number,
): DataCircleMarker | null {
  if (!markersGroup) {
    return null;
  }

  let found: DataCircleMarker | null = null;
  markersGroup.eachLayer((layer: L.Layer) => {
    if (found) {
      return;
    }
    if (layer instanceof DataCircleMarker && layer.getData().messageId === messageId) {
      found = layer;
    }
  });
  return found;
}

function cleanupMarkersGroup(
  markersGroup: L.MarkerClusterGroup | null,
  pelengsLayerGroup: L.LayerGroup | null,
  map: L.Map | null,
): void {
  if (!markersGroup) {
    return;
  }

  markersGroup.off();
  markersGroup.eachLayer((layer) => {
    layer.off();
    const maybeTooltipLayer = layer as L.Layer & { unbindTooltip?: () => void };
    if (typeof maybeTooltipLayer.unbindTooltip === 'function') {
      maybeTooltipLayer.unbindTooltip();
    }
  });
  markersGroup.clearLayers();
  pelengsLayerGroup?.removeLayer(markersGroup);
  map?.removeLayer(markersGroup);
}

function fitBoundsOnInitialLowZoom(
  map: L.Map | null,
  points: MapPointDetailed[],
  boundedAlready: boolean,
): boolean {
  if (!map || boundedAlready || map.getZoom() > 10 || points.length === 0) {
    return boundedAlready;
  }

  const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as [number, number]));
  if (!bounds.isValid()) {
    return boundedAlready;
  }

  map.fitBounds(bounds);
  return true;
}

function bindPelengLabel(
  circle: DataCircleMarker,
  point: MapPointDetailed,
  pelengLabelsPermanent: boolean,
): void {
  const freqLabel = point.freq ?? '';
  if (!freqLabel) {
    return;
  }

  (circle as DataCircleMarker & { _pelengFreqLabel?: string })._pelengFreqLabel = freqLabel;
  circle.bindTooltip(freqLabel, {
    permanent: pelengLabelsPermanent,
    direction: 'top',
    offset: [0, -8],
    className: 'peleng-point-label',
  });
}

function getChildLayers(layer: L.Layer): L.Layer[] {
  const withGetChildren = layer as unknown as { getAllChildMarkers?: () => L.Layer[] };
  return typeof withGetChildren.getAllChildMarkers === 'function' ? withGetChildren.getAllChildMarkers() : [layer];
}
