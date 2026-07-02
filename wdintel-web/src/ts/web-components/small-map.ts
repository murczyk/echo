import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as L from 'leaflet';
import {
  loadKmzData,
  initializeMap,
  addPointsToLayer,
  toggleMapSize,
  createExitControl,
  createFullScreenControl,
  clearSmallMapFullscreenBodyLock,
} from '../maps/maps';
import { kmzLayerFactory } from '../maps/leaflet-kmz';
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

  async setupMap() {
    const kmzData = await loadKmzData();
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

      if (kmzData) {
        const kmz = kmzLayerFactory(null, { bindTooltip: true, bindPopup: false });
        kmz.addTo(map);
        kmz.parse(kmzData, {});

        fullScreenControl.on('fullscreen-toggled', () => {
          const isMapOpened = map.getSize().x > 250;
          kmz.eachLayer((layer: any) => {
            layer.eachLayer((l: any) => {
              if (l.feature.properties.name) {
                l.unbindTooltip();
                if (isMapOpened) {
                  l.bindTooltip('<b>' + l.feature.properties.name + '</b>', {
                    permanent: true,
                    direction: 'center',
                    opacity: 0,
                  });
                } else {
                  l.bindTooltip('<b>' + l.feature.properties.name + '</b>', {
                    permanent: false,
                    direction: 'center',
                    opacity: 0,
                  });
                }
              }
            });
          });
        });
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

  // Define your methods like loadKmzData, initializeMap, addPointsToLayer, etc.

  render() {
    return html`<div id="map-container-networks" style="width: 100%; height: 100%"></div>`;
  }
}
