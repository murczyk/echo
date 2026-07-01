import * as L from 'leaflet';

export interface MapWindowControl extends L.Control {
  setFullscreen: (isFullscreen: boolean) => void;
}

type AnalysisMapWindowControlElement = HTMLElement & {
  setFullscreen?: (isFullscreen: boolean) => void;
};

type MapWindowControlOptions = {
  showFullscreen?: boolean;
};

export function createMapWindowControl(
  toggleFullscreen: () => void,
  initialFullscreen = false,
  options: MapWindowControlOptions = {},
): MapWindowControl {
  const MapWindowControlClass = L.Control.extend({
    _isFullscreen: initialFullscreen,
    _map: null as L.Map | null,
    _windowControlElement: null as AnalysisMapWindowControlElement | null,

    onAdd: function (_map: L.Map) {
      this._map = _map;
      this._container = L.DomUtil.create('div', 'leaflet-control analysis-map-window-control-host');

      const windowControlElement = document.createElement(
        'analysis-map-window-control'
      ) as AnalysisMapWindowControlElement;
      if (options.showFullscreen === false) {
        windowControlElement.setAttribute('show-fullscreen', 'false');
      }
      this._windowControlElement = windowControlElement;
      windowControlElement.setFullscreen?.(this._isFullscreen);

      windowControlElement.addEventListener('analysis-map-zoom-in', () => {
        this._map?.zoomIn();
      });
      windowControlElement.addEventListener('analysis-map-zoom-out', () => {
        this._map?.zoomOut();
      });
      windowControlElement.addEventListener('analysis-map-toggle-fullscreen', (event: Event) => {
        const customEvent = event as CustomEvent<{ fullscreen?: boolean }>;
        if (typeof customEvent.detail?.fullscreen === 'boolean') {
          this._isFullscreen = customEvent.detail.fullscreen;
        }
        toggleFullscreen();
      });

      this._container.appendChild(windowControlElement);

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      return this._container;
    },

    setFullscreen: function (isFullscreen: boolean) {
      this._isFullscreen = isFullscreen;
      this._windowControlElement?.setFullscreen?.(isFullscreen);
    },
  });

  return new MapWindowControlClass({ position: 'topright' }) as MapWindowControl;
}
