import * as L from 'leaflet';

export {
  createLayerSwitchControl,
  createMapSettingsControl,
  createMapWindowControl,
  createPalitrasControl,
  type FeatureName,
  type FeatureToggleState,
  type LayerSwitchControl,
  type MapSettingsControl,
  type MapWindowControl,
  type PalitrasControl,
  type PalitrasLoadState,
} from './control-modules';

export interface TimeswitchControl extends L.Control {
  updateDates: (newDates: { startDate: number; endDate: number }) => void;
  updateLoading: (isLoading: boolean) => void;
}

export interface SearchControl extends L.Control {
  updateResultsCount: (count: number | null) => void;
  updateSearchLoading: (isLoading: boolean) => void;
  updateSearchDisabled: (isDisabled: boolean) => void;
  updatePlaceholder: (placeholder: string) => void;
}

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
    },
  });

  return new SearchControlClass({ position: 'topleft' }) as SearchControl;
}

export function createAttributionControl() {
  return L.control.attribution({ position: 'bottomleft' });
}

export function createTimeswitchControl(dates: { startDate: number; endDate: number }, isLoading = false) {
  const TimeswitchControl = L.Control.extend({
    onAdd: function (map: L.Map) {
      this._container = L.DomUtil.create('div', 'control-container');

      this._dateRangeSelector = L.DomUtil.create('date-range-selector');

      this._dateRangeSelector.setAttribute(
        'dates',
        JSON.stringify({ startDate: dates.startDate, endDate: dates.endDate })
      );
      this._dateRangeSelector.setAttribute('loading', isLoading ? 'true' : 'false');

      this._container.appendChild(this._dateRangeSelector);

      L.DomEvent.on(this._container, 'click', L.DomEvent.stopPropagation);
      L.DomEvent.on(this._container, 'dblclick', L.DomEvent.stopPropagation);
      return this._container;
    },
    onRemove: function (map: L.Map) {
      L.DomEvent.off(this._container, 'click', L.DomEvent.stopPropagation);
      L.DomEvent.off(this._container, 'dblclick', L.DomEvent.stopPropagation);
    },
    updateDates: function (newDates: { startDate: number; endDate: number }) {
      this._dateRangeSelector.setAttribute(
        'dates',
        JSON.stringify({ startDate: newDates.startDate, endDate: newDates.endDate })
      );
    },
    updateLoading: function (nextLoading: boolean) {
      this._dateRangeSelector.setAttribute('loading', nextLoading ? 'true' : 'false');
    },
  });
  return new TimeswitchControl({ position: 'topleft' });
}
