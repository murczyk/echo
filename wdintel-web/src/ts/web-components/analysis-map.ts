import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { loadKmzData } from '../maps/maps'
import { KMZLayer, kmzLayerFactory } from '../maps/leaflet-kmz'
import { MapPointDetailed } from '../maps/types';
import { messagesCountText } from '../maps/utils/language-utils';
import { loadRerAnalysisQueryState, RerAnalysisQueryState, saveRerAnalysisQueryState } from '../rer-analysis-query-state';
import { TimeswitchControl, FeatureToggleState, createLayerSwitchControl, createTimeswitchControl, createAttributionControl, createPalitrasControl, FeatureName, LayerSwitchControl, createSearchControl, createMapZoomControl, SearchControl, createMapWindowControl, MapWindowControl, createMapSettingsControl, MapSettingsControl, PalitrasLoadState } from '../maps/controls';
import { AnalysisMapStateStore, AnalysisMapStoredState } from '../maps/analysis-map-state';
import { parseCoordinateInput } from '../maps/coordinate-search';
import { PalitraManager } from '../maps/palitra-manager';
import { PalitraDetails } from '../maps/palitra-types';

type NetworkUnit = { frequencies: string[]; name: string }
type Message = [
  number,
  {
    message_uid?: string;
    freq?: string;
    coords?: number[];
    text: string;
    date?: string;
    time?: string;
    unit?: string | null;
    network_ids?: number[] | null;
  }
]

type CoordinateMenuTarget = {
  lat: number;
  lng: number;
  mgrsCoords?: string | null;
};


export class DataCircleMarker extends L.CircleMarker {
  data: { messageId: number };

  constructor(latLng: L.LatLngExpression, data: { messageId: number }, options: L.CircleMarkerOptions) {
    super(latLng, options);
    this.setData(data);
  }

  getData() {
    return this.data;
  }

  setData(data: { messageId: number }) {
    this.data = data;
  }
}



function getTileLayers() {
  const openStreetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });

  const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
    maxZoom: 17,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
  });
  return { openStreetMap, googleHybrid }
}

const liTemplate = (message_: Message, networkUnitName_: string | undefined, selectedUnits: string[]) => {
  const unitName = networkUnitName_ ?? message_[1].unit ?? 'Не визначено'
  const unitBlock = `
            <div>
              <span style="font-weight: 700; line-height: 22px;">Підрозділ:</span> 
              <span class="pointer" style="color: #0d6efd" id="map-message-id-${message_[0]}", data-unitname="${unitName}">
                ${unitName}
                <i class="bi bi-${selectedUnits.includes(unitName) ? "dash" : "plus"}-square" > </i>
              </span>
            </div>
            `

  return `
          <li>
            ${message_[1].message_uid ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Посилання: </span><a href="${updateStateUrl(window.location.href, message_[1].message_uid)}">${message_[1].message_uid}</a></p>` : ''}
            ${message_[1].freq ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Частота:</span> ${message_[1].freq}</p>` : ''}
            ${message_[1].coords ? `<p style="line-height: 16px;"><span style="font-weight: 700;">Координати:</span> ${message_[1].coords}</p>` : ''}
            ${message_[1].coords ? '<span style="font-weight: 700; line-height: 22px;">Повідомлення:</span><br>' : ''}
            ${(message_[1].date && message_[1].time) ? `${message_[1].date} ${message_[1].time}<br>` : ''}
            ${message_[1].text.replace(/\n/g, '<br>')}
            ${unitBlock}
            <div class="divider"></div>
          </li>
    `;
}
function getPointPopupTemplate(sortedMessages: Message[], networkUnits: NetworkUnit[], selectedUnits: string[]) {
  const b =
    sortedMessages.map((message) => {
      const freq = message[1].freq
      const networkIds = message[1].network_ids
      const shouldUseNetworkUnits = Array.isArray(networkIds) && networkIds.length > 0 && !!freq
      const networkUnitName = shouldUseNetworkUnits
        ? networkUnits.find(unit => unit.frequencies.includes(freq!))?.name
        : undefined
      return liTemplate(message, networkUnitName, selectedUnits)
    }).join('')
  return `
    <div class="messages-popup" >
      <p class="title" > ${messagesCountText(sortedMessages.length)} </p>
        <ul>
            ${b}
  </ul>
    </div>
      `;
}


class AnalysisMap extends HTMLElement {
  static observedAttributes = ["points", "daterange", "daterange-loading", "messages", "visibility", "network-units", "selected-units", "palitras", "palitras-loaded", "search", "palitras-load-state"]

  private _map: L.Map | null = null;
  private _daterange: { startDate: number, endDate: number } = { startDate: new Date().getDate(), endDate: new Date().getDate() };
  private _switchTimeControl: TimeswitchControl | null = null;
  private _points: MapPointDetailed[] = []
  private _messages: Message[] = [];
  private _networkUnits: NetworkUnit[] = [];

  private _markersGroup: L.MarkerClusterGroup | null = null;
  private _clickedPoint: DataCircleMarker | null = null;
  private _clickedLatLng: L.LatLng | null = null;
  private _boundedAlready = false;
  private _initialized = false;
  private _kmzLayer: KMZLayer | null = null;
  private _kmzLoading: Promise<void> | null = null;
  private _selectedUnits: string[] = []

  private _palitraManager: PalitraManager | null = null;
  private _pelengsLayerGroup: L.LayerGroup | null = null;
  private _palitras: PalitraDetails[] = [];
  private _visiblePalitraIds: number[] = [];
  private _palitrasLoaded = false;
  private _palitrasLoadState: PalitrasLoadState = 'idle';
  private _palitrasEnabled = true;
  private _kmzEnabled = true;
  private _pelengsEnabled = true;
  private _layerSwitchControl: LayerSwitchControl | null = null;
  private _mapSettingsControl: MapSettingsControl | null = null;
  private _pelengLabelsPermanent = true;
  private _searchControl: SearchControl | null = null;
  private _stateStore: AnalysisMapStateStore;
  private _coordinateSearchMarker: L.CircleMarker | null = null;
  private _pointContextMenuMarker: L.CircleMarker | null = null;
  private _pointContextMenuOverlay: HTMLElement | null = null;
  private _pointContextMenuLatLng: L.LatLng | null = null;
  private _isFullscreen = false;
  private _mapWindowControl: MapWindowControl | null = null;
  private _isBackgroundPointsLoading = false;
  private _isDateRangeLoading = false;
  private _isSearchLoading = false;
  private _searchPointsHandler = (e: CustomEvent<string>) => {
    if (this._isSearchInteractionLocked()) {
      return;
    }
    const value = (e.detail ?? '').trim();
    const coords = parseCoordinateInput(value);
    if (coords && this._map) {
      this._flyToCoordinate(coords);
      this._searchControl?.updateSearchLoading(false);
      this._searchControl?.updateResultsCount(null);
      this._palitraManager?.setSearchQuery('');
    } else {
      this._clearCoordinateMarker();
      this._palitraManager?.setSearchQuery(value);
    }
  }
  private _escapeHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this._isFullscreen) {
      event.preventDefault();
      this._setFullscreen(false);
    }
  }
  constructor() {
    super();
    this._stateStore = new AnalysisMapStateStore();
    this._applyState(this._stateStore.getState());
  }

  private _sameVisibleIds(left: number[], right: number[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => value === right[index]);
  }

  connectedCallback() {
    this._palitrasLoadState = this._parsePalitrasLoadState(this.getAttribute('palitras-load-state'));
    this._isDateRangeLoading = this._parseBooleanAttribute(this.getAttribute('daterange-loading'));
    this.addEventListener('search-points', this._searchPointsHandler);
    window.addEventListener('keydown', this._escapeHandler);
  }

  disconnectedCallback() {
    this.removeEventListener('search-points', this._searchPointsHandler);
    window.removeEventListener('keydown', this._escapeHandler);
    this._closePointContextMenu();
    this._setFullscreen(false);
  }

  private _clearCoordinateMarker(): void {
    if (this._coordinateSearchMarker && this._map) {
      this._map.removeLayer(this._coordinateSearchMarker);
      this._coordinateSearchMarker = null;
    }
  }

  private _flyToCoordinate(coords: { lat: number; lng: number }): void {
    if (!this._map) return;
    this._clearCoordinateMarker();
    const latlng: L.LatLngExpression = [coords.lat, coords.lng];
    this._map.flyTo(latlng, 13, { duration: 0.4 });
    const marker = L.circleMarker(latlng, {
      color: '#0d6efd',
      fillColor: '#0d6efd',
      fillOpacity: 0.8,
      radius: 8,
      weight: 2
    });
    marker.bindPopup(
      `<div>Координати: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}</div>`,
      { closeButton: true }
    );
    marker.addTo(this._map);
    this._coordinateSearchMarker = marker;
  }

  private _closePointContextMenu(): void {
    this._pointContextMenuOverlay?.remove();
    this._pointContextMenuOverlay = null;
    this._pointContextMenuLatLng = null;
    if (this._pointContextMenuMarker && this._map) {
      this._map.removeLayer(this._pointContextMenuMarker);
      this._pointContextMenuMarker = null;
    }
  }

  private _positionPointContextMenuOverlay(): void {
    if (!this._map || !this._pointContextMenuOverlay || !this._pointContextMenuLatLng) {
      return;
    }

    const container = this._map.getContainer();
    const point = this._map.latLngToContainerPoint(this._pointContextMenuLatLng);
    const rect = this._pointContextMenuOverlay.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const margin = 12;
    const arrowHeight = 13;
    const markerGap = 12;

    const maxLeft = Math.max(margin, container.clientWidth - width - margin);
    const unclampedLeft = point.x - width / 2;
    const left = Math.min(Math.max(margin, unclampedLeft), maxLeft);
    const top = Math.max(margin, point.y - height - arrowHeight - markerGap);
    const arrowLeft = Math.min(Math.max(point.x - left - 1, 20), Math.max(20, width - 20));

    this._pointContextMenuOverlay.style.left = `${left}px`;
    this._pointContextMenuOverlay.style.top = `${top}px`;
    this._pointContextMenuOverlay.style.setProperty('--analysis-map-coord-menu-arrow-left', `${arrowLeft}px`);
  }

  private _openPointContextMenu(target: CoordinateMenuTarget, latlng: L.LatLng): void {
    if (!this._map) {
      return;
    }

    this._closePointContextMenu();

    const marker = L.circleMarker(latlng, {
      color: '#fff',
      fillColor: '#6c757d',
      fillOpacity: 1,
      radius: 6,
      weight: 2,
    });
    marker.addTo(this._map);
    this._pointContextMenuMarker = marker;

    const overlay = document.createElement('div');
    overlay.className = 'analysis-map-coord-menu-overlay';
    const stopPropagation = (event: Event) => {
      event.stopPropagation();
    };
    overlay.addEventListener('pointerdown', stopPropagation);
    overlay.addEventListener('mousedown', stopPropagation);
    overlay.addEventListener('mouseup', stopPropagation);
    overlay.addEventListener('click', stopPropagation);
    overlay.addEventListener('dblclick', stopPropagation);
    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    overlay.appendChild(this._buildPointContextMenuContent(target));
    this._map.getContainer().appendChild(overlay);
    this._pointContextMenuOverlay = overlay;
    this._pointContextMenuLatLng = latlng;
    requestAnimationFrame(() => this._positionPointContextMenuOverlay());
    setTimeout(() => this._positionPointContextMenuOverlay(), 0);
  }

  private _buildPointContextMenuContent(target: CoordinateMenuTarget): HTMLElement {
    const element = document.createElement('analysis-map-coord-menu');
    element.className = 'analysis-map-coord-menu-host';
    element.setAttribute('lat', String(target.lat));
    element.setAttribute('lng', String(target.lng));
    if (target.mgrsCoords) {
      element.setAttribute('mgrs-coords', target.mgrsCoords);
    }
    element.addEventListener('coord-menu-rendered', () => {
      requestAnimationFrame(() => this._positionPointContextMenuOverlay());
    });
    element.addEventListener('coord-menu-close', () => {
      this._closePointContextMenu();
    });
    return element;
  }

  attributeChangedCallback(name: string, oldValue: any, newValue: string) {
    if (name === 'visibility') {
      if (!this._initialized && newValue === 'true') {
        // We have to make sure that map container has completely re-rendered before initializing the map.
        setTimeout(async () => {
          this.render();
          await this._initializeMap();
          this._initialized = true;
        }, 0)
      }
    }
    if (name === 'points') {
      this._points = JSON.parse(newValue);
      if (this._map) {
        this._replacePointsOnMap(this._points);
      }
    }
    if (name === 'daterange') {
      this._daterange = JSON.parse(newValue);
      if (this._switchTimeControl && this._daterange) {
        this._switchTimeControl.updateDates(this._daterange);
      }
    }
    if (name === 'daterange-loading') {
      this._isDateRangeLoading = this._parseBooleanAttribute(newValue);
      this._syncAsyncInteractionState();
    }
    if (name === 'messages') {
      const parsed = JSON.parse(newValue);
      this._messages = parsed['messages']
      this._networkUnits = parsed['networkUnits']
      if ((this._clickedPoint || this._clickedLatLng) && this._messages.length > 0) {

        const unitClickedCallback = (element: Element) => {
          const event = new CustomEvent('message-unit-clicked', {
            detail: {
              networkUnitName: element.getAttribute("data-unitname")
            },
            bubbles: true,
            composed: true
          });
          this.dispatchEvent(event);
          if (this._clickedPoint) {
            this._clickedPoint.closePopup();
          } else {
            this._map?.closePopup();
          }
          this._clickedPoint = null;
          this._clickedLatLng = null;
        }
        const sortedMessages = [...this._messages].sort((message1, message2) => {
          const datetime1 = new Date(`${message1[1].date}T${message1[1].time} `);
          const datetime2 = new Date(`${message2[1].date}T${message2[1].time} `);
          return datetime2.getTime() - datetime1.getTime();
        });

        const popupContent = getPointPopupTemplate(sortedMessages, this._networkUnits, this._selectedUnits)
        const clickedMessageId = sortedMessages[0]?.[0];
        const isCluster = sortedMessages.length > 1;
        const restoredPoint =
          !isCluster && clickedMessageId !== undefined ? this._findPointMarkerByMessageId(clickedMessageId) : null;

        const canOpenOnRestoredPoint = restoredPoint ? restoredPoint.getElement() !== null : false;
        if (restoredPoint && canOpenOnRestoredPoint) {
          this._clickedPoint = restoredPoint;
          this._clickedLatLng = restoredPoint.getLatLng();
          this._clickedPoint.bindPopup(popupContent)
          this._clickedPoint.openPopup()
        } else if (this._map && this._clickedLatLng) {
          L.popup()
            .setLatLng(this._clickedLatLng)
            .setContent(popupContent)
            .openOn(this._map);
          this._clickedPoint = null;
        } else {
          return;
        }

        const a = document.querySelectorAll('[id^="map-message-id-"]')
        const handlersMap = new Map<string, () => void>();
        a.forEach(x => {
          const handleClick = () => unitClickedCallback(x)
          x.addEventListener('click', handleClick)
          handlersMap.set(x.id, handleClick)
        })

        const clearPopupHandlers = () => {
          a.forEach(x => {
            const handler = handlersMap.get(x.id)
            if (handler) {
              x.removeEventListener('click', handler)
              handlersMap.delete(x.id)
            }
          })
          this._clickedPoint = null;
          this._clickedLatLng = null;
        };

        if (this._clickedPoint) {
          this._clickedPoint.once('popupclose', clearPopupHandlers);
        } else if (this._map) {
          this._map.once('popupclose', clearPopupHandlers);
        }
      }
    }
    if (name === 'selected-units') {
      this._selectedUnits = JSON.parse(newValue)
    }
    if (name === 'palitras') {
      const palitras = JSON.parse(newValue);
      console.log('[AnalysisMap] Palitras attribute changed, count:', palitras.length, 'manager exists:', !!this._palitraManager);
      this._palitras = palitras;
      this._syncVisiblePalitraIds();
      if (this._palitraManager) {
        this._palitraManager.updatePalitras(palitras);
        this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
      }
    }
    if (name === 'palitras-loaded') {
      this._palitrasLoaded = JSON.parse(newValue);
      this._syncVisiblePalitraIds();
      if (this._palitraManager) {
        this._palitraManager.updatePalitras(this._palitras);
        this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
      }
    }
    if (name === 'search') {
      this._applySearchQueryFromUrl();
    }
    if (name === 'palitras-load-state') {
      this._palitrasLoadState = this._parsePalitrasLoadState(newValue);
      this._palitraManager?.setLoadState(this._palitrasLoadState);
      this._syncAsyncInteractionState();
      // Re-run search from URL when palitras finish loading so the initial query runs after search is enabled
      if (this._palitrasLoadState === 'success' || this._palitrasLoadState === 'error') {
        this._runSearchQueryIfSet();
      }
    }
  }

  /** Get search query from URL only */
  private _getEffectiveSearchQuery(): string {
    return (getSearchQueryFromCurrentUrl() ?? '').trim();
  }

  /** Set search input value from URL. Does not trigger search (search runs once when palitras are ready). */
  private _applySearchQueryFromUrl() {
    const query = this._getEffectiveSearchQuery();
    if (!query) return;
    const searchEl = this.querySelector('analysis-map-search');
    if (searchEl) {
      searchEl.setAttribute('initial-query', query);
    }
  }

  /** Run search using query from URL. */
  private _runSearchQueryIfSet() {
    const query = this._getEffectiveSearchQuery();
    if (!query || !this._palitraManager) return;
    this._palitraManager.setSearchQuery(query);
  }


  private render() {
    this.innerHTML = `
    <div class="analysis-map-wrapper" style="display: flex; flex-direction: column; height: 100%; min-height: 0;">
      <div id="analysis-map" style="flex: 1; min-height: 0;"></div>
    </div>
      `;
  }

  private async _initializeMap() {
    const mapContainer = this.querySelector<HTMLDivElement>('#analysis-map')
    if (mapContainer) {
      const tileLayers = getTileLayers();

      // Start with a single base layer to avoid loading two full tile stacks at once
      const map = L.map(mapContainer, {
        zoomControl: false,
        attributionControl: false
      }).setView([47.42135, 35.62197], 8);
      tileLayers.googleHybrid.addTo(map);
      // Keep Leaflet's click-to-focus behavior, but prevent nested scroll containers
      // from jumping when the map receives focus on mousedown.
      this._patchMouseDownMapFocus(map);
      this._suppressNativeContextMenu(map);
      map.on('click', () => this._closePointContextMenu());
      map.on('movestart zoomstart resize', () => this._closePointContextMenu());
      map.on('contextmenu', (event: L.LeafletMouseEvent) => {
        if (!this._shouldHandleMapSurfaceContextMenu(event.originalEvent, map)) {
          return;
        }
        this._clickedPoint = null;
        this._clickedLatLng = null;
        this._openPointContextMenu(
          { lat: event.latlng.lat, lng: event.latlng.lng },
          event.latlng,
        );
      });

      const result = this._initializeControls(map, tileLayers)
      this._map = result.map;
      this._switchTimeControl = result.switchTimeControl;

     // Initialize palitra manager
     this._palitraManager = new PalitraManager(
       this._map,
       {
         minZoomForPoints: 11,
         requestDelayMs: 200,
         cacheTtlMs: 5 * 60 * 1000,
         maxCachedTiles: 100
       },
       {
         onVisibilityToggle: (palitraId) => {
           const event = new CustomEvent('palitra-visibility-toggled', {
             detail: { palitraId },
             bubbles: true,
             composed: true
           });
           this.dispatchEvent(event);
         },
         onSearchResultsCountChanged: (count) => {
           this._searchControl?.updateResultsCount(count);
         },
         onSearchLoadingChanged: (isLoading) => {
           this._searchControl?.updateSearchLoading(isLoading);
           this._isSearchLoading = isLoading;
           this._syncAsyncInteractionState();
         },
         onBackgroundPointsLoadingChanged: (isLoading) => {
           this._isBackgroundPointsLoading = isLoading;
           this._syncAsyncInteractionState();
         }
       }
     );
     
     // Set the control after manager is created
     console.log('[AnalysisMap] Setting control, _palitrasEnabled:', this._palitrasEnabled, 'stored palitras:', this._palitras.length, 'visible IDs:', this._visiblePalitraIds.length);
     this._palitraManager.setControl(result.palitrasControl);
     this._palitraManager.setLoadState(this._palitrasLoadState);
     this._syncAsyncInteractionState();
     
     // Update manager with any palitras that arrived before initialization
     if (this._palitras.length > 0) {
       console.log('[AnalysisMap] Applying stored palitras to manager');
       this._palitraManager.updatePalitras(this._palitras);
     }
     if (this._visiblePalitraIds.length > 0) {
       console.log('[AnalysisMap] Applying stored visible IDs to manager');
       this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
     }
     
     this._applyPalitraVisibility();

     this._pelengsLayerGroup = L.layerGroup();
     this._applyPelengVisibility();
     this._replacePointsOnMap(this._points);
     // Get-inbox-map points are always visible; no need to re-apply on zoom.

    // Set search input from URL; run search once when palitras are ready (palitras-load-state handler)
    this._applySearchQueryFromUrl();
    if (this._palitrasLoadState === 'success' || this._palitrasLoadState === 'error') {
      this._runSearchQueryIfSet();
    }

    void this._loadKmzLayer();
  }
}

  private _parsePalitrasLoadState(value: string | null): PalitrasLoadState {
    if (value === 'loading' || value === 'success' || value === 'error') {
      return value;
    }
    return 'idle';
  }

  private _parseBooleanAttribute(value: string | null): boolean {
    return value === 'true';
  }

  private _initializeControls(map: L.Map, tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer }) {
    const exitCallback = () => {
      this._setFullscreen(false);
      const event = new CustomEvent('exit', {
        detail: {
        },
        bubbles: true,
        composed: true
      });
      this.dispatchEvent(event);
    }

    const palitrasVisibleIdsCallback = (visibleIds: number[]) => {
      const state = this._stateStore.setVisiblePalitraIds(visibleIds);
      this._applyState(state);
      if (this._palitraManager) {
        this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
      }
    }

    const featureToggleCallback = (feature: FeatureName, enabled: boolean) => {
      this._setFeatureEnabled(feature, enabled);
    }

    const switchTimeControl = createTimeswitchControl(this._daterange, this._isDateRangeInteractionLocked());
    const searchControl = createSearchControl();
    map.addControl(searchControl);
    this._searchControl = searchControl;
    this._syncAsyncInteractionState();
    map.addControl(switchTimeControl)

    const mapWindowControl = createMapWindowControl(exitCallback, () => this._toggleFullscreen(), this._isFullscreen);
    map.addControl(mapWindowControl);
    this._mapWindowControl = mapWindowControl;
    const layerSwitchControl = createLayerSwitchControl(tileLayers, this._getFeatureToggleState(), featureToggleCallback);
    this._layerSwitchControl = layerSwitchControl;
    map.addControl(layerSwitchControl);
    try {
      const saved = localStorage.getItem('analysis-map-peleng-labels');
      if (saved !== null) this._pelengLabelsPermanent = saved !== 'false';
    } catch {
      this._pelengLabelsPermanent = true;
    }
    const mapSettingsControl = createMapSettingsControl(this._pelengLabelsPermanent, (show: boolean) => {
      this._pelengLabelsPermanent = show;
      try {
        localStorage.setItem('analysis-map-peleng-labels', String(show));
      } catch {
        // ignore
      }
      this._updatePelengLabelsPermanent();
    });
    map.addControl(mapSettingsControl);
    this._mapSettingsControl = mapSettingsControl;
    map.addControl(createMapZoomControl());
    map.addControl(createAttributionControl());

    const palitrasControl = createPalitrasControl([], [], palitrasVisibleIdsCallback);

    return { map, switchTimeControl, palitrasControl };
  }

  private _toggleFullscreen() {
    this._setFullscreen(!this._isFullscreen);
  }

  private _setFullscreen(enabled: boolean) {
    if (this._isFullscreen === enabled) {
      return;
    }

    this._isFullscreen = enabled;
    this.classList.toggle('analysis-map-fullscreen', enabled);
    document.body.classList.toggle('analysis-map-fullscreen-open', enabled);
    this._mapWindowControl?.setFullscreen(enabled);
    window.setTimeout(() => {
      this._map?.invalidateSize();
    }, 0);
  }

  private _patchMouseDownMapFocus(map: L.Map) {
    const keyboardHandler = (map as L.Map & { keyboard?: { _onMouseDown?: (e: MouseEvent) => void; _focused?: boolean; _map?: L.Map } }).keyboard;
    const originalOnMouseDown = keyboardHandler?._onMouseDown;
    if (!keyboardHandler || !originalOnMouseDown) {
      return;
    }

    const mapContainer = map.getContainer() as HTMLElement;
    L.DomEvent.off(mapContainer, 'mousedown', originalOnMouseDown, keyboardHandler);

    const patchedOnMouseDown = function(this: { _focused?: boolean; _map?: L.Map }) {
      if (this._focused) {
        return;
      }

      const container = this._map?.getContainer() as HTMLElement | undefined;
      if (!container) {
        return;
      }

      try {
        // Modern browsers: preserve focus without triggering scroll reposition.
        container.focus({ preventScroll: true });
      } catch (_error) {
        // Older browser fallback: mimic Leaflet default behavior.
        const body = document.body;
        const docEl = document.documentElement;
        const top = body.scrollTop || docEl.scrollTop;
        const left = body.scrollLeft || docEl.scrollLeft;
        container.focus();
        window.scrollTo(left, top);
      }
    };

    keyboardHandler._onMouseDown = patchedOnMouseDown;
    L.DomEvent.on(mapContainer, 'mousedown', patchedOnMouseDown, keyboardHandler);
  }

  private _suppressNativeContextMenu(map: L.Map): void {
    const mapContainer = map.getContainer();
    mapContainer.addEventListener('contextmenu', (event: MouseEvent) => {
      if (!this._shouldHandleMapSurfaceContextMenu(event, map)) {
        return;
      }
      event.preventDefault();
    }, true);
  }

  private _shouldHandleMapSurfaceContextMenu(event: Event, map: L.Map): boolean {
    const mapContainer = map.getContainer();
    const target = event.target;
    if (!(target instanceof Element) || !mapContainer.contains(target)) {
      return false;
    }

    if (target.closest('.analysis-map-coord-menu-overlay, .leaflet-control-container, .leaflet-control')) {
      return false;
    }

    if (
      target.closest(
        '.leaflet-marker-pane, .leaflet-overlay-pane, .leaflet-popup-pane, .leaflet-shadow-pane, .leaflet-tooltip-pane',
      )
    ) {
      return false;
    }

    return target === mapContainer || target.closest('.leaflet-tile-pane, .leaflet-map-pane') !== null;
  }

  private _updateSearchControlState() {
    if (!this._searchControl) {
      return;
    }

    const isPalitrasLoading = this._palitrasLoadState === 'loading';
    const isSearchDisabled = this._isSearchInteractionLocked();
    this._searchControl.updateSearchDisabled(isSearchDisabled);

    if (this._isDateRangeLoading) {
      this._searchControl.updatePlaceholder('Оновлення інтервалу...');
      return;
    }

    if (this._isBackgroundPointsLoading) {
      this._searchControl.updatePlaceholder('Завантаження точок...');
      return;
    }

    if (isPalitrasLoading) {
      this._searchControl.updatePlaceholder('Завантаження палітр...');
      return;
    }

    this._searchControl.updatePlaceholder('Точка, лісосмуга або координати');
  }

  private _isDateRangeInteractionLocked(): boolean {
    return this._isDateRangeLoading || this._isSearchLoading || this._palitrasLoadState === 'loading';
  }

  private _isSearchInteractionLocked(): boolean {
    return this._isDateRangeLoading || this._isBackgroundPointsLoading || this._palitrasLoadState === 'loading';
  }

  private _isPalitraSelectionInteractionLocked(): boolean {
    return this._isDateRangeLoading || this._isSearchLoading;
  }

  private _syncAsyncInteractionState(): void {
    this._updateSearchControlState();
    this._switchTimeControl?.updateLoading(this._isDateRangeInteractionLocked());
    this._palitraManager?.setInteractionDisabled(this._isPalitraSelectionInteractionLocked());
  }

  private _replacePointsOnMap(points: MapPointDetailed[]) {
    this._closePointContextMenu();
    if (this._markersGroup) {
      this._markersGroup.off();
      this._markersGroup.eachLayer((l) => {
        l.off();
        const layer = l as L.Layer & { unbindTooltip?: () => void };
        if (typeof layer.unbindTooltip === 'function') {
          layer.unbindTooltip();
        }
      });
      this._markersGroup.clearLayers();
      this._pelengsLayerGroup?.removeLayer(this._markersGroup);
      this._map?.removeLayer(this._markersGroup);
    }
    // Get-inbox-map points are always visible (no zoom restriction).
    this._fitBoundsOnInitialLowZoom(points);
    const { bounds, markersGroup } = this._addPointsMarkersGroup(points);
    this._markersGroup = markersGroup;

    this._pelengsLayerGroup?.addLayer(this._markersGroup);
    this._applyPelengVisibility();

    if (bounds.isValid() && !this._boundedAlready && this._map) {
      if (this._map.getZoom() <= 10) {
        this._map.fitBounds(bounds);
      }
      this._boundedAlready = true;
    }
  }

  private _fitBoundsOnInitialLowZoom(points: MapPointDetailed[]): void {
    if (!this._map || this._boundedAlready || this._map.getZoom() > 10 || points.length === 0) {
      return;
    }

    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng] as [number, number]));
    if (!bounds.isValid()) {
      return;
    }

    this._map.fitBounds(bounds);
    this._boundedAlready = true;
  }

  private _addPointsMarkersGroup(points: MapPointDetailed[]) {
    const markers = L.markerClusterGroup({
      maxClusterRadius: points.length > 100 ? 30 : 10,
      zoomToBoundsOnClick: false,
      spiderfyOnMaxZoom: false,
      iconCreateFunction: function(cluster) {
        const colors = cluster.isPopupOpen() ? "background-color: #fff;color:black;" : "background-color: #ED1C23; border: 1px solid #000;color: white;"
        const childCount = cluster.getChildCount();
        return L.divIcon({
          html: `<div style="${colors} border-radius: 50%; width: 17px; height: 17px; display: flex; align-items: center; justify-content: center; text-align: center;  font-size: 10px; line-height: 17px;">
                ${childCount}
            </div>`,
          className: '',
        });
      }
    });
    let bounds = L.latLngBounds(points);


    points.forEach(point => {
      const circle = new DataCircleMarker([point.lat, point.lng], { messageId: point.message_id }, {
        color: '#000',
        fillColor: '#ED1C23',
        fillOpacity: 1,
        radius: 4,
        weight: 1
      });

      const freqLabel = (point as MapPointDetailed & { freq?: string | null }).freq ?? '';
      if (freqLabel) {
        (circle as DataCircleMarker & { _pelengFreqLabel?: string })._pelengFreqLabel = freqLabel;
        circle.bindTooltip(freqLabel, {
          permanent: this._pelengLabelsPermanent,
          direction: 'top',
          offset: [0, -8],
          className: 'peleng-point-label'
        });
      }

      circle.on('click', () => {
        this._clickedLatLng = circle.getLatLng();
        this._emitLoadMessagesDescriptions([point.message_id])
        this._clickedPoint = circle;
      });
      const openPointContextMenu = (latlng: L.LatLng, originalEvent?: MouseEvent | PointerEvent | Event) => {
        originalEvent?.preventDefault();
        originalEvent?.stopPropagation();
        this._clickedPoint = null;
        this._clickedLatLng = null;
        this._openPointContextMenu(
          { lat: point.lat, lng: point.lng, mgrsCoords: point.mgrs_coords },
          latlng,
        );
      };
      circle.on('mousedown', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
        if (event.originalEvent?.button !== 2) {
          return;
        }
        openPointContextMenu(circle.getLatLng(), event.originalEvent);
      });
      circle.on('contextmenu', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
        openPointContextMenu(circle.getLatLng(), event.originalEvent);
      });
      circle.on('popupopen', () => {
        circle.setStyle({ fillColor: '#fff', color: "#000" })
      })
      circle.on('popupclose', () => {
        circle.setStyle({ fillColor: '#ED1C23', color: '#000' })
      })

      markers.addLayer(circle)
    });

    markers.on('clusterclick', (leafletEvent) => {
      const cluster = leafletEvent.layer as unknown as { getAllChildMarkers: () => L.Layer[] };
      const childMarkers = cluster.getAllChildMarkers() as unknown as DataCircleMarker[];
      this._clickedPoint = null;
      const latlng =
        (leafletEvent as L.LeafletMouseEvent).latlng ??
        (typeof (cluster as unknown as { getLatLng?: () => L.LatLng }).getLatLng === 'function'
          ? (cluster as unknown as { getLatLng: () => L.LatLng }).getLatLng()
          : null);
      this._clickedLatLng = latlng;
      const allIds = childMarkers.map((m) => m.data.messageId);
      this._emitLoadMessagesDescriptions(allIds);
    });
    return {
      bounds,
      markersGroup: markers
    };
  }

  private _updatePelengLabelsPermanent() {
    if (!this._markersGroup) return;
    const permanent = this._pelengLabelsPermanent;
    const opts = { permanent, direction: 'top' as const, offset: [0, -8] as [number, number], className: 'peleng-point-label' };
    this._markersGroup.eachLayer((layer: L.Layer) => {
      const getChildren = (l: L.Layer): L.Layer[] => {
        const withGetChildren = l as unknown as { getAllChildMarkers?: () => L.Layer[] };
        return typeof withGetChildren.getAllChildMarkers === 'function'
          ? withGetChildren.getAllChildMarkers()
          : [l];
      };
      getChildren(layer).forEach((m) => {
        if (m instanceof DataCircleMarker) {
          const label = (m as DataCircleMarker & { _pelengFreqLabel?: string })._pelengFreqLabel;
          if (!label) return;
          m.unbindTooltip();
          m.bindTooltip(label, opts);
        }
      });
    });
  }

  private _emitLoadMessagesDescriptions(messageIds: number[]) {
    const event = new CustomEvent('load-messages-description', {
      detail: {
        messageIds
      },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);

  }

  private _findPointMarkerByMessageId(messageId: number): DataCircleMarker | null {
    if (!this._markersGroup) {
      return null;
    }
    let found: DataCircleMarker | null = null;
    this._markersGroup.eachLayer((layer: L.Layer) => {
      if (found) {
        return;
      }
      if (layer instanceof DataCircleMarker && layer.getData().messageId === messageId) {
        found = layer;
      }
    });
    return found;
  }

  private _getFeatureToggleState(): FeatureToggleState {
    return {
      palitrasEnabled: this._palitrasEnabled,
      kmzEnabled: this._kmzEnabled,
      pelengsEnabled: this._pelengsEnabled
    };
  }

  private _updateLayerSwitchControl() {
    if (this._layerSwitchControl) {
      this._layerSwitchControl.updateFeatures(this._getFeatureToggleState());
    }
  }

  private _applyState(state: AnalysisMapStoredState) {
    this._palitrasEnabled = state.features.palitras;
    this._kmzEnabled = state.features.kmz;
    this._pelengsEnabled = state.features.pelengs;
    this._visiblePalitraIds = state.visiblePalitraIds;
  }

  private _setFeatureEnabled(feature: FeatureName, enabled: boolean) {
    const state = this._stateStore.setFeatures({ [feature]: enabled });
    this._applyState(state);
    if (feature === 'palitras') {
      this._applyPalitraVisibility();
    }
    if (feature === 'kmz') {
      this._applyKmzVisibility();
    }
    if (feature === 'pelengs') {
      this._applyPelengVisibility();
    }
    this._updateLayerSwitchControl();
  }

  private _syncVisiblePalitraIds() {
    const state = this._stateStore.syncVisiblePalitraIds(this._palitras, this._palitrasLoaded);
    this._applyState(state);
  }

  private _applyPelengVisibility() {
    if (!this._map || !this._pelengsLayerGroup) {
      return;
    }

    if (!this._pelengsEnabled) {
      this._map.removeLayer(this._pelengsLayerGroup);
      return;
    }

    this._pelengsLayerGroup.addTo(this._map);
  }

  private _applyPalitraVisibility() {
    if (!this._palitraManager) {
      return;
    }

    this._palitraManager.setEnabled(this._palitrasEnabled);
  }

  private async _loadKmzLayer() {
    if (!this._map || !this._kmzEnabled) {
      return;
    }

    if (this._kmzLayer) {
      this._kmzLayer.addTo(this._map);
      return;
    }

    if (this._kmzLoading) {
      await this._kmzLoading;
      return;
    }

    this._kmzLoading = (async () => {
      try {
        const kmzData = await loadKmzData();
        if (!kmzData) {
          return;
        }
        this._kmzLayer = kmzLayerFactory(null, { bindTooltip: true, bindPopup: false, permanentTooltip: true });
        if (this._map && this._kmzEnabled) {
          this._kmzLayer.addTo(this._map);
          this._kmzLayer.parse(kmzData, {});
        }
      } catch (e) {
        console.error('Failed to load KMZ data', e);
      } finally {
        this._kmzLoading = null;
      }
    })();

    await this._kmzLoading;
  }

  private _applyKmzVisibility() {
    if (!this._map) {
      return;
    }

    if (!this._kmzEnabled) {
      if (this._kmzLayer) {
        this._map.removeLayer(this._kmzLayer);
      }
      return;
    }

    this._loadKmzLayer();
  }
}

function parseStateFromUrl(stateParam: string | null): RerAnalysisQueryState | null {
  if (!stateParam) {
    return null;
  }

  try {
    const parsed = JSON.parse(stateParam);

    if (parsed && typeof parsed === 'object') {
      return parsed as RerAnalysisQueryState;
    }
  } catch (error) {
    try {
      const decodedState = decodeURIComponent(stateParam);
      const parsed = JSON.parse(decodedState);

      if (parsed && typeof parsed === 'object') {
        return parsed as RerAnalysisQueryState;
      }
    } catch (_) {
    }
  }

  return null;
}

/** Read search query from current page URL: top-level search param or state.search. */
function getSearchQueryFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URL(window.location.href).searchParams;
  const fromParam = params.get('search');
  if (fromParam != null && String(fromParam).trim() !== '') return String(fromParam).trim();
  const state = parseStateFromUrl(params.get('state'));
  const fromState = state?.['search'];
  if (fromState != null && String(fromState).trim() !== '') return String(fromState).trim();
  return null;
}

function updateStateUrl(currentUrl: string, messageUid: string): string {
  try {
    const url = new URL(currentUrl);
    const storedState = loadRerAnalysisQueryState();
    const baseState = storedState ?? parseStateFromUrl(url.searchParams.get('state')) ?? {};
    const stateObject: RerAnalysisQueryState = { ...(baseState as RerAnalysisQueryState), search: messageUid };
    saveRerAnalysisQueryState(stateObject);

    const updatedState = JSON.stringify(stateObject);
    url.searchParams.set('state', updatedState);
    return url.href;
  } catch (error) {
    console.error("Error updating URL state:", error);
    return currentUrl;
  }
}

customElements.define('analysis-map', AnalysisMap)
