import * as L from 'leaflet';
import { DEFAULT_BASE_LAYER_ID, isBaseLayerId, type BaseLayerId } from '../base-layers';
import type { TileLayers } from '../../web-components/analysis-map/tile-layers';

export type FeatureName = 'palitras' | 'deltaKml' | 'pelengs';

export type FeatureToggleState = {
  palitrasEnabled: boolean;
  deltaKmlEnabled: boolean;
  pelengsEnabled: boolean;
};

export interface LayerSwitchControl extends L.Control {
  updateFeatures: (state: FeatureToggleState) => void;
  setCollapsed: (collapsed: boolean) => void;
}

export function createLayerSwitchControl(
  tileLayers: TileLayers,
  features: FeatureToggleState,
  onFeatureToggle: (feature: FeatureName, enabled: boolean) => void,
): LayerSwitchControl {
  const LayerSwitchControlClass = L.Control.extend({
    _tileLayers: tileLayers,
    _currentLayerId: DEFAULT_BASE_LAYER_ID,
    _featureState: features,
    _layerSwitchElement: null as
      | (HTMLElement & {
          setCurrentLayer?: (currentLayer: BaseLayerId) => void;
          setFeatures?: (features: FeatureToggleState) => void;
        })
      | null,

    onAdd: function (map: L.Map) {
      this._map = map;
      this._container = L.DomUtil.create('div', 'leaflet-control layer-switch-control-host');
      const layerSwitchElement = document.createElement(
        'analysis-map-layer-switch',
      ) as HTMLElement & {
        setCurrentLayer?: (currentLayer: BaseLayerId) => void;
        setFeatures?: (features: FeatureToggleState) => void;
      };
      this._layerSwitchElement = layerSwitchElement;
      this._container.appendChild(layerSwitchElement);
      this._syncElementState();

      layerSwitchElement.addEventListener('analysis-map-layer-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ layer?: BaseLayerId }>;
        const layer = customEvent.detail?.layer;
        if (!isBaseLayerId(layer)) {
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
          (feature !== 'palitrasEnabled' &&
            feature !== 'deltaKmlEnabled' &&
            feature !== 'pelengsEnabled') ||
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

    _switchLayer: function (layerId: BaseLayerId) {
      const currentLayer = this._tileLayers[this._currentLayerId];
      if (currentLayer) {
        this._map.removeLayer(currentLayer);
      }
      const newLayer = this._tileLayers[layerId];
      newLayer.addTo(this._map);
      this._currentLayerId = layerId;
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

      this._layerSwitchElement.setCurrentLayer?.(this._currentLayerId);
      this._layerSwitchElement.setFeatures?.(this._featureState);
    },
  });

  return new LayerSwitchControlClass({ position: 'bottomleft' }) as LayerSwitchControl;
}
