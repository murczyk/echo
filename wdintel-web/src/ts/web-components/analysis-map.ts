import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { loadKmzData } from '../maps/maps'
import { KMZLayer, kmzLayerFactory } from '../maps/leaflet-kmz'
import { MapPointDetailed } from '../maps/types';
import { messagesCountText } from '../maps/language-utils';
import { loadRerAnalysisQueryState, RerAnalysisQueryState, saveRerAnalysisQueryState } from '../rer-analysis-query-state';
import { TimeswitchControl, FeatureToggleState, createLayerSwitchControl, createExitControl2, createTimeswitchControl, createAttributionControl, createPalitrasControl, FeatureName, LayerSwitchControl, createSearchControl, createMapZoomControl } from '../maps/controls';
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
            ${message_[1].text.replace('\n', '<br>')}
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
  static observedAttributes = ["points", "daterange", "messages", "visibility", "network-units", "selected-units", "palitras", "palitras-loaded"]

  private _map: L.Map | null = null;
  private _daterange: { startDate: number, endDate: number } = { startDate: new Date().getDate(), endDate: new Date().getDate() };
  private _switchTimeControl: TimeswitchControl | null = null;
  private _points: MapPointDetailed[] = []
  private _messages: Message[] = [];
  private _networkUnits: NetworkUnit[] = [];

  private _markersGroup: L.MarkerClusterGroup | null = null;
  private _clickedPoint: DataCircleMarker | null = null;
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
  private _palitrasEnabled = true;
  private _kmzEnabled = true;
  private _pelengsEnabled = true;
  private _layerSwitchControl: LayerSwitchControl | null = null;
  private _stateStore: AnalysisMapStateStore;
  private _coordinateSearchMarker: L.CircleMarker | null = null;
  private _searchPointsHandler = (e: CustomEvent<string>) => {
    const value = (e.detail ?? '').trim();
    const coords = parseCoordinateInput(value);
    if (coords && this._map) {
      this._flyToCoordinate(coords);
      this._palitraManager?.setSearchQuery('');
    } else {
      this._clearCoordinateMarker();
      this._palitraManager?.setSearchQuery(value);
    }
  }
  constructor() {
    super();
    this._stateStore = new AnalysisMapStateStore();
    this._applyState(this._stateStore.getState());
  }

  connectedCallback() {
    this.addEventListener('search-points', this._searchPointsHandler);
  }

  disconnectedCallback() {
    this.removeEventListener('search-points', this._searchPointsHandler);
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

  attributeChangedCallback(name: string, oldValue: any, newValue: string) {
    if (name === 'visibility') {
      if (!this._initialized && newValue === 'true') {
        // We have to make sure that map container has completely re-rendered before initializing the map.
        setTimeout(() => {
          this.render();
          this._initializeMap();
          //this._replacePointsOnMap();
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
    if (name === 'messages') {
      const parsed = JSON.parse(newValue);
      this._messages = parsed['messages']
      this._networkUnits = parsed['networkUnits']
      if (this._clickedPoint && this._messages.length > 0) {

        const unitClickedCallback = (element: Element) => {
          const event = new CustomEvent('message-unit-clicked', {
            detail: {
              networkUnitName: element.getAttribute("data-unitname")
            },
            bubbles: true,
            composed: true
          });
          this.dispatchEvent(event);
          this._clickedPoint?.closePopup();
          this._clickedPoint = null;
        }
        const sortedMessages = [...this._messages].sort((message1, message2) => {
          const datetime1 = new Date(`${message1[1].date}T${message1[1].time} `);
          const datetime2 = new Date(`${message2[1].date}T${message2[1].time} `);
          return datetime2.getTime() - datetime1.getTime();
        });

        const popupContent = getPointPopupTemplate(sortedMessages, this._networkUnits, this._selectedUnits)
        this._clickedPoint.bindPopup(popupContent)
        this._clickedPoint.openPopup()

        //this._markersGroup.refreshClusters(this._clickedPoint)

        const a = document.querySelectorAll('[id^="map-message-id-"]')
        const handlersMap = new Map<string, () => void>();
        a.forEach(x => {
          const handleClick = () => unitClickedCallback(x)
          x.addEventListener('click', handleClick)
          handlersMap.set(x.id, handleClick)
        })

        this._clickedPoint.once('popupclose', () => {
          a.forEach(x => {
            const handler = handlersMap.get(x.id)
            if (handler) {
              x.removeEventListener('click', handler)
              handlersMap.delete(x.id)
            }
          })
        })
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

      const result = this._initializeControls(map, tileLayers)
      this._map = result.map;
      this._switchTimeControl = result.switchTimeControl;

      // TODO: Remove
      if (!window.location.hostname.includes('echo-soledarnist')) {
        await this._loadKmzLayer();
      }

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
         }
       }
     );
     
     // Set the control after manager is created
     console.log('[AnalysisMap] Setting control, _palitrasEnabled:', this._palitrasEnabled, 'stored palitras:', this._palitras.length, 'visible IDs:', this._visiblePalitraIds.length);
     this._palitraManager.setControl(result.palitrasControl);
     
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
    }
  }

  private _initializeControls(map: L.Map, tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer }) {
    const exitCallback = () => {
      const event = new CustomEvent('exit', {
        detail: {
        },
        bubbles: true,
        composed: true
      });
      this.dispatchEvent(event);
    }

    const palitraToggleCallback = (palitraId: number) => {
      this._togglePalitraVisibility(palitraId);
    }

    const featureToggleCallback = (feature: FeatureName, enabled: boolean) => {
      this._setFeatureEnabled(feature, enabled);
    }

    const switchTimeControl = createTimeswitchControl(this._daterange);
    map.addControl(createSearchControl());
    map.addControl(switchTimeControl)

    map.addControl(createExitControl2(exitCallback));
    const layerSwitchControl = createLayerSwitchControl(tileLayers, this._getFeatureToggleState(), featureToggleCallback);
    this._layerSwitchControl = layerSwitchControl;
    map.addControl(layerSwitchControl);
    map.addControl(createMapZoomControl());
    map.addControl(createAttributionControl());

    const palitrasControl = createPalitrasControl([], [], palitraToggleCallback);

    return { map, switchTimeControl, palitrasControl };
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

  private _replacePointsOnMap(points: MapPointDetailed[]) {
    if (this._markersGroup) {
      this._markersGroup.off();
      this._markersGroup.eachLayer(l => l.off())
      this._pelengsLayerGroup?.removeLayer(this._markersGroup);
      this._map?.removeLayer(this._markersGroup)
    }
    const { bounds, markersGroup } = this._addPointsMarkersGroup(points);
    this._markersGroup = markersGroup;

    this._pelengsLayerGroup?.addLayer(this._markersGroup);
    this._applyPelengVisibility();

    if (bounds.isValid() && !this._boundedAlready) {
      this._map?.fitBounds(bounds);
      this._boundedAlready = true;
    }

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
      })

      circle.on('click', () => {
        this._emitLoadMessagesDescriptions([point.message_id])
        this._clickedPoint = circle;
      })
      circle.on('popupopen', () => {
        circle.setStyle({ fillColor: '#fff', color: "#000" })
      })
      circle.on('popupclose', () => {
        circle.setStyle({ fillColor: '#ED1C23', color: '#000' })
      })

      markers.addLayer(circle)
    });

    markers.on('clusterclick', (leafletEvent) => {
      const allChildMarkers = leafletEvent.layer.getAllChildMarkers();
      const messageIds = allChildMarkers.map(dataCircle => dataCircle.data.messageId)
      console.log(leafletEvent, 'leafletEvent')
      this._clickedPoint = leafletEvent.propagatedFrom
      this._emitLoadMessagesDescriptions(messageIds)
    });
    return {
      bounds,
      markersGroup: markers
    };
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

  private _togglePalitraVisibility(palitraId: number) {
    const state = this._stateStore.toggleVisiblePalitraId(palitraId);
    this._applyState(state);
    if (this._palitraManager) {
      this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
    }
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
