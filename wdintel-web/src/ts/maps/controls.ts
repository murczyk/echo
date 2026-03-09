
import * as L from 'leaflet';
import { PalitraDetails } from './palitra-types';

export interface TimeswitchControl extends L.Control {
  updateDates: (newDates: { startDate: number; endDate: number }) => void

}

export interface LayerSwitchControl extends L.Control {
  updateFeatures: (state: FeatureToggleState) => void
}

export interface PalitrasControl extends L.Control {
  updatePalitras: (palitras: PalitraDetails[], visibleIds: number[]) => void
  setLoadState: (loadState: PalitrasLoadState) => void
}

export interface SearchControl extends L.Control {
  updateResultsCount: (count: number | null) => void
  updateSearchLoading: (isLoading: boolean) => void
  updateSearchDisabled: (isDisabled: boolean) => void
  updatePlaceholder: (placeholder: string) => void
}

export interface MapWindowControl extends L.Control {
  setFullscreen: (isFullscreen: boolean) => void
}

export type FeatureName = 'palitras' | 'kmz' | 'pelengs';

export type FeatureToggleState = {
  palitrasEnabled: boolean;
  kmzEnabled: boolean;
  pelengsEnabled: boolean;
};

export type PalitrasLoadState = 'idle' | 'loading' | 'success' | 'error';

/** Creates a map control that hosts <analysis-map-search>. */
export function createSearchControl(): SearchControl {
  const SearchControlClass = L.Control.extend({
    _searchElement: null as (HTMLElement & {
      setResultsCount?: (count: number | null) => void;
      setSearchLoading?: (isLoading: boolean) => void;
      setSearchDisabled?: (isDisabled: boolean) => void;
      setPlaceholder?: (placeholder: string) => void;
    }) | null,
    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control search-control');
      const searchEl = document.createElement('analysis-map-search') as HTMLElement & {
        setResultsCount?: (count: number | null) => void;
        setSearchLoading?: (isLoading: boolean) => void;
        setSearchDisabled?: (isDisabled: boolean) => void;
        setPlaceholder?: (placeholder: string) => void;
      };
      this._searchElement = searchEl;
      this._container.appendChild(searchEl);
      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      return this._container;
    },
    updateResultsCount: function (count: number | null) {
      this._searchElement?.setResultsCount?.(count);
    },
    updateSearchLoading: function (isLoading: boolean) {
      this._searchElement?.setSearchLoading?.(isLoading);
    },
    updateSearchDisabled: function (isDisabled: boolean) {
      this._searchElement?.setSearchDisabled?.(isDisabled);
    },
    updatePlaceholder: function (placeholder: string) {
      this._searchElement?.setPlaceholder?.(placeholder);
    }
  });

  return new SearchControlClass({ position: 'topleft' }) as SearchControl;
}

export function createMapZoomControl() {
  const ZoomControlClass = L.Control.extend({
    onAdd: function(map: L.Map) {
      this._map = map;
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control analysis-map-zoom-control');

      const createButton = (iconClass: string, ariaLabel: string, onClick: () => void) => {
        const button = document.createElement('button');
        button.className = 'analysis-map-zoom-button';
        button.type = 'button';
        button.setAttribute('aria-label', ariaLabel);
        button.title = ariaLabel;
        button.innerHTML = `<i class="${iconClass}"></i>`;
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
        return button;
      };

      const zoomInButton = createButton('bi bi-plus-lg', 'Збільшити мапу', () => this._map.zoomIn());
      const zoomOutButton = createButton('bi bi-dash-lg', 'Зменшити мапу', () => this._map.zoomOut());

      this._container.appendChild(zoomInButton);
      this._container.appendChild(zoomOutButton);

      L.DomEvent.on(this._container, 'dblclick', (e) => {
        e.stopPropagation();
        L.DomEvent.preventDefault(e);
      });

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      return this._container;
    },
  });

  return new ZoomControlClass({ position: 'bottomright' });
}

export function createLayerSwitchControl(
  tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer },
  features: FeatureToggleState,
  onFeatureToggle: (feature: FeatureName, enabled: boolean) => void
): LayerSwitchControl {
  const STORAGE_KEY = 'layer-control-collapsed';
  
  const LayerSwitchControl = L.Control.extend({
    _tileLayers: tileLayers,
    _currentLayer: tileLayers.googleHybrid,
    _isCollapsed: true,
    _featureState: features,

    onAdd: function(map: L.Map) {
      this._map = map; // Store map reference from onAdd
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control layer-switch-control');
      
      // Load collapsed state from localStorage (default: collapsed)
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        this._isCollapsed = saved !== 'false';
      } catch (e) {
        this._isCollapsed = true;
      }
      
      this._render();
      
      // Prevent map events from bubbling through the control
      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);
      
      return this._container;
    },

    onRemove: function(map: L.Map) {
      // Cleanup if needed
    },
    
    _toggleCollapsed: function() {
      this._isCollapsed = !this._isCollapsed;
      
      // Save state to localStorage
      try {
        localStorage.setItem(STORAGE_KEY, this._isCollapsed.toString());
      } catch (e) {
        console.warn('Failed to save layer control state:', e);
      }
      
      // Re-render to update structure
      this._render();
    },

    _switchLayer: function(layerName: 'openStreetMap' | 'googleHybrid') {
      // Remove current layer
      if (this._currentLayer) {
        this._map.removeLayer(this._currentLayer);
      }
      
      // Add new layer
      const newLayer = this._tileLayers[layerName];
      newLayer.addTo(this._map);
      this._currentLayer = newLayer;
      
      // Re-render to update selected state
      this._render();
    },

    _render: function() {
      if (!this._container) {
        return;
      }

      const header = document.createElement('div');
      header.className = 'layer-switch-header';
      
      if (this._isCollapsed) {
        // Collapsed state: only layers icon
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
        // Expanded state: title and collapse button
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
      
      // OpenStreetMap option
      const osmItem = this._createLayerItem(
        'OpenStreetMap',
        'openStreetMap',
        this._currentLayer === this._tileLayers.openStreetMap
      );
      listContainer.appendChild(osmItem);
      
      // Google Hybrid option
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
      
      // Apply collapsed class if needed
      if (this._isCollapsed) {
        this._container.classList.add('collapsed');
      } else {
        this._container.classList.remove('collapsed');
      }
    },
    
    _createLayerItem: function(label: string, layerName: 'openStreetMap' | 'googleHybrid', isSelected: boolean) {
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

    _createFeatureItem: function(feature: FeatureName, label: string) {
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
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        this._featureState = { ...this._featureState, [`${feature}Enabled`]: checkbox.checked };
        onFeatureToggle(feature, checkbox.checked);
      });

      return item;
    },

    updateFeatures: function(state: FeatureToggleState) {
      this._featureState = state;
      this._render();
    }
  });

  return new LayerSwitchControl({ position: 'bottomleft' });
}

export function createAttributionControl() {
  return L.control.attribution({ position: 'bottomleft' });
}

export function createTimeswitchControl(dates: { startDate: number; endDate: number }) {
  const TimeswitchControl = L.Control.extend({
    onAdd: function(map: L.Map) {
      this._container = L.DomUtil.create('div', 'control-container');

      this._dateRangeSelector = L.DomUtil.create('date-range-selector')

      this._dateRangeSelector.setAttribute('dates', JSON.stringify({ startDate: dates.startDate, endDate: dates.endDate }))

      this._container.appendChild(this._dateRangeSelector)

      L.DomEvent.on(this._container, 'click', L.DomEvent.stopPropagation)
      L.DomEvent.on(this._container, 'dblclick', L.DomEvent.stopPropagation)
      return this._container;
    },
    onRemove: function(map: L.Map) {
      L.DomEvent.off(this._container, 'click', L.DomEvent.stopPropagation)
      L.DomEvent.off(this._container, 'dblclick', L.DomEvent.stopPropagation)
    },
    updateDates: function(newDates: { startDate: number, endDate: number }) {
      this._dateRangeSelector.setAttribute('dates', JSON.stringify({ startDate: newDates.startDate, endDate: newDates.endDate }))
    }
  });
  return new TimeswitchControl({ position: 'topleft' })
}



export function createExitControl2(closeMap: () => void) {
  const ExitControl = L.Control.extend({
    _closeMapHandler: (event: Event) => {
      L.DomEvent.stopPropagation(event);
      L.DomEvent.preventDefault(event)
      closeMap.call(this, event)
    },
    onAdd: function(map: L.Map) {
      let container = L.DomUtil.create('div', 'exit-button');
      this._button = L.DomUtil.create('div', '', container);
      this._button.innerHTML = '<i class="bi bi-x-lg" style="font-size: 18px;"></i>';
      L.DomEvent.on(this._button, 'click', this._closeMapHandler)
      return container;
    },
    onRemove: function(map: L.Map) {
      L.DomEvent.off(this._button, 'click', this._closeMapHandler)
    }
  });
  return new ExitControl({ position: 'topright' });
}

export function createMapWindowControl(
  closeMap: () => void,
  toggleFullscreen: () => void,
  initialFullscreen = false
): MapWindowControl {
  const MapWindowControlClass = L.Control.extend({
    _isFullscreen: initialFullscreen,
    _fullscreenButton: null as HTMLButtonElement | null,

    _updateFullscreenButton: function() {
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

    onAdd: function(_map: L.Map) {
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

    setFullscreen: function(isFullscreen: boolean) {
      this._isFullscreen = isFullscreen;
      this._updateFullscreenButton();
    }
  });

  return new MapWindowControlClass({ position: 'topright' }) as MapWindowControl;
}

export function createPalitrasControl(
  palitras: PalitraDetails[], 
  visibleIds: number[],
  onVisibleIdsChange: (visibleIds: number[]) => void
): PalitrasControl {
  type PalitrasElementApi = HTMLElement & {
    setPalitras?: (palitras: PalitraDetails[]) => void;
    setVisibleIds?: (visibleIds: number[]) => void;
    setLoadState?: (loadState: PalitrasLoadState) => void;
  };

  const PalitrasControl = L.Control.extend({
    _palitras: palitras,
    _visibleIds: visibleIds,
    _loadState: 'idle' as PalitrasLoadState,
    _palitrasElement: null as PalitrasElementApi | null,

    onAdd: function(_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-control palitras-control-host');
      const palitrasElement = document.createElement('analysis-map-palitras') as PalitrasElementApi;
      this._palitrasElement = palitrasElement;
      this._container.appendChild(palitrasElement);

      this._syncElementState();

      palitrasElement.addEventListener('palitras-visible-ids-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ visibleIds?: number[] }>;
        const ids = customEvent.detail?.visibleIds;
        if (!Array.isArray(ids)) {
          return;
        }
        const normalizedIds = normalizeVisibleIds(ids);
        this._visibleIds = normalizedIds;
        onVisibleIdsChange(normalizedIds);
      });

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);

      return this._container;
    },

    onRemove: function(_map: L.Map) {
      this._palitrasElement = null;
    },

    _syncElementState: function() {
      if (!this._palitrasElement) {
        return;
      }
      this._palitrasElement.setPalitras?.(this._palitras);
      this._palitrasElement.setVisibleIds?.(this._visibleIds);
      this._palitrasElement.setLoadState?.(this._loadState);
    },

    updatePalitras: function(palitras: PalitraDetails[], visibleIds: number[]) {
      this._palitras = palitras;
      this._visibleIds = normalizeVisibleIds(visibleIds);
      this._syncElementState();
    },

    setLoadState: function(loadState: PalitrasLoadState) {
      this._loadState = loadState;
      this._syncElementState();
    }
  });

  return new PalitrasControl({ position: 'topright' });
}

function normalizeVisibleIds(input: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  input.forEach((value) => {
    if (!Number.isFinite(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });
  return result;
}
