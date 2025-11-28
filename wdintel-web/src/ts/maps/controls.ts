
import * as L from 'leaflet';

export interface TimeswitchControl extends L.Control {
  updateDates: (newDates: { startDate: number; endDate: number }) => void

}

export interface PalitrasControl extends L.Control {
  updatePalitras: (palitras: Palitra[], visibleIds: number[]) => void
}

type Coords = { lat: number; lng: number };
type Geometry = { center: Coords; perimeterLinearRing: Coords[] };
type Palitra = {
  id: number;
  name: string;
  colorHex: string;
  geometry: Geometry | null;
};
export function createLayerSwitchControl(tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer }) {
  return L.control.layers({ 'OpenStreetMap': tileLayers.openStreetMap, 'Супутник': tileLayers.googleHybrid });
}

export function createAttributionControl() {
  return L.control.attribution({});
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
  palitras: Palitra[], 
  visibleIds: number[],
  onToggle: (palitraId: number) => void
): PalitrasControl {
  const PalitrasControl = L.Control.extend({
    _palitras: palitras,
    _visibleIds: visibleIds,
    _onToggle: onToggle,

    onAdd: function(map: L.Map) {
      this._container = L.DomUtil.create('div', 'palitras-control');
      
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

    _render: function() {
      if (!this._container) {
        return;
      }
      
      if (!this._palitras || this._palitras.length === 0) {
        this._container.innerHTML = '';
        return;
      }

      const header = document.createElement('div');
      header.className = 'palitras-control-header';
      header.innerHTML = '<h3>Палітри</h3>';

      const listContainer = document.createElement('div');
      listContainer.className = 'palitras-control-list';

      this._palitras.forEach((palitra: Palitra) => {
        if (palitra && palitra.id !== undefined) {
          const item = this._createPalitraItem(palitra);
          listContainer.appendChild(item);
        }
      });

      this._container.innerHTML = '';
      this._container.appendChild(header);
      this._container.appendChild(listContainer);
    },

    _createPalitraItem: function(palitra: Palitra) {
      const item = document.createElement('div');
      item.className = 'palitra-item';
      
      const isVisible = this._visibleIds.includes(palitra.id);
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isVisible;
      checkbox.className = 'palitra-checkbox';
      
      const colorBox = document.createElement('span');
      colorBox.className = 'palitra-color';
      colorBox.style.backgroundColor = palitra.colorHex;
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'palitra-name';
      nameSpan.textContent = palitra.name;
      
      const infoDiv = document.createElement('div');
      infoDiv.className = 'palitra-info';
      
      if (palitra.geometry && palitra.geometry.center && palitra.geometry.perimeterLinearRing) {
        const centerText = `Центр: ${palitra.geometry.center.lat.toFixed(4)}, ${palitra.geometry.center.lng.toFixed(4)}`;
        const pointsText = `Точок: ${palitra.geometry.perimeterLinearRing.length}`;
        infoDiv.innerHTML = `<div>${centerText}</div><div>${pointsText}</div>`;
      } else {
        infoDiv.innerHTML = '<div>Без геометрії</div>';
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

    updatePalitras: function(palitras: Palitra[], visibleIds: number[]) {
      this._palitras = palitras;
      this._visibleIds = visibleIds;
      this._render();
    }
  });

  return new PalitrasControl({ position: 'topright' });
}
