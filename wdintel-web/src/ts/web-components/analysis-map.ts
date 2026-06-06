import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { KMZLayer } from '../maps/leaflet-kmz'
import { MapPointDetailed } from '../maps/types';
import { TimeswitchControl, FeatureToggleState, FeatureName, LayerSwitchControl, SearchControl, MapWindowControl, MapSettingsControl, PalitrasControl, PalitrasLoadState } from '../maps/controls';
import { AnalysisMapStateStore, AnalysisMapStoredState } from '../maps/analysis-map-state';
import { parseCoordinateInput } from '../maps/coordinate-search';
import { PalitraManager } from '../maps/palitra-manager';
import { PalitraDetails } from '../maps/palitra-types';
import { AnalysisMapCoordMenuController } from './analysis-map/coord-menu-controller';
import { applyKmzVisibility, loadKmzLayer } from './analysis-map/kmz-layer';
import { initializeAnalysisMapControls } from './analysis-map/map-controls';
import { patchMouseDownMapFocus, shouldHandleMapSurfaceContextMenu, suppressNativeContextMenu } from './analysis-map/map-interactions';
import { openMessagesPopup } from './analysis-map/message-popup';
import { createPointsMarkersGroup, findPointMarkerByMessageId, replacePointsLayer } from './analysis-map/point-markers';
import { buildPelengLabelGroups } from './analysis-map/peleng-label-groups';
import { getTileLayers } from './analysis-map/tile-layers';
import { CoordinateMenuTarget, DataCircleMarker, Message, NetworkUnit } from './analysis-map/types';
import { getSearchQueryFromCurrentUrl } from './analysis-map/url-state';


class AnalysisMap extends HTMLElement {
  static observedAttributes = ["points", "daterange", "daterange-loading", "messages", "messages-loading", "messages-load-serial", "visibility", "network-units", "selected-units", "palitras", "palitras-loaded", "search", "palitras-load-state", "overlay-controls-collapsed"]

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
  private _pelengLabelsLayerGroup: L.LayerGroup | null = null;
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
  private _palitrasControl: PalitrasControl | null = null;
  private _isDateRangeLoading = false;
  private _isSearchLoading = false;
  private _overlayControlsCollapsed = false;
  private _isVisible = false;
  private _messagesLoading = false;
  private _messagesPopupPending = false;
  private _messagesLoadSerial = 0;
  private _messagesLoadingTarget: L.Layer | null = null;
  private _messagesPopupOpenFrame: number | null = null;
  private _messagesPopupOpenRetryCount = 0;
  private static readonly _messagesPopupOpenRetryLimit = 3;
  private _handleMapViewChanged = () => {
    this._renderPelengLabelGroups();
  };
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
    this._map?.off('zoomend', this._handleMapViewChanged);
    this._map?.off('moveend', this._handleMapViewChanged);
    this._closePointContextMenu();
    this._cancelMessagesPopupOpen();
    this._clearMessagesLoadingIndicator();
    this._clearPelengLabelsLayer();
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
      case 'messages-loading':
        this._handleMessagesLoadingAttributeChanged(newValue);
        break;
      case 'messages-load-serial':
        this._handleMessagesLoadSerialAttributeChanged(newValue);
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
      case 'overlay-controls-collapsed':
        this._handleOverlayControlsCollapsedAttributeChanged(newValue);
        break;
      default:
        break;
    }
  }

  private _handleVisibilityAttributeChanged(newValue: string): void {
    this._isVisible = newValue === 'true';
    if (!this._isVisible) {
      this._cancelMessagesPopupOpen();
      this._clearMessagesLoadingIndicator();
      return;
    }

    if (this._initialized) {
      setTimeout(() => {
        this._map?.invalidateSize();
        this._collapseOverlayControls();
        this._openMessagesPopupIfReady();
      }, 0);
      return;
    }

    setTimeout(async () => {
      this.render();
      await this._initializeMap();
      this._initialized = true;
      this._collapseOverlayControls();
      this._openMessagesPopupIfReady();
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
    this._scheduleMessagesPopupOpen();
  }

  private _handleMessagesLoadingAttributeChanged(newValue: string): void {
    this._messagesLoading = this._parseBooleanAttribute(newValue);
    this._syncMessagesLoadingIndicator();
    if (!this._messagesLoading && this._messages.length === 0) {
      this._clearMessagesPopupState();
      return;
    }
    this._scheduleMessagesPopupOpen();
  }

  private _handleMessagesLoadSerialAttributeChanged(newValue: string): void {
    const loadSerial = Number.parseInt(newValue, 10);
    if (!Number.isFinite(loadSerial) || loadSerial === this._messagesLoadSerial) {
      return;
    }
    this._messagesLoadSerial = loadSerial;
    this._messagesPopupPending = true;
    this._messagesPopupOpenRetryCount = 0;
    this._scheduleMessagesPopupOpen();
  }

  private _handleSelectedUnitsAttributeChanged(newValue: string): void {
    this._selectedUnits = JSON.parse(newValue);
  }

  private _handlePalitrasAttributeChanged(newValue: string): void {
    const palitras = JSON.parse(newValue);
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

  private _handleOverlayControlsCollapsedAttributeChanged(newValue: string): void {
    this._overlayControlsCollapsed = this._parseBooleanAttribute(newValue);
    if (this._overlayControlsCollapsed) {
      this._collapseOverlayControls();
    }
  }

  private _getSearchQueryFromAttribute(): string | null {
    if (!this.hasAttribute('search')) {
      return null;
    }

    return (this.getAttribute('search') ?? '').trim();
  }

  /** Prefer explicit attribute state; fall back to URL only when attribute is absent. */
  private _getEffectiveSearchQuery(): string {
    const attributeQuery = this._getSearchQueryFromAttribute();
    if (attributeQuery !== null) {
      return attributeQuery;
    }

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
      this._pelengLabelsLayerGroup = L.layerGroup();
      map.on('zoomend', this._handleMapViewChanged);
      map.on('moveend', this._handleMapViewChanged);

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
         onOverlayContextMenu: (target, latlng) => {
           this._clickedPoint = null;
           this._clickedLatLng = null;
           this._openPointContextMenu(target, L.latLng(latlng.lat, latlng.lng));
         },
       }
     );
     
     this._palitraManager.setControl(result.palitrasControl);
     this._palitraManager.setLoadState(this._palitrasLoadState);
     this._syncAsyncInteractionState();
     
     if (this._palitras.length > 0) {
       this._palitraManager.updatePalitras(this._palitras);
     }
     if (this._visiblePalitraIds.length > 0) {
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
    this._palitrasControl = result.palitrasControl;

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
    return this._isDateRangeLoading || this._palitrasLoadState === 'loading';
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
      pelengLabelsLayerGroup: this._pelengLabelsLayerGroup,
      points,
      boundedAlready: this._boundedAlready,
      buildMarkersGroup: (nextPoints) => this._addPointsMarkersGroup(nextPoints),
    });
    this._markersGroup = result.markersGroup;
    this._boundedAlready = result.boundedAlready;
    this._applyPelengVisibility();
    this._renderPelengLabelGroups();
  }

  private _addPointsMarkersGroup(points: MapPointDetailed[]) {
    return createPointsMarkersGroup({
      points,
      onPointClick: (point, circle) => {
        this._clickedPoint = circle;
        this._clickedLatLng = circle.getLatLng();
        this._setMessagesLoading(true, circle);
        this._emitLoadMessagesDescriptions([circle.getData().messageId]);
      },
      onPointContextMenu: (target, latlng, originalEvent) => {
        originalEvent?.preventDefault();
        originalEvent?.stopPropagation();
        this._clickedPoint = null;
        this._clickedLatLng = null;
        this._openPointContextMenu(target, latlng);
      },
      onClusterClick: (messageIds, latlng, cluster) => {
        this._clickedPoint = null;
        this._clickedLatLng = latlng;
        this._setMessagesLoading(true, cluster);
        this._emitLoadMessagesDescriptions(messageIds);
      },
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

  private _collapseOverlayControls(): void {
    if (!this._overlayControlsCollapsed) {
      return;
    }

    this._palitrasControl?.setCollapsed(true);
    this._layerSwitchControl?.setCollapsed(true);
    this._mapSettingsControl?.setCollapsed(true);
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
    if (!this._map || !this._pelengsLayerGroup || !this._pelengLabelsLayerGroup) {
      return;
    }

    if (!this._pelengsEnabled) {
      this._map.removeLayer(this._pelengsLayerGroup);
      this._map.removeLayer(this._pelengLabelsLayerGroup);
      this._clearPelengLabelsLayer();
      return;
    }

    this._pelengsLayerGroup.addTo(this._map);
    if (this._pelengLabelsPermanent) {
      this._pelengLabelsLayerGroup.addTo(this._map);
      this._renderPelengLabelGroups();
      return;
    }

    this._map.removeLayer(this._pelengLabelsLayerGroup);
    this._clearPelengLabelsLayer();
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
    this._applyPelengVisibility();
  }

  private _clearPelengLabelsLayer(): void {
    if (this._map && this._pelengLabelsLayerGroup) {
      this._map.removeLayer(this._pelengLabelsLayerGroup);
    }
    this._pelengLabelsLayerGroup?.clearLayers();
  }

  private _renderPelengLabelGroups(): void {
    const map = this._map;
    const labelsLayerGroup = this._pelengLabelsLayerGroup;
    if (!map || !labelsLayerGroup) {
      return;
    }

    labelsLayerGroup.clearLayers();

    if (!this._pelengsEnabled || !this._pelengLabelsPermanent || this._points.length === 0) {
      return;
    }

    const visibleBounds = map.getBounds().pad(0.2);
    const visiblePoints = this._points.filter((point) => visibleBounds.contains([point.lat, point.lng]));
    if (visiblePoints.length === 0) {
      return;
    }

    const labelGroups = buildPelengLabelGroups(
      visiblePoints,
      (point) => map.project([point.lat, point.lng], map.getZoom()),
      44,
    );

    labelGroups.forEach((group) => {
      const marker = L.marker([group.centroid.lat, group.centroid.lng], {
        interactive: false,
        keyboard: false,
        opacity: 0,
        icon: L.divIcon({
          className: 'peleng-label-anchor',
          html: '',
          iconSize: [1, 1],
          iconAnchor: [0, 0],
        }),
      });

      marker.bindTooltip(group.displayLabel, {
        permanent: true,
        direction: 'top',
        offset: [0, -8],
        className: 'peleng-point-label',
      });

      labelsLayerGroup.addLayer(marker);
    });
  }

  private _openMessagesPopup(): boolean {
    const opened = openMessagesPopup({
      map: this._map,
      clickedPoint: this._clickedPoint,
      clickedLatLng: this._clickedLatLng,
      preferClickedLatLng: this._clickedPoint === null,
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
    if (!opened) {
      return false;
    }

    this._messagesPopupPending = false;
    this._setMessagesLoading(false);
    return true;
  }

  private _openMessagesPopupIfReady(): void {
    this._scheduleMessagesPopupOpen();
  }

  private _clearMessagesPopupState(): void {
    this._cancelMessagesPopupOpen();
    this._messagesPopupPending = false;
    this._messagesPopupOpenRetryCount = 0;

    if (this._clickedPoint) {
      this._clickedPoint.closePopup();
    } else {
      this._map?.closePopup();
    }

    this._clickedPoint = null;
    this._clickedLatLng = null;
  }

  private _scheduleMessagesPopupOpen(): void {
    if (this._messagesPopupOpenFrame !== null) {
      return;
    }

    this._messagesPopupOpenFrame = window.requestAnimationFrame(() => {
      this._messagesPopupOpenFrame = null;

      if (!this._messagesPopupPending || !this._isVisible || !this._initialized || this._messagesLoading) {
        return;
      }

      const opened = this._openMessagesPopup();
      if (!opened && this._messagesPopupPending && this._messagesPopupOpenRetryCount < AnalysisMap._messagesPopupOpenRetryLimit) {
        this._messagesPopupOpenRetryCount += 1;
        this._scheduleMessagesPopupOpen();
      } else if (opened) {
        this._messagesPopupOpenRetryCount = 0;
      }
    });
  }

  private _cancelMessagesPopupOpen(): void {
    if (this._messagesPopupOpenFrame !== null) {
      window.cancelAnimationFrame(this._messagesPopupOpenFrame);
      this._messagesPopupOpenFrame = null;
    }
    this._messagesPopupOpenRetryCount = 0;
  }

  private _syncMessagesLoadingIndicator(): void {
    if (!this._messagesLoading || !this._messagesLoadingTarget) {
      this._clearMessagesLoadingIndicator();
      return;
    }

    if (this._messagesLoadingTarget instanceof DataCircleMarker) {
      this._syncPointMessagesLoadingIndicator(this._messagesLoadingTarget);
      return;
    }

    this._syncClusterMessagesLoadingIndicator(this._messagesLoadingTarget);
  }

  private _clearMessagesLoadingIndicator(): void {
    if (this._messagesLoadingTarget instanceof DataCircleMarker) {
      const path = this._messagesLoadingTarget.getElement() as (SVGPathElement & { classList: DOMTokenList }) | null;
      if (path) {
        path.classList.remove('analysis-map-message-loading-target');
      }
    } else if (this._messagesLoadingTarget) {
      const icon = (this._messagesLoadingTarget as any).getElement?.() as (HTMLElement & { classList: DOMTokenList }) | null;
      if (icon) {
        icon.classList.remove('analysis-map-message-loading-target--cluster');
      }
    }
    this._messagesLoadingTarget = null;
  }

  private _syncPointMessagesLoadingIndicator(target: DataCircleMarker): void {
    const path = target.getElement() as (SVGPathElement & { classList: DOMTokenList }) | null;
    if (!path) {
      return;
    }

    path.classList.add('analysis-map-message-loading-target');
    path.classList.remove('analysis-map-message-loading-target--cluster');
  }

  private _syncClusterMessagesLoadingIndicator(target: L.Layer): void {
    const icon = (target as any).getElement?.() as (HTMLElement & { classList: DOMTokenList }) | null;
    if (!icon) {
      return;
    }

    icon.classList.add('analysis-map-message-loading-target--cluster');
  }

  private _setMessagesLoading(loading: boolean, target: L.Layer | null = null): void {
    this._messagesLoading = loading;
    this._messagesLoadingTarget = loading ? target : null;
    this._syncMessagesLoadingIndicator();
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
