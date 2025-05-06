
import * as L from 'leaflet';

export interface TimeswitchControl extends L.Control {
  updateDates: (newDates: { startDate: number; endDate: number }) => void

}
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
