import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as L from 'leaflet';
import {
  initializeMap,
  addPointsToLayer,
  toggleMapSize,
  createExitControl,
  createFullScreenControl,
  clearSmallMapFullscreenBodyLock,
} from '../maps/maps';
import { MapPointShort } from '../maps/types';

@customElement('small-map')
export class SmallMap extends LitElement {
  @property() points: MapPointShort[] = [];
  @property() isOpen = false;
  @property() withExitButton = true;
  private map?: L.Map;
  private mapBounds?: L.LatLngBounds;
  private mapContainer?: HTMLDivElement;
  private fullScreenControl?: L.Control & { setExpanded?: (isExpanded: boolean) => void };

  static styles = css``;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return;
    }

    if (!this.map || !this.mapBounds || !this.mapContainer?.classList.contains('expanded')) {
      return;
    }

    event.preventDefault();
    toggleMapSize(this.map, this.mapContainer, this.mapBounds, this.fullScreenControl);
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.onKeyDown);
    clearSmallMapFullscreenBodyLock();
    super.disconnectedCallback();
  }

  firstUpdated() {
    this.setupMap();
  }

  protected createRenderRoot() {
    return this;
  }

  setupMap() {
    const mapContainer = this.renderRoot.querySelector<HTMLDivElement>('#map-container-networks');

    if (mapContainer) {
      const map = initializeMap(mapContainer, this.points[0]);

      const { bounds, markersGroup } = addPointsToLayer(this.points);
      this.map = map;
      this.mapBounds = bounds;
      this.mapContainer = mapContainer;
      map.addLayer(markersGroup);
      if (bounds.isValid()) {
        map.fitBounds(bounds);
      }

      // Add controls and other map logic here...

      // Example of handling fullscreen toggle
      const toggleSize = () => toggleMapSize(map, mapContainer, bounds, fullScreenControl);
      const FullScreenControl = createFullScreenControl(toggleSize);
      const fullScreenControl: any = new FullScreenControl();
      this.fullScreenControl = fullScreenControl;
      L.extend(FullScreenControl.prototype, L.Evented.prototype);
      map.addControl(fullScreenControl);
      if (this.withExitButton) {
        map.addControl(
          new (createExitControl(this._closeMap.bind(this)))({ position: 'topright' }),
        );
      }
    } else {
      throw new Error('Map container is not found');
    }
  }

  private _closeMap() {
    clearSmallMapFullscreenBodyLock();
    const event = new CustomEvent('close-map', {
      detail: {},
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  render() {
    return html`<div id="map-container-networks" style="width: 100%; height: 100%"></div>`;
  }
}
