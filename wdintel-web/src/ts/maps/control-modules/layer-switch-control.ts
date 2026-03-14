import * as L from 'leaflet';

export type FeatureName = 'palitras' | 'kmz' | 'pelengs';

export type FeatureToggleState = {
  palitrasEnabled: boolean;
  kmzEnabled: boolean;
  pelengsEnabled: boolean;
};

export interface LayerSwitchControl extends L.Control {
  updateFeatures: (state: FeatureToggleState) => void;
}

const STORAGE_KEY = 'layer-control-collapsed';

export function createLayerSwitchControl(
  tileLayers: { openStreetMap: L.TileLayer; googleHybrid: L.TileLayer },
  features: FeatureToggleState,
  onFeatureToggle: (feature: FeatureName, enabled: boolean) => void
): LayerSwitchControl {
  const LayerSwitchControlClass = L.Control.extend({
    _tileLayers: tileLayers,
    _currentLayer: tileLayers.googleHybrid,
    _isCollapsed: true,
    _featureState: features,

    onAdd: function (map: L.Map) {
      this._map = map;
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control layer-switch-control');

      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        this._isCollapsed = saved !== 'false';
      } catch {
        this._isCollapsed = true;
      }

      this._render();

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);

      return this._container;
    },

    _toggleCollapsed: function () {
      this._isCollapsed = !this._isCollapsed;
      try {
        localStorage.setItem(STORAGE_KEY, this._isCollapsed.toString());
      } catch (e) {
        console.warn('Failed to save layer control state:', e);
      }
      this._render();
    },

    _switchLayer: function (layerName: 'openStreetMap' | 'googleHybrid') {
      if (this._currentLayer) {
        this._map.removeLayer(this._currentLayer);
      }
      const newLayer = this._tileLayers[layerName];
      newLayer.addTo(this._map);
      this._currentLayer = newLayer;
      this._render();
    },

    _render: function () {
      if (!this._container) {
        return;
      }

      const header = document.createElement('div');
      header.className = 'layer-switch-header';

      if (this._isCollapsed) {
        const layersIcon = document.createElement('button');
        layersIcon.className = 'layer-switch-icon';
        layersIcon.innerHTML = '<i class="bi bi-layers"></i>';
        layersIcon.type = 'button';
        layersIcon.setAttribute('aria-label', 'Розгорнути список шарів');
        layersIcon.title = 'Розгорнути список шарів';
        layersIcon.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        header.appendChild(layersIcon);
      } else {
        const title = document.createElement('h3');
        title.textContent = 'Шари';

        const toggleButton = document.createElement('button');
        toggleButton.className = 'layer-switch-toggle-button';
        toggleButton.innerHTML = '<i class="bi bi-chevron-down"></i>';
        toggleButton.type = 'button';
        toggleButton.setAttribute('aria-label', 'Згорнути список шарів');
        toggleButton.title = 'Згорнути список шарів';
        toggleButton.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        header.appendChild(title);
        header.appendChild(toggleButton);
      }

      const listContainer = document.createElement('div');
      listContainer.className = 'layer-switch-list';

      const baseTitle = document.createElement('div');
      baseTitle.className = 'layer-switch-subheader';
      baseTitle.textContent = 'Базова мапа';
      listContainer.appendChild(baseTitle);

      const osmItem = this._createLayerItem(
        'OpenStreetMap',
        'openStreetMap',
        this._currentLayer === this._tileLayers.openStreetMap
      );
      listContainer.appendChild(osmItem);

      const hybridItem = this._createLayerItem(
        'Супутник',
        'googleHybrid',
        this._currentLayer === this._tileLayers.googleHybrid
      );
      listContainer.appendChild(hybridItem);

      const featureTitle = document.createElement('div');
      featureTitle.className = 'layer-switch-subheader';
      featureTitle.textContent = 'Шари';
      listContainer.appendChild(featureTitle);

      const featuresList = document.createElement('div');
      featuresList.className = 'layer-switch-features';
      featuresList.appendChild(this._createFeatureItem('palitras', 'Палітри'));
      featuresList.appendChild(this._createFeatureItem('pelengs', 'Пеленги'));
      featuresList.appendChild(this._createFeatureItem('kmz', 'KMZ підкладка'));
      listContainer.appendChild(featuresList);

      this._container.innerHTML = '';
      this._container.appendChild(header);
      this._container.appendChild(listContainer);

      if (this._isCollapsed) {
        this._container.classList.add('collapsed');
      } else {
        this._container.classList.remove('collapsed');
      }
    },

    _createLayerItem: function (
      label: string,
      layerName: 'openStreetMap' | 'googleHybrid',
      isSelected: boolean
    ) {
      const item = document.createElement('div');
      item.className = 'layer-switch-item';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'layer-switch';
      radio.checked = isSelected;
      radio.className = 'layer-switch-radio';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'layer-switch-label';
      labelSpan.textContent = label;

      item.appendChild(radio);
      item.appendChild(labelSpan);

      item.addEventListener('click', (e) => {
        if (e.target !== radio) {
          radio.checked = true;
        }
        this._switchLayer(layerName);
      });

      return item;
    },

    _createFeatureItem: function (feature: FeatureName, label: string) {
      const item = document.createElement('div');
      item.className = 'layer-switch-item feature-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this._featureState[`${feature}Enabled` as keyof FeatureToggleState] as boolean;
      checkbox.className = 'layer-switch-radio';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'layer-switch-label';
      labelSpan.textContent = label;

      item.appendChild(checkbox);
      item.appendChild(labelSpan);

      const toggle = () => {
        checkbox.checked = !checkbox.checked;
        this._featureState = { ...this._featureState, [`${feature}Enabled`]: checkbox.checked };
        onFeatureToggle(feature, checkbox.checked);
        this._render();
      };

      item.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          toggle();
        }
      });
      checkbox.addEventListener('change', () => {
        this._featureState = { ...this._featureState, [`${feature}Enabled`]: checkbox.checked };
        onFeatureToggle(feature, checkbox.checked);
      });

      return item;
    },

    updateFeatures: function (state: FeatureToggleState) {
      this._featureState = state;
      this._render();
    },
  });

  return new LayerSwitchControlClass({ position: 'bottomleft' }) as LayerSwitchControl;
}
