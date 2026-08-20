import * as L from 'leaflet';

export type FeatureName = 'palitras' | 'pelengs';

export type FeatureToggleState = {
  palitrasEnabled: boolean;
  pelengsEnabled: boolean;
};

export interface LayerSwitchControl extends L.Control {
  updateFeatures: (state: FeatureToggleState) => void;
  setCollapsed: (collapsed: boolean) => void;
}

export function createLayerSwitchControl(
  tileLayers: { openStreetMap: L.TileLayer; googleHybrid: L.TileLayer },
  features: FeatureToggleState,
  onFeatureToggle: (feature: FeatureName, enabled: boolean) => void,
): LayerSwitchControl {
  const LayerSwitchControlClass = L.Control.extend({
    _tileLayers: tileLayers,
    _currentLayer: tileLayers.googleHybrid,
    _featureState: features,
    _layerSwitchElement: null as
      | (HTMLElement & {
          setCurrentLayer?: (currentLayer: 'openStreetMap' | 'googleHybrid') => void;
          setFeatures?: (features: FeatureToggleState) => void;
        })
      | null,

    onAdd: function (map: L.Map) {
      this._map = map;
      this._container = L.DomUtil.create('div', 'leaflet-control layer-switch-control-host');
      const layerSwitchElement = document.createElement(
        'analysis-map-layer-switch',
      ) as HTMLElement & {
        setCurrentLayer?: (currentLayer: 'openStreetMap' | 'googleHybrid') => void;
        setFeatures?: (features: FeatureToggleState) => void;
      };
      this._layerSwitchElement = layerSwitchElement;
      this._container.appendChild(layerSwitchElement);
      this._syncElementState();

      layerSwitchElement.addEventListener('analysis-map-layer-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ layer?: 'openStreetMap' | 'googleHybrid' }>;
        const layer = customEvent.detail?.layer;
        if (layer !== 'openStreetMap' && layer !== 'googleHybrid') {
          return;
        }
        this._switchLayer(layer);
      });
      layerSwitchElement.addEventListener('analysis-map-feature-toggle', (event: Event) => {
        const customEvent = event as CustomEvent<{
          feature?: keyof FeatureToggleState;
          enabled?: boolean;
        }>;
        const feature = customEvent.detail?.feature;
        const enabled = customEvent.detail?.enabled;
        if (
          (feature !== 'palitrasEnabled' && feature !== 'pelengsEnabled') ||
          typeof enabled !== 'boolean'
        ) {
          return;
        }
        this._featureState = { ...this._featureState, [feature]: enabled };
        onFeatureToggle(feature.replace('Enabled', '') as FeatureName, enabled);
        this._syncElementState();
      });

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);

      return this._container;
    },

    onRemove: function (_map: L.Map) {
      this._layerSwitchElement = null;
    },

    _switchLayer: function (layerName: 'openStreetMap' | 'googleHybrid') {
      if (this._currentLayer) {
        this._map.removeLayer(this._currentLayer);
      }
      const newLayer = this._tileLayers[layerName];
      newLayer.addTo(this._map);
      this._currentLayer = newLayer;
      this._syncElementState();
    },

    updateFeatures: function (state: FeatureToggleState) {
      this._featureState = state;
      this._syncElementState();
    },

    setCollapsed: function (collapsed: boolean) {
      this._layerSwitchElement?.setCollapsed?.(collapsed);
    },

    _syncElementState: function () {
      if (!this._layerSwitchElement) {
        return;
      }

      this._layerSwitchElement.setCurrentLayer?.(
        this._currentLayer === this._tileLayers.openStreetMap ? 'openStreetMap' : 'googleHybrid',
      );
      this._layerSwitchElement.setFeatures?.(this._featureState);
    },
  });

  return new LayerSwitchControlClass({ position: 'bottomleft' }) as LayerSwitchControl;
}
