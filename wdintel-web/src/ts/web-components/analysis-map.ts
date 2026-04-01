import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { KMZLayer } from '../maps/leaflet-kmz'
import { MapPointDetailed } from '../maps/types';
import { TimeswitchControl, FeatureToggleState, FeatureName, LayerSwitchControl, SearchControl, MapWindowControl, MapSettingsControl, PalitrasLoadState } from '../maps/controls';
import { AnalysisMapStateStore, AnalysisMapStoredState } from '../maps/analysis-map-state';
import { parseCoordinateInput } from '../maps/coordinate-search';
import { PalitraManager } from '../maps/palitra-manager';
import { PalitraDetails } from '../maps/palitra-types';
import { AnalysisMapCoordMenuController } from './analysis-map/coord-menu-controller';
import { applyKmzVisibility, loadKmzLayer } from './analysis-map/kmz-layer';
import { initializeAnalysisMapControls } from './analysis-map/map-controls';
import { patchMouseDownMapFocus, shouldHandleMapSurfaceContextMenu, suppressNativeContextMenu } from './analysis-map/map-interactions';
import { openMessagesPopup } from './analysis-map/message-popup';
import { createPointsMarkersGroup, findPointMarkerByMessageId, replacePointsLayer, updatePelengLabelsPermanent } from './analysis-map/point-markers';
import { getTileLayers } from './analysis-map/tile-layers';
import { CoordinateMenuTarget, DataCircleMarker, Message, NetworkUnit } from './analysis-map/types';
import { getSearchQueryFromCurrentUrl } from './analysis-map/url-state';


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
  private _coordMenuController: AnalysisMapCoordMenuController | null = null;
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
    this._coordMenuController?.close();
  }

  private _openPointContextMenu(target: CoordinateMenuTarget, latlng: L.LatLng): void {
    if (!this._coordMenuController) {
      return;
    }
    this._coordMenuController.open(target, latlng);
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
      requestAnimationFrame(() => this._coordMenuController?.position());
    });
    element.addEventListener('coord-menu-close', () => {
      this._closePointContextMenu();
    });
    return element;
  }

  attributeChangedCallback(name: string, oldValue: any, newValue: string) {
    switch (name) {
      case 'visibility':
        this._handleVisibilityAttributeChanged(newValue);
        break;
      case 'points':
        this._handlePointsAttributeChanged(newValue);
        break;
      case 'daterange':
        this._handleDateRangeAttributeChanged(newValue);
        break;
      case 'daterange-loading':
        this._handleDateRangeLoadingAttributeChanged(newValue);
        break;
      case 'messages':
        this._handleMessagesAttributeChanged(newValue);
        break;
      case 'selected-units':
        this._handleSelectedUnitsAttributeChanged(newValue);
        break;
      case 'palitras':
        this._handlePalitrasAttributeChanged(newValue);
        break;
      case 'palitras-loaded':
        this._handlePalitrasLoadedAttributeChanged(newValue);
        break;
      case 'search':
        this._handleSearchAttributeChanged(newValue);
        break;
      case 'palitras-load-state':
        this._handlePalitrasLoadStateAttributeChanged(newValue);
        break;
      default:
        break;
    }
  }

  private _handleVisibilityAttributeChanged(newValue: string): void {
    if (newValue !== 'true') {
      return;
    }

    if (this._initialized) {
      setTimeout(() => {
        this._map?.invalidateSize();
      }, 0);
      return;
    }

    setTimeout(async () => {
      this.render();
      await this._initializeMap();
      this._initialized = true;
    }, 0);
  }

  private _handlePointsAttributeChanged(newValue: string): void {
    this._points = JSON.parse(newValue);
    if (this._map) {
      this._replacePointsOnMap(this._points);
    }
  }

  private _handleDateRangeAttributeChanged(newValue: string): void {
    this._daterange = JSON.parse(newValue);
    if (this._switchTimeControl) {
      this._switchTimeControl.updateDates(this._daterange);
    }
  }

  private _handleDateRangeLoadingAttributeChanged(newValue: string): void {
    this._isDateRangeLoading = this._parseBooleanAttribute(newValue);
    this._syncAsyncInteractionState();
  }

  private _handleMessagesAttributeChanged(newValue: string): void {
    const parsed = JSON.parse(newValue);
    this._messages = parsed['messages'];
    this._networkUnits = parsed['networkUnits'];
    this._openMessagesPopup();
  }

  private _handleSelectedUnitsAttributeChanged(newValue: string): void {
    this._selectedUnits = JSON.parse(newValue);
  }

  private _handlePalitrasAttributeChanged(newValue: string): void {
    const palitras = JSON.parse(newValue);
    console.log('[AnalysisMap] Palitras attribute changed, count:', palitras.length, 'manager exists:', !!this._palitraManager);
    this._palitras = palitras;
    this._syncVisiblePalitraIds();
    if (this._palitraManager) {
      this._palitraManager.updatePalitras(palitras);
      this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
    }
  }

  private _handlePalitrasLoadedAttributeChanged(newValue: string): void {
    this._palitrasLoaded = JSON.parse(newValue);
    this._syncVisiblePalitraIds();
    if (this._palitraManager) {
      this._palitraManager.updatePalitras(this._palitras);
      this._palitraManager.updateVisibleIds(this._visiblePalitraIds);
    }
  }

  private _handlePalitrasLoadStateAttributeChanged(newValue: string): void {
    this._palitrasLoadState = this._parsePalitrasLoadState(newValue);
    this._palitraManager?.setLoadState(this._palitrasLoadState);
    this._syncAsyncInteractionState();
    if (this._palitrasLoadState === 'success' || this._palitrasLoadState === 'error') {
      this._runSearchQueryIfSet();
    }
  }

  /** Get search query from URL only */
  private _getEffectiveSearchQuery(): string {
    return (getSearchQueryFromCurrentUrl() ?? '').trim();
  }

  /** Set search input value from the current query source. Does not trigger search directly. */
  private _applySearchQuery(queryValue?: string | null) {
    const query = (queryValue ?? this._getEffectiveSearchQuery() ?? '').trim();
    const searchEl = this.querySelector('analysis-map-search');
    if (searchEl) {
      searchEl.setAttribute('initial-query', query);
    }
  }

  private _handleSearchAttributeChanged(newValue: string): void {
    const query = newValue.trim();
    this._applySearchQuery(query);
    if (!this._palitraManager) {
      return;
    }

    if (!query) {
      this._palitraManager.setSearchQuery('');
      return;
    }

    if (this._palitrasLoadState === 'success' || this._palitrasLoadState === 'error') {
      this._palitraManager.setSearchQuery(query);
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
      patchMouseDownMapFocus(map);
      suppressNativeContextMenu(map, shouldHandleMapSurfaceContextMenu);
      map.on('click', () => this._closePointContextMenu());
      map.on('movestart zoomstart resize', () => this._closePointContextMenu());
      map.on('contextmenu', (event: L.LeafletMouseEvent) => {
        if (!shouldHandleMapSurfaceContextMenu(event.originalEvent, map)) {
          return;
        }
        this._clickedPoint = null;
        this._clickedLatLng = null;
        this._openPointContextMenu(
          { lat: event.latlng.lat, lng: event.latlng.lng },
          event.latlng,
        );
      });

      this._map = map;
      const result = this._initializeControls(map, tileLayers)
      this._switchTimeControl = result.switchTimeControl;
      this._coordMenuController = new AnalysisMapCoordMenuController(map, (target) => this._buildPointContextMenuContent(target));

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
         },
         onOverlayContextMenu: (target, latlng) => {
           this._clickedPoint = null;
           this._clickedLatLng = null;
           this._openPointContextMenu(target, L.latLng(latlng.lat, latlng.lng));
         },
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
    this._applySearchQuery();
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
    this._restorePelengLabelsPermanentPreference();

    const result = initializeAnalysisMapControls({
      map,
      tileLayers,
      daterange: this._daterange,
      isDateRangeInteractionLocked: this._isDateRangeInteractionLocked(),
      isFullscreen: this._isFullscreen,
      featureToggleState: this._getFeatureToggleState(),
      pelengLabelsPermanent: this._pelengLabelsPermanent,
      onExit: () => this._emitExit(),
      onToggleFullscreen: () => this._toggleFullscreen(),
      onFeatureToggle: (feature, enabled) => this._setFeatureEnabled(feature, enabled),
      onPelengLabelsPermanentChange: (show) => this._setPelengLabelsPermanent(show),
      onVisiblePalitraIdsChange: (visibleIds) => this._handleVisiblePalitraIdsChange(visibleIds),
    });

    this._searchControl = result.searchControl;
    this._syncAsyncInteractionState();
    this._mapWindowControl = result.mapWindowControl;
    this._layerSwitchControl = result.layerSwitchControl;
    this._mapSettingsControl = result.mapSettingsControl;

    return {
      map,
      switchTimeControl: result.switchTimeControl,
      palitrasControl: result.palitrasControl,
    };
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
    const result = replacePointsLayer({
      map: this._map,
      markersGroup: this._markersGroup,
      pelengsLayerGroup: this._pelengsLayerGroup,
      points,
      boundedAlready: this._boundedAlready,
      buildMarkersGroup: (nextPoints) => this._addPointsMarkersGroup(nextPoints),
    });
    this._markersGroup = result.markersGroup;
    this._boundedAlready = result.boundedAlready;
    this._applyPelengVisibility();
  }

  private _addPointsMarkersGroup(points: MapPointDetailed[]) {
    return createPointsMarkersGroup({
      points,
      pelengLabelsPermanent: this._pelengLabelsPermanent,
      onPointClick: (point, circle) => {
        this._clickedLatLng = circle.getLatLng();
        this._emitLoadMessagesDescriptions([point.message_id]);
        this._clickedPoint = circle;
      },
      onPointContextMenu: (target, latlng, originalEvent) => {
        originalEvent?.preventDefault();
        originalEvent?.stopPropagation();
        this._clickedPoint = null;
        this._clickedLatLng = null;
        this._openPointContextMenu(target, latlng);
      },
      onClusterClick: (messageIds, latlng) => {
        this._clickedPoint = null;
        this._clickedLatLng = latlng;
        this._emitLoadMessagesDescriptions(messageIds);
      },
    });
  }

  private _updatePelengLabelsPermanent() {
    updatePelengLabelsPermanent(this._markersGroup, this._pelengLabelsPermanent);
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
    return findPointMarkerByMessageId(this._markersGroup, messageId);
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
    await loadKmzLayer({
      map: this._map,
      isKmzEnabled: () => this._kmzEnabled,
      kmzLayer: this._kmzLayer,
      kmzLoading: this._kmzLoading,
      setKmzLayer: (kmzLayer) => {
        this._kmzLayer = kmzLayer;
      },
      setKmzLoading: (kmzLoading) => {
        this._kmzLoading = kmzLoading;
      },
    });
  }

  private _applyKmzVisibility() {
    applyKmzVisibility({
      map: this._map,
      isKmzEnabled: () => this._kmzEnabled,
      kmzLayer: this._kmzLayer,
      loadKmzLayer: () => this._loadKmzLayer(),
    });
  }

  private _emitExit(): void {
    this._setFullscreen(false);
    const event = new CustomEvent('exit', {
      detail: {},
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);
  }

  private _handleVisiblePalitraIdsChange(visibleIds: number[]): void {
    const state = this._stateStore.setVisiblePalitraIds(visibleIds);
    this._applyState(state);
    this._palitraManager?.updateVisibleIds(this._visiblePalitraIds);
  }

  private _restorePelengLabelsPermanentPreference(): void {
    try {
      const saved = localStorage.getItem('analysis-map-peleng-labels');
      if (saved !== null) {
        this._pelengLabelsPermanent = saved !== 'false';
      }
    } catch {
      this._pelengLabelsPermanent = true;
    }
  }

  private _setPelengLabelsPermanent(show: boolean): void {
    this._pelengLabelsPermanent = show;
    try {
      localStorage.setItem('analysis-map-peleng-labels', String(show));
    } catch {
      // ignore
    }
    this._updatePelengLabelsPermanent();
  }

  private _openMessagesPopup(): void {
    openMessagesPopup({
      map: this._map,
      clickedPoint: this._clickedPoint,
      clickedLatLng: this._clickedLatLng,
      messages: this._messages,
      networkUnits: this._networkUnits,
      selectedUnits: this._selectedUnits,
      findPointMarkerByMessageId: (messageId) => this._findPointMarkerByMessageId(messageId),
      onUnitClicked: (networkUnitName) => this._emitMessageUnitClicked(networkUnitName),
      setClickedState: (clickedPoint, clickedLatLng) => {
        this._clickedPoint = clickedPoint;
        this._clickedLatLng = clickedLatLng;
      },
    });
  }

  private _emitMessageUnitClicked(networkUnitName: string | null): void {
    const event = new CustomEvent('message-unit-clicked', {
      detail: {
        networkUnitName,
      },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

customElements.define('analysis-map', AnalysisMap)
