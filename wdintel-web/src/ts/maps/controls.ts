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

function createNarrowControlToggle(label: string, iconPath: string): HTMLButtonElement {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'analysis-map-control-toggle';
  toggle.setAttribute('aria-label', label);
  toggle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${iconPath}" /></svg>`;
  return toggle;
}

function initializeNarrowControlToggle(
  container: HTMLElement,
  toggle: HTMLButtonElement,
  controlClass: string,
): () => void {
  const narrowViewportQuery = window.matchMedia('(max-width: 599.95px)');

  const syncCollapsedState = () => {
    container.classList.toggle('narrow-map-control--collapsed', narrowViewportQuery.matches);
  };

  container.classList.add(controlClass);
  syncCollapsedState();
  const onViewportChange = () => {
    syncCollapsedState();
  };
  narrowViewportQuery.addEventListener('change', onViewportChange);

  L.DomEvent.on(toggle, 'click', L.DomEvent.stopPropagation);
  L.DomEvent.on(toggle, 'click', () => {
    container.classList.remove('narrow-map-control--collapsed');
  });

  return () => {
    narrowViewportQuery.removeEventListener('change', onViewportChange);
  };
}

/** Creates a map control that hosts <analysis-map-search>. */
export function createSearchControl(): SearchControl {
  const SearchControlClass = L.Control.extend({
    _searchElement: null as
      | (HTMLElement & {
          setResultsCount?: (count: number | null) => void;
          setSearchLoading?: (isLoading: boolean) => void;
          setSearchDisabled?: (isDisabled: boolean) => void;
          setPlaceholder?: (placeholder: string) => void;
        })
      | null,
    _disposeNarrowControlToggle: null as (() => void) | null,
    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-bar leaflet-control search-control');
      const toggle = createNarrowControlToggle(
        'Розгорнути пошук на мапі',
        'M10 4a6 6 0 1 0 3.87 10.58l4.78 4.78 1.42-1.42-4.78-4.78A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
      );
      this._container.appendChild(toggle);
      this._disposeNarrowControlToggle = initializeNarrowControlToggle(
        this._container,
        toggle,
        'narrow-map-search-control',
      );
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
    onRemove: function () {
      this._disposeNarrowControlToggle?.();
      this._disposeNarrowControlToggle = null;
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

export function createTimeswitchControl(
  dates: { startDate: number; endDate: number },
  isLoading = false,
) {
  const TimeswitchControl = L.Control.extend({
    _disposeNarrowControlToggle: null as (() => void) | null,
    onAdd: function (map: L.Map) {
      this._container = L.DomUtil.create('div', 'control-container');
      const toggle = createNarrowControlToggle(
        'Розгорнути діапазон дат на мапі',
        'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V9h14v11Zm0-13H5V6h14v1Z',
      );
      this._container.appendChild(toggle);
      this._disposeNarrowControlToggle = initializeNarrowControlToggle(
        this._container,
        toggle,
        'narrow-map-date-control',
      );

      this._dateRangeSelector = L.DomUtil.create('date-range-selector');

      this._dateRangeSelector.setAttribute(
        'dates',
        JSON.stringify({ startDate: dates.startDate, endDate: dates.endDate }),
      );
      this._dateRangeSelector.setAttribute('loading', isLoading ? 'true' : 'false');

      this._container.appendChild(this._dateRangeSelector);

      L.DomEvent.on(this._container, 'click', L.DomEvent.stopPropagation);
      L.DomEvent.on(this._container, 'dblclick', L.DomEvent.stopPropagation);
      return this._container;
    },
    onRemove: function (map: L.Map) {
      this._disposeNarrowControlToggle?.();
      this._disposeNarrowControlToggle = null;
      L.DomEvent.off(this._container, 'click', L.DomEvent.stopPropagation);
      L.DomEvent.off(this._container, 'dblclick', L.DomEvent.stopPropagation);
    },
    updateDates: function (newDates: { startDate: number; endDate: number }) {
      this._dateRangeSelector.setAttribute(
        'dates',
        JSON.stringify({ startDate: newDates.startDate, endDate: newDates.endDate }),
      );
    },
    updateLoading: function (nextLoading: boolean) {
      this._dateRangeSelector.setAttribute('loading', nextLoading ? 'true' : 'false');
    },
  });
  return new TimeswitchControl({ position: 'topleft' });
}
