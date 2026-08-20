import * as L from 'leaflet';

export interface MapSettingsControl extends L.Control {
  setPelengLabelsVisible: (visible: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
  setSettlementVisibility: (canShow: boolean, show: boolean) => void;
}

export function createMapSettingsControl(
  initialShowPelengLabels: boolean,
  onPelengLabelsChange: (show: boolean) => void,
  canShowSettlements: boolean,
  initialShowSettlements: boolean,
  onShowSettlementsChange: (show: boolean) => void,
): MapSettingsControl {
  const MapSettingsControlClass = L.Control.extend({
    _showPelengLabels: initialShowPelengLabels,
    _canShowSettlements: canShowSettlements,
    _showSettlements: canShowSettlements && initialShowSettlements,
    _settingsElement: null as
      | (HTMLElement & {
          setPelengLabelsVisible?: (visible: boolean) => void;
          setSettlementVisibility?: (canShow: boolean, show: boolean) => void;
        })
      | null,

    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-control map-settings-control-host');
      const settingsElement = document.createElement('analysis-map-settings') as HTMLElement & {
        setPelengLabelsVisible?: (visible: boolean) => void;
        setSettlementVisibility?: (canShow: boolean, show: boolean) => void;
      };
      this._settingsElement = settingsElement;
      this._container.appendChild(settingsElement);
      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      settingsElement.setPelengLabelsVisible?.(this._showPelengLabels);
      settingsElement.setSettlementVisibility?.(this._canShowSettlements, this._showSettlements);
      settingsElement.addEventListener('peleng-labels-visible-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ visible?: boolean }>;
        if (typeof customEvent.detail?.visible !== 'boolean') {
          return;
        }
        this._showPelengLabels = customEvent.detail.visible;
        onPelengLabelsChange(customEvent.detail.visible);
      });
      settingsElement.addEventListener('show-settlements-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ show?: boolean }>;
        if (typeof customEvent.detail?.show !== 'boolean') return;
        this._showSettlements = this._canShowSettlements && customEvent.detail.show;
        onShowSettlementsChange(this._showSettlements);
      });
      return this._container;
    },

    setPelengLabelsVisible: function (visible: boolean) {
      if (this._showPelengLabels === visible) return;
      this._showPelengLabels = visible;
      this._settingsElement?.setPelengLabelsVisible?.(visible);
    },

    setCollapsed: function (collapsed: boolean) {
      this._settingsElement?.setCollapsed?.(collapsed);
    },

    setSettlementVisibility: function (canShow: boolean, show: boolean) {
      this._canShowSettlements = canShow;
      this._showSettlements = canShow && show;
      this._settingsElement?.setSettlementVisibility?.(
        this._canShowSettlements,
        this._showSettlements,
      );
    },
  });

  return new MapSettingsControlClass({ position: 'bottomright' }) as MapSettingsControl;
}
