import * as L from 'leaflet';

import { CoordinateMenuTarget } from './types';

type BuildContent = (target: CoordinateMenuTarget) => HTMLElement;

export class AnalysisMapCoordMenuController {
  private marker: L.CircleMarker | null = null;
  private overlay: HTMLElement | null = null;
  private latlng: L.LatLng | null = null;

  constructor(private map: L.Map, private buildContent: BuildContent) {}

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.latlng = null;
    if (this.marker) {
      this.map.removeLayer(this.marker);
      this.marker = null;
    }
  }

  open(target: CoordinateMenuTarget, latlng: L.LatLng): void {
    this.close();

    const marker = L.circleMarker(latlng, {
      color: '#fff',
      fillColor: '#6c757d',
      fillOpacity: 1,
      radius: 6,
      weight: 2,
    });
    marker.addTo(this.map);
    this.marker = marker;

    const overlay = document.createElement('div');
    overlay.className = 'analysis-map-coord-menu-overlay';
    const stopPropagation = (event: Event) => {
      event.stopPropagation();
    };
    overlay.addEventListener('pointerdown', stopPropagation);
    overlay.addEventListener('mousedown', stopPropagation);
    overlay.addEventListener('mouseup', stopPropagation);
    overlay.addEventListener('click', stopPropagation);
    overlay.addEventListener('dblclick', stopPropagation);
    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    overlay.appendChild(this.buildContent(target));
    this.map.getContainer().appendChild(overlay);
    this.overlay = overlay;
    this.latlng = latlng;

    requestAnimationFrame(() => this.position());
    setTimeout(() => this.position(), 0);
  }

  position(): void {
    if (!this.overlay || !this.latlng) {
      return;
    }

    const container = this.map.getContainer();
    const point = this.map.latLngToContainerPoint(this.latlng);
    const rect = this.overlay.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const margin = 12;
    const arrowHeight = 10;
    const markerGap = 10;

    const maxLeft = Math.max(margin, container.clientWidth - width - margin);
    const unclampedLeft = point.x - width / 2;
    const left = Math.min(Math.max(margin, unclampedLeft), maxLeft);
    const top = Math.max(margin, point.y - height - arrowHeight - markerGap);
    const arrowLeft = Math.min(Math.max(point.x - left - 1, 20), Math.max(20, width - 20));

    this.overlay.style.left = `${left}px`;
    this.overlay.style.top = `${top}px`;
    this.overlay.style.setProperty('--analysis-map-coord-menu-arrow-left', `${arrowLeft}px`);
  }
}
