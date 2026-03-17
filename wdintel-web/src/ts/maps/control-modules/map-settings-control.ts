import * as L from 'leaflet';

export interface MapSettingsControl extends L.Control {
  setPelengLabelsVisible: (visible: boolean) => void;
}

export function createMapSettingsControl(
  initialShowPelengLabels: boolean,
  onPelengLabelsChange: (show: boolean) => void
): MapSettingsControl {
  const MapSettingsControlClass = L.Control.extend({
    _showPelengLabels: initialShowPelengLabels,
    _settingsElement: null as (HTMLElement & { setPelengLabelsVisible?: (visible: boolean) => void }) | null,

    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-control map-settings-control-host');
      const settingsElement = document.createElement('analysis-map-settings') as HTMLElement & {
        setPelengLabelsVisible?: (visible: boolean) => void;
      };
      this._settingsElement = settingsElement;
      this._container.appendChild(settingsElement);
      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      settingsElement.setPelengLabelsVisible?.(this._showPelengLabels);
      settingsElement.addEventListener('peleng-labels-visible-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ visible?: boolean }>;
        if (typeof customEvent.detail?.visible !== 'boolean') {
          return;
        }
        this._showPelengLabels = customEvent.detail.visible;
        onPelengLabelsChange(customEvent.detail.visible);
      });
      return this._container;
    },

    setPelengLabelsVisible: function (visible: boolean) {
      if (this._showPelengLabels === visible) return;
      this._showPelengLabels = visible;
      this._settingsElement?.setPelengLabelsVisible?.(visible);
    },
  });

  return new MapSettingsControlClass({ position: 'bottomleft' }) as MapSettingsControl;
}
