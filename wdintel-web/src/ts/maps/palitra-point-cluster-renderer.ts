import * as L from 'leaflet';
import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"

import { Palitra, PalitraPoint } from './palitra-types';
import { buildPalitraPopupContent } from './palitra-popup-content';

/** Max markers to add per frame when building clusters (keeps UI responsive). */
const MARKER_ADD_CHUNK_SIZE = 60;

type PointMarker = L.CircleMarker & { _palitraTooltipLabel?: string };

export class PalitraPointClusterRenderer {
  private pointsClusters: Map<number, L.MarkerClusterGroup> = new Map();
  private pointMarkers: PointMarker[] = [];

  constructor(
    private map: L.Map,
    private onOverlayContextMenu?: (target: { lat: number; lng: number }, latlng: { lat: number; lng: number }) => void,
  ) {}

  clear(): void {
    this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
    this.pointsClusters.clear();
    this.pointMarkers = [];
  }

  replace(
    nextClusters: Array<{ palitraId: number; cluster: L.MarkerClusterGroup | null }>,
    nextPointMarkers: PointMarker[],
  ): void {
    this.clear();
    this.pointMarkers = nextPointMarkers;

    nextClusters.forEach(({ palitraId, cluster }) => {
      if (!cluster) {
        return;
      }
      this.pointsClusters.set(palitraId, cluster);
      this.map.addLayer(cluster);
    });
  }

  updatePointLabelVisibility(): void {
    const bounds = this.map.getBounds();
    for (const marker of this.pointMarkers) {
      const label = marker._palitraTooltipLabel;
      if (!label) continue;

      const inView = bounds.contains(marker.getLatLng());
      const hasTooltip = marker.getTooltip();
      const isPermanent = hasTooltip?.options?.permanent === true;

      // Keep labels only for markers in current viewport to reduce clutter and DOM load.
      if (inView && !isPermanent) {
        marker.unbindTooltip();
        marker.bindTooltip(label, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: 'palitra-point-label'
        });
      } else if (!inView && hasTooltip) {
        marker.unbindTooltip();
      }
    }
  }

  async createPointsCluster(
    palitra: Palitra,
    points: PalitraPoint[],
    markerSink: PointMarker[],
  ): Promise<L.MarkerClusterGroup | null> {
    if (!points || points.length === 0) {
      return null;
    }

    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      animate: false,
      animateAddingMarkers: false,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: (cluster) => {
        const childCount = cluster.getChildCount();
        return L.divIcon({
          html: `<div style="background-color: ${palitra.color_hex}; border: 2px solid #fff; border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; font-weight: bold; color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                ${childCount}
            </div>`,
          className: 'palitra-point-cluster',
          iconSize: L.point(30, 30)
        });
      }
    });

    for (let i = 0; i < points.length; i += MARKER_ADD_CHUNK_SIZE) {
      const chunk = points.slice(i, i + MARKER_ADD_CHUNK_SIZE);
      chunk.forEach((point) => this.addMarkerToCluster(clusterGroup, palitra, point, markerSink));
      if (i + MARKER_ADD_CHUNK_SIZE < points.length) {
        // Yield to browser between chunks to keep map interactions responsive.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }

    return clusterGroup;
  }

  private addMarkerToCluster(
    clusterGroup: L.MarkerClusterGroup,
    palitra: Palitra,
    point: PalitraPoint,
    markerSink: PointMarker[],
  ): void {
    const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
      radius: 6,
      fillColor: palitra.color_hex,
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    });

    const popupContent = buildPalitraPopupContent(marker as PointMarker & L.Layer & { closePopup: () => void }, palitra, {
      emphasisLine: point.label ? { label: 'Мітка', value: point.label } : null,
      metaLines: [`Координати: ${point.coords.lat.toFixed(5)}, ${point.coords.lng.toFixed(5)}`],
    });

    marker.bindPopup(popupContent, {
      className: 'analysis-map-compact-popup-shell',
      closeButton: false,
    });
    marker.on('mousedown', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
      if (event.originalEvent?.button !== 2) {
        return;
      }
      event.originalEvent.preventDefault();
      event.originalEvent.stopPropagation();
      this.onOverlayContextMenu?.(point.coords, { lat: event.latlng.lat, lng: event.latlng.lng });
    });
    marker.on('contextmenu', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
      event.originalEvent?.preventDefault();
      event.originalEvent?.stopPropagation();
    });

    const tooltipLabel = point.label ?? palitra.name;
    if (tooltipLabel) {
      (marker as PointMarker)._palitraTooltipLabel = tooltipLabel;
    }

    markerSink.push(marker as PointMarker);
    clusterGroup.addLayer(marker);
  }

}
