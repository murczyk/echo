import * as L from 'leaflet';

export interface MapWindowControl extends L.Control {
  setFullscreen: (isFullscreen: boolean) => void;
}

export function createMapWindowControl(
  closeMap: () => void,
  toggleFullscreen: () => void,
  initialFullscreen = false
): MapWindowControl {
  const MapWindowControlClass = L.Control.extend({
    _isFullscreen: initialFullscreen,
    _fullscreenButton: null as HTMLButtonElement | null,

    _updateFullscreenButton: function () {
      if (!this._fullscreenButton) {
        return;
      }

      this._fullscreenButton.innerHTML = this._isFullscreen
        ? '<i class="bi bi-fullscreen-exit"></i>'
        : '<i class="bi bi-arrows-fullscreen"></i>';
      this._fullscreenButton.setAttribute(
        'aria-label',
        this._isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу'
      );
      this._fullscreenButton.title = this._isFullscreen ? 'Згорнути мапу' : 'Розгорнути мапу';
    },

    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control analysis-map-window-control');

      const fullscreenButton = document.createElement('button');
      fullscreenButton.className = 'analysis-map-window-button';
      fullscreenButton.type = 'button';
      fullscreenButton.addEventListener('click', (event) => {
        L.DomEvent.stopPropagation(event);
        L.DomEvent.preventDefault(event);
        this._isFullscreen = !this._isFullscreen;
        this._updateFullscreenButton();
        toggleFullscreen();
      });
      this._fullscreenButton = fullscreenButton;
      this._updateFullscreenButton();

      const closeButton = document.createElement('button');
      closeButton.className = 'analysis-map-window-button';
      closeButton.type = 'button';
      closeButton.innerHTML = '<i class="bi bi-x-lg"></i>';
      closeButton.setAttribute('aria-label', 'Закрити мапу');
      closeButton.title = 'Закрити мапу';
      closeButton.addEventListener('click', (event) => {
        L.DomEvent.stopPropagation(event);
        L.DomEvent.preventDefault(event);
        closeMap();
      });

      this._container.appendChild(fullscreenButton);
      this._container.appendChild(closeButton);

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      return this._container;
    },

    setFullscreen: function (isFullscreen: boolean) {
      this._isFullscreen = isFullscreen;
      this._updateFullscreenButton();
    },
  });

  return new MapWindowControlClass({ position: 'topright' }) as MapWindowControl;
}
