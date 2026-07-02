import { L } from '../../maps/leaflet-markercluster';
import type * as Leaflet from 'leaflet';

import { MapPointDetailed } from '../../maps/types';
import { CoordinateMenuTarget, DataCircleMarker } from './types';

type CreatePointsMarkersGroupOptions = {
  points: MapPointDetailed[];
  onPointClick: (point: MapPointDetailed, circle: DataCircleMarker) => void;
  onPointContextMenu: (
    target: CoordinateMenuTarget,
    latlng: Leaflet.LatLng,
    originalEvent?: MouseEvent | PointerEvent | Event,
  ) => void;
  onClusterClick: (
    messageIds: number[],
    latlng: Leaflet.LatLng | null,
    cluster: Leaflet.Layer,
  ) => void;
};

export function replacePointsLayer(params: {
  map: Leaflet.Map | null;
  markersGroup: Leaflet.MarkerClusterGroup | null;
  pelengsLayerGroup: Leaflet.LayerGroup | null;
  pelengLabelsLayerGroup: Leaflet.LayerGroup | null;
  points: MapPointDetailed[];
  boundedAlready: boolean;
  buildMarkersGroup: (points: MapPointDetailed[]) => {
    bounds: Leaflet.LatLngBounds;
    markersGroup: Leaflet.MarkerClusterGroup;
  };
}): { markersGroup: Leaflet.MarkerClusterGroup; boundedAlready: boolean } {
  const {
    map,
    markersGroup,
    pelengsLayerGroup,
    pelengLabelsLayerGroup,
    points,
    boundedAlready,
    buildMarkersGroup,
  } = params;
  cleanupMarkersGroup(markersGroup, pelengsLayerGroup, pelengLabelsLayerGroup, map);

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
  onPointClick,
  onPointContextMenu,
  onClusterClick,
}: CreatePointsMarkersGroupOptions): {
  bounds: Leaflet.LatLngBounds;
  markersGroup: Leaflet.MarkerClusterGroup;
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
    const circle = new DataCircleMarker(
      [point.lat, point.lng],
      { messageId: point.message_id, freq: point.freq },
      {
        color: '#000',
        fillColor: '#ED1C23',
        fillOpacity: 1,
        radius: 4,
        weight: 1,
      },
    );

    circle.on('click', () => {
      onPointClick(point, circle);
    });
    circle.on('mousedown', (event: Leaflet.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
      if (event.originalEvent?.button !== 2) {
        return;
      }
      onPointContextMenu(
        { lat: point.lat, lng: point.lng, mgrsCoords: point.mgrs_coords },
        circle.getLatLng(),
        event.originalEvent,
      );
    });
    circle.on(
      'contextmenu',
      (event: Leaflet.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
        event.originalEvent?.preventDefault();
        event.originalEvent?.stopPropagation();
      },
    );
    circle.on('popupopen', () => {
      circle.setStyle({ fillColor: '#fff', color: '#000' });
    });
    circle.on('popupclose', () => {
      circle.setStyle({ fillColor: '#ED1C23', color: '#000' });
    });

    markersGroup.addLayer(circle);
  });

  markersGroup.on('clusterclick', (leafletEvent) => {
    const cluster = leafletEvent.layer as unknown as { getAllChildMarkers: () => Leaflet.Layer[] };
    const childMarkers = cluster.getAllChildMarkers() as unknown as DataCircleMarker[];
    const latlng =
      (leafletEvent as Leaflet.LeafletMouseEvent).latlng ??
      (typeof (cluster as unknown as { getLatLng?: () => Leaflet.LatLng }).getLatLng === 'function'
        ? (cluster as unknown as { getLatLng: () => Leaflet.LatLng }).getLatLng()
        : null);
    onClusterClick(
      childMarkers.map((marker) => marker.data.messageId),
      latlng,
      leafletEvent.layer,
    );
  });

  return { bounds, markersGroup };
}

export function findPointMarkerByMessageId(
  markersGroup: Leaflet.MarkerClusterGroup | null,
  messageId: number,
): DataCircleMarker | null {
  if (!markersGroup) {
    return null;
  }

  let found: DataCircleMarker | null = null;
  markersGroup.eachLayer((layer: Leaflet.Layer) => {
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
  markersGroup: Leaflet.MarkerClusterGroup | null,
  pelengsLayerGroup: Leaflet.LayerGroup | null,
  pelengLabelsLayerGroup: Leaflet.LayerGroup | null,
  map: Leaflet.Map | null,
): void {
  if (!markersGroup) {
    return;
  }

  markersGroup.off();
  markersGroup.eachLayer((layer) => {
    layer.off();
    const maybeTooltipLayer = layer as Leaflet.Layer & { unbindTooltip?: () => void };
    if (typeof maybeTooltipLayer.unbindTooltip === 'function') {
      maybeTooltipLayer.unbindTooltip();
    }
  });
  markersGroup.clearLayers();
  pelengsLayerGroup?.removeLayer(markersGroup);
  pelengLabelsLayerGroup?.clearLayers();
  map?.removeLayer(markersGroup);
}

function fitBoundsOnInitialLowZoom(
  map: Leaflet.Map | null,
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
