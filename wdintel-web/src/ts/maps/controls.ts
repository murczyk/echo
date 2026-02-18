
import * as L from 'leaflet';
import { Palitra, PalitraDetails } from './palitra-types';

export interface TimeswitchControl extends L.Control {
  updateDates: (newDates: { startDate: number; endDate: number }) => void

}

export interface LayerSwitchControl extends L.Control {
  updateFeatures: (state: FeatureToggleState) => void
}

export interface PalitrasControl extends L.Control {
  updatePalitras: (palitras: PalitraDetails[], visibleIds: number[]) => void
}

export interface SearchControl extends L.Control {
  updateResultsCount: (count: number | null) => void
  updateSearchLoading: (isLoading: boolean) => void
}

export type FeatureName = 'palitras' | 'kmz' | 'pelengs';

export type FeatureToggleState = {
  palitrasEnabled: boolean;
  kmzEnabled: boolean;
  pelengsEnabled: boolean;
};

/** Creates a map control that hosts <analysis-map-search>. */
export function createSearchControl(): SearchControl {
  const SearchControlClass = L.Control.extend({
    _searchElement: null as (HTMLElement & { setResultsCount?: (count: number | null) => void; setSearchLoading?: (isLoading: boolean) => void }) | null,
    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control search-control');
      const searchEl = document.createElement('analysis-map-search') as HTMLElement & { setResultsCount?: (count: number | null) => void; setSearchLoading?: (isLoading: boolean) => void };
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
        button.innerHTML = `<i class="${iconClass}"></i>`;
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
        return button;
      };

      const zoomInButton = createButton('bi bi-plus-lg', 'Zoom in', () => this._map.zoomIn());
      const zoomOutButton = createButton('bi bi-dash-lg', 'Zoom out', () => this._map.zoomOut());

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
        layersIcon.setAttribute('aria-label', 'Expand layers list');
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
        toggleButton.setAttribute('aria-label', 'Collapse layers list');
        
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

export function createPalitrasControl(
  palitras: PalitraDetails[], 
  visibleIds: number[],
  onToggle: (palitraId: number) => void
): PalitrasControl {
  const STORAGE_KEY = 'palitras-control-collapsed';
  
  const PalitrasControl = L.Control.extend({
    _palitras: palitras,
    _visibleIds: visibleIds,
    _onToggle: onToggle,
    _isCollapsed: false,
    _renderedPalitrasSignature: null as string | null,

    onAdd: function(map: L.Map) {
      this._container = L.DomUtil.create('div', 'palitras-control');
      
      // Load collapsed state from localStorage (default: expanded)
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        this._isCollapsed = saved === 'true';
      } catch (e) {
        this._isCollapsed = false;
      }
      
      // Don't render immediately - wait for palitras data
      if (this._palitras && this._palitras.length > 0) {
        this._render();
      }
      
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
        console.warn('Failed to save palitras control state:', e);
      }
      
      // Re-render to update header structure
      this._render();
    },

    _getPalitrasSignature: function(palitrasState: PalitraDetails[]) {
      return palitrasState
        .map((palitraDetails: PalitraDetails) => {
          const palitra = palitraDetails.palitra;
          const geometry = palitra.geometry;
          const geometrySignature = geometry
            ? `${geometry.center.lat}:${geometry.center.lng}:${geometry.perimeter_linear_ring.length}`
            : 'none';
          return `${palitra.id}|${palitra.name}|${palitra.color_hex}|${geometrySignature}|${palitraDetails.points.length}`;
        })
        .join(';');
    },

    _render: function() {
      if (!this._container) {
        return;
      }

      const previousList = this._container.querySelector('.palitras-control-list') as HTMLDivElement | null;
      const previousScrollTop = previousList?.scrollTop ?? 0;
      
      if (!this._palitras || this._palitras.length === 0) {
        this._container.innerHTML = '';
        return;
      }

      // Create header with title and toggle button
      const header = document.createElement('div');
      header.className = 'palitras-control-header';
      
      if (this._isCollapsed) {
        // Collapsed state: only palette icon
        const paletteIcon = document.createElement('button');
        paletteIcon.className = 'palitras-palette-icon';
        paletteIcon.innerHTML = '<i class="bi bi-palette"></i>';
        paletteIcon.type = 'button';
        paletteIcon.setAttribute('aria-label', 'Expand palitras list');
        paletteIcon.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        header.appendChild(paletteIcon);
      } else {
        // Expanded state: title and collapse button
        const title = document.createElement('h3');
        title.textContent = 'Палітри';
        
        const toggleButton = document.createElement('button');
        toggleButton.className = 'palitras-toggle-button';
        toggleButton.innerHTML = '<i class="bi bi-chevron-down"></i>';
        toggleButton.type = 'button';
        toggleButton.setAttribute('aria-label', 'Collapse palitras list');
        
        // Store reference to update icon later
        this._toggleButton = toggleButton;
        
        toggleButton.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleCollapsed();
        });
        
        header.appendChild(title);
        header.appendChild(toggleButton);
      }

      const listContainer = document.createElement('div');
      listContainer.className = 'palitras-control-list';

      this._palitras.forEach((palitraDetails: PalitraDetails) => {
        if (palitraDetails && palitraDetails.palitra && palitraDetails.palitra.id !== undefined) {
          const item = this._createPalitraItem(palitraDetails);
          listContainer.appendChild(item);
        }
      });

      this._container.innerHTML = '';
      this._container.appendChild(header);
      this._container.appendChild(listContainer);
      this._renderedPalitrasSignature = this._getPalitrasSignature(this._palitras);

      if (previousScrollTop > 0) {
        listContainer.scrollTop = previousScrollTop;
      }
      
      // Apply collapsed class if needed
      if (this._isCollapsed) {
        this._container.classList.add('collapsed');
      } else {
        this._container.classList.remove('collapsed');
      }
    },

    _createPalitraItem: function(palitraDetails: PalitraDetails) {
      const palitra = palitraDetails.palitra;
      const points = palitraDetails.points;
      
      const item = document.createElement('div');
      item.className = 'palitra-item';
      item.dataset.palitraId = String(palitra.id);
      
      const isVisible = this._visibleIds.includes(palitra.id);
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isVisible;
      checkbox.className = 'palitra-checkbox';
      
      const colorBox = document.createElement('span');
      colorBox.className = 'palitra-color';
      colorBox.style.backgroundColor = palitra.color_hex;
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'palitra-name';
      nameSpan.textContent = palitra.name;
      
      const infoDiv = document.createElement('div');
      infoDiv.className = 'palitra-info';
      
      if (palitra.geometry && palitra.geometry.center && palitra.geometry.perimeter_linear_ring) {
        const centerText = `Центр: ${palitra.geometry.center.lat.toFixed(4)}, ${palitra.geometry.center.lng.toFixed(4)}`;
        const perimeterPointsText = `Точок периметру: ${palitra.geometry.perimeter_linear_ring.length}`;
        const dataPointsText = points.length > 0 ? `Точок даних: ${points.length}` : '';
        infoDiv.innerHTML = `<div>${centerText}</div><div>${perimeterPointsText}</div>${dataPointsText ? `<div>${dataPointsText}</div>` : ''}`;
      } else {
        const dataPointsText = points.length > 0 ? `Точок даних: ${points.length}` : '';
        infoDiv.innerHTML = dataPointsText ? `<div>${dataPointsText}</div>` : '<div>Без геометрії</div>';
      }
      
      const contentDiv = document.createElement('div');
      contentDiv.className = 'palitra-content';
      
      const titleDiv = document.createElement('div');
      titleDiv.className = 'palitra-title';
      titleDiv.appendChild(colorBox);
      titleDiv.appendChild(nameSpan);
      
      contentDiv.appendChild(titleDiv);
      contentDiv.appendChild(infoDiv);
      
      item.appendChild(checkbox);
      item.appendChild(contentDiv);
      
      // Handle click on entire item
      item.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
        this._onToggle(palitra.id);
      });
      
      return item;
    },

    _syncVisibleCheckboxes: function() {
      if (!this._container) {
        return;
      }
      const visibleIdsSet = new Set(this._visibleIds);
      const items = this._container.querySelectorAll('.palitra-item');
      items.forEach((itemEl) => {
        const item = itemEl as HTMLDivElement;
        const palitraId = Number(item.dataset.palitraId);
        if (!Number.isFinite(palitraId)) {
          return;
        }
        const checkbox = item.querySelector('.palitra-checkbox') as HTMLInputElement | null;
        if (checkbox) {
          checkbox.checked = visibleIdsSet.has(palitraId);
        }
      });
    },

    updatePalitras: function(palitras: PalitraDetails[], visibleIds: number[]) {
      const nextSignature = this._getPalitrasSignature(palitras);
      const shouldFullRender = this._renderedPalitrasSignature !== nextSignature;
      this._palitras = palitras;
      this._visibleIds = visibleIds;
      if (shouldFullRender) {
        this._render();
        return;
      }
      this._syncVisibleCheckboxes();
    }
  });

  return new PalitrasControl({ position: 'topright' });
}
