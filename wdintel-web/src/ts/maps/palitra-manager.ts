import * as L from 'leaflet';
import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { PalitraDetails, PalitraManagerOptions, PalitraManagerCallbacks, Palitra, PalitraPoint, Coords } from './palitra-types';
import { PalitraCacheManager } from './palitra-cache-manager';
import { PalitrasControl } from './controls';
import {
  parseSearchQuery,
  labelMatchesTerm,
  termToApiString,
} from './palitra-search';
import { truncateToMaxRendered, cullSearchResultsToViewport } from './utils/palitra-render-utils';

/** When search returns more than this many points, only markers in the current viewport are drawn. */
const SEARCH_RESULTS_VIEWPORT_CULL_THRESHOLD = 1000;

/** Never render more than this many point markers (viewport-culled or not) to avoid lockup. */
const MAX_RENDERED_POINTS = 1000;

/** When computing fitBounds, sample at most this many points to avoid O(n) with huge result sets. */
const BOUNDS_SAMPLE_SIZE = 2000;

/** Max markers to add per frame when building clusters (keeps UI responsive). */
const MARKER_ADD_CHUNK_SIZE = 60;

/** Debounce moveend before re-rendering viewport chunk (avoids work during pan). */
const RENDER_VIEWPORT_DEBOUNCE_MS = 100;

export class PalitraManager {
  private cacheManager: PalitraCacheManager;
  private layerGroup: L.LayerGroup;
  private pointsClusters: Map<number, L.MarkerClusterGroup> = new Map();
  /** All point markers added (for viewport-based label visibility). Cleared when clusters are cleared. */
  private pointMarkers: (L.CircleMarker & { _palitraTooltipLabel?: string })[] = [];
  private control: PalitrasControl | null = null;

  private palitras: PalitraDetails[] = [];
  private visibleIds: number[] = [];
  private enabled = true;
  private boundsApplied = false;
  private requestTimer: number | null = null;
  private _searchQuery = '';
  /** Full search result from BE. Only create markers for viewport chunk. */
  private _lastSearchResult: { palitra_id: number; points: PalitraPoint[] }[] | null = null;
  /** Incremented on each render start; used to discard stale async renders. */
  private _renderGeneration = 0;
  private _renderViewportTimer: number | null = null;

  constructor(
    private map: L.Map,
    private options: PalitraManagerOptions,
    private callbacks: PalitraManagerCallbacks
  ) {
    this.cacheManager = new PalitraCacheManager(
      options.cacheTtlMs,
      options.maxCachedTiles
    );
    this.layerGroup = L.layerGroup().addTo(map);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.map.on('zoomend', () => {
      this.updatePoints();
      this.scheduleRenderPointsInViewport();
      this.updatePointLabelVisibility();
    });
    this.map.on('moveend', () => {
      this.scheduleRenderPointsInViewport(); 
      this.updatePointLabelVisibility();
    });
  }

// debounced: cleanup outside viewport, re-render chunk
  private scheduleRenderPointsInViewport(): void {
    if (this._renderViewportTimer !== null) {
      window.clearTimeout(this._renderViewportTimer);
    }
    this._renderViewportTimer = window.setTimeout(() => {
      this._renderViewportTimer = null;
      this.renderPointsInViewport();
    }, RENDER_VIEWPORT_DEBOUNCE_MS);
  }

  updatePalitras(palitras: PalitraDetails[]): void {
    this.palitras = palitras;
    if (this.control) {
      this.control.updatePalitras(palitras, this.visibleIds);
    }
    // Update control visibility after palitras change
    this.updateControlVisibility();
    this.updatePolygons();
    this.schedulePointsRequest();
  }

  updateVisibleIds(ids: number[]): void {
    this.visibleIds = ids;
    if (this.control) {
      this.control.updatePalitras(this.palitras, ids);
    }
    // Update control visibility (in case it's the first update)
    this.updateControlVisibility();
    this.boundsApplied = false;
    this.updatePolygons();
    this.schedulePointsRequest();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.updateControlVisibility();
    this.boundsApplied = false;
    this.updatePolygons();
  }

  setControl(control: PalitrasControl): void {
    this.control = control;
    this.updateControlVisibility();
    // If we already have palitras, update the control
    if (this.palitras.length > 0) {
      this.control.updatePalitras(this.palitras, this.visibleIds);
    }
  }

  setSearchQuery(query: string): void {
    const q = (query ?? '').trim();
    if (q === '') {
      this._searchQuery = '';
      this._lastSearchResult = null;
      this._renderGeneration++;
      this.callbacks.onSearchLoadingChanged(false);
      this.callbacks.onSearchResultsCountChanged(null);
      this.updatePoints();
      return;
    }
    this._searchQuery = q;
    // search in all palitras, not only visible ones
    const palitraIds = this.palitras.map(p => p.palitra.id);
    if (palitraIds.length === 0) {
      this.callbacks.onSearchLoadingChanged(false);
      this._showSearchResults([]);
      return;
    }
    this.callbacks.onSearchLoadingChanged(true);

    const searchTerms = parseSearchQuery(q);

    const fromCache = this.cacheManager.getCachedPointsForPalitras(palitraIds);
    const filteredFromCache = fromCache.map(({ palitra_id, points }) => ({
      palitra_id,
      points: points.filter(
        (p) =>
          p.label &&
          searchTerms.some((term) => labelMatchesTerm(p.label!.toLowerCase(), term))
      )
    }));
    this._showSearchResults(filteredFromCache);

    const termsForApi = [...new Set(searchTerms.map(termToApiString))];
    this.cacheManager
      .fetchSearchPoints(palitraIds, termsForApi)
      .then((backendData) => {
        if (this._searchQuery !== q) return;
        const merged = this._mergeSearchResults(filteredFromCache, backendData);
        this._showSearchResults(merged);
      })
      .catch((err) => {
        console.error('[PalitraManager] Search failed:', err);
      })
      .finally(() => {
        if (this._searchQuery !== q) return;
        this.callbacks.onSearchLoadingChanged(false);
      });
  }

  private _mergeSearchResults(
    cacheData: { palitra_id: number; points: PalitraPoint[] }[],
    backendData: { palitra_id: number; points: PalitraPoint[] }[]
  ): { palitra_id: number; points: PalitraPoint[] }[] {
    const byPalitra = new Map<number, Map<string, PalitraPoint>>();
    const addPoints = (palitraId: number, points: PalitraPoint[]) => {
      let byKey = byPalitra.get(palitraId);
      if (!byKey) {
        byKey = new Map();
        byPalitra.set(palitraId, byKey);
      }
      points.forEach((p) => {
        byKey!.set(PalitraCacheManager.pointKey(p), p);
      });
    };
    cacheData.forEach(({ palitra_id, points }) => addPoints(palitra_id, points));
    backendData.forEach(({ palitra_id, points }) => addPoints(palitra_id, points));
    return Array.from(byPalitra.entries()).map(([palitra_id, byKey]) => ({
      palitra_id,
      points: Array.from(byKey.values())
    }));
  }

  private async _showSearchResults(
    data: { palitra_id: number; points: PalitraPoint[] }[]
  ): Promise<void> {
    const resultsCount = data.reduce((acc, item) => acc + item.points.length, 0);
    this.callbacks.onSearchResultsCountChanged(resultsCount);

    this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
    this.pointsClusters.clear();
    this.pointMarkers = [];

    if (!this.enabled) {
      return;
    }

    /** Keep full response in memory; we only create markers for the current viewport. */
    this._lastSearchResult = data;

    if (resultsCount > MAX_RENDERED_POINTS) {
      this.callbacks.onSearchResultsTruncated?.(MAX_RENDERED_POINTS, resultsCount);
    }

    const fullBounds = this._boundsOfSearchResults(data);
    if (fullBounds) {
      this.map.fitBounds(fullBounds, { padding: [40, 40], maxZoom: 14 });
    }

    await this.renderPointsInViewport();
  }

  /**
   * From _lastSearchResult (full BE response), take only the chunk in current viewport,
   * create markers for that chunk only. Called on initial search and on moveend/zoomend (debounced).
   */
  private async renderPointsInViewport(): Promise<void> {
    if (!this._searchQuery || !this.enabled || !this._lastSearchResult) {
      return;
    }

    const currentGen = ++this._renderGeneration;

    const data = this._lastSearchResult;
    const resultsCount = data.reduce((acc, item) => acc + item.points.length, 0);

    let toRender =
      resultsCount > SEARCH_RESULTS_VIEWPORT_CULL_THRESHOLD
        ? cullSearchResultsToViewport(data, this.getBufferedBounds())
        : data;

    const totalInView = toRender.reduce((acc, item) => acc + item.points.length, 0);
    if (totalInView > MAX_RENDERED_POINTS) {
      toRender = truncateToMaxRendered(toRender, MAX_RENDERED_POINTS);
    }

    this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
    this.pointsClusters.clear();
    this.pointMarkers = [];

    const palitraById = new Map(this.palitras.map((p) => [p.palitra.id, p.palitra]));

    const entries = toRender.filter(
      ({ palitra_id, points }) => palitraById.get(palitra_id) && points.length > 0
    );

    const clusters = await Promise.all(
      entries.map(async ({ palitra_id, points }) => {
        const palitra = palitraById.get(palitra_id)!;
        const cluster = await this.createPointsCluster(palitra, points);
        return { palitra_id, cluster };
      })
    );

    if (currentGen !== this._renderGeneration) {
      return;
    }

    clusters.forEach(({ palitra_id, cluster }) => {
      if (cluster) {
        this.pointsClusters.set(palitra_id, cluster);
        this.map.addLayer(cluster);
      }
    });

    this.updatePointLabelVisibility();
  }

  private _boundsOfSearchResults(
    data: { palitra_id: number; points: PalitraPoint[] }[]
  ): L.LatLngBounds | null {
    const total = data.reduce((acc, item) => acc + item.points.length, 0);
    if (total === 0) return null;

    const sampleStep =
      total <= BOUNDS_SAMPLE_SIZE ? 1 : Math.max(1, Math.floor(total / BOUNDS_SAMPLE_SIZE));
    const latLngs: L.LatLng[] = [];
    let index = 0;
    for (const { points } of data) {
      for (const p of points) {
        if (index % sampleStep === 0) {
          latLngs.push(L.latLng(p.coords.lat, p.coords.lng));
        }
        index++;
      }
    }
    if (latLngs.length === 0) return null;
    return L.latLngBounds(latLngs);
  }

  destroy(): void {
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
    }
    if (this._renderViewportTimer !== null) {
      window.clearTimeout(this._renderViewportTimer);
      this._renderViewportTimer = null;
    }
    this.layerGroup.clearLayers();
    this.map.removeLayer(this.layerGroup);
    this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
    this.pointsClusters.clear();
    if (this.control) {
      this.map.removeControl(this.control);
    }
    this.cacheManager.clear();
  }

  private schedulePointsRequest(): void {
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
    }
    this.requestTimer = window.setTimeout(() => {
      this.requestTimer = null;
      this.requestPoints();
    }, this.options.requestDelayMs);
  }

  private async requestPoints(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    // Points requested only when visible palitra list change
    if (this.visibleIds.length === 0) {
      return;
    }
    const currentZoom = this.map.getZoom();
    if (currentZoom < this.options.minZoomForPoints) {
      return;
    }
    const bounds = this.getBufferedBounds();
    const palitraIds = this.filterByBounds(bounds);
    if (palitraIds.length === 0) {
      return;
    }
    const requestPalitraIds = this.cacheManager.filterByCache(palitraIds, bounds, currentZoom);
    if (requestPalitraIds.length === 0) {
      return;
    }
    const tileKey = this.cacheManager.buildTileKey(bounds, currentZoom);
    
    // Filter out pending requests
    const filteredIds = requestPalitraIds.filter(id => {
      return !this.cacheManager.hasPendingRequest(id, tileKey);
    });
    
    if (filteredIds.length === 0) {
      return;
    }
    
    // Mark as pending
    this.cacheManager.markPending(filteredIds, tileKey);
    this.cacheManager.markRequested(filteredIds, tileKey);
    
    try {
      await this.cacheManager.fetchPoints(filteredIds, bounds, tileKey, () => {
        this.updatePoints();
      });
    } finally {
      // Remove from pending
      this.cacheManager.clearPending(filteredIds, tileKey);
    }
  }

  /** Visible viewport bounds with 10% padding. */
  private getBufferedBounds(): L.LatLngBounds {
    const bounds = this.map.getBounds();
    return bounds.pad(0.1);
  }

  private filterByBounds(bounds: L.LatLngBounds): number[] {
    return this.palitras
      .filter(palitraDetails => this.visibleIds.includes(palitraDetails.palitra.id))
      .filter(palitraDetails => {
        const geometry = palitraDetails.palitra.geometry;
        if (!geometry || !geometry.perimeter_linear_ring) {
          return true;
        }
        const ring = geometry.perimeter_linear_ring;
        if (ring.length === 0) {
          return true;
        }
        const palitraBounds = this.buildBounds(ring);
        return bounds.intersects(palitraBounds);
      })
      .map(palitraDetails => palitraDetails.palitra.id);
  }

  private buildBounds(coords: Coords[]): L.LatLngBounds {
    let minLat = coords[0].lat;
    let maxLat = coords[0].lat;
    let minLng = coords[0].lng;
    let maxLng = coords[0].lng;
    coords.forEach(coord => {
      if (coord.lat < minLat) {
        minLat = coord.lat;
      }
      if (coord.lat > maxLat) {
        maxLat = coord.lat;
      }
      if (coord.lng < minLng) {
        minLng = coord.lng;
      }
      if (coord.lng > maxLng) {
        maxLng = coord.lng;
      }
    });
    return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
  }

  private updatePolygons(): void {
    if (!this.enabled) {
      this.layerGroup.clearLayers();
      this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
      this.pointsClusters.clear();
      return;
    }

    // Clear existing polygons
    this.layerGroup.clearLayers();

    // Add visible palitras
    const visiblePalitras = this.palitras.filter(pd =>
      this.visibleIds.includes(pd.palitra.id) && pd.palitra.geometry
    );

    const polygons: L.Polygon[] = [];

    visiblePalitras.forEach(palitraDetails => {
      const polygon = this.createPolygon(palitraDetails);
      if (polygon) {
        this.layerGroup.addLayer(polygon);
        polygons.push(polygon);
      } else {
        console.log('❌ Polygon creation failed');
      }
    });

    // Update points clusters
    this.updatePoints();

    // Fit map bounds to show all visible palitras
    const currentZoom = this.map.getZoom();
    if (!this.boundsApplied && polygons.length > 0 && currentZoom < this.options.minZoomForPoints) {
      const group = L.featureGroup(polygons);
      this.map.fitBounds(group.getBounds(), {
        padding: [50, 50],
        maxZoom: 10
      });
      this.boundsApplied = true;
    }
  }

  private createPolygon(palitraDetails: PalitraDetails): L.Polygon | null {
    const palitra = palitraDetails.palitra;

    if (!palitra.geometry || !palitra.geometry.perimeter_linear_ring) {
      return null;
    }

    // Convert coordinates to Leaflet format [lat, lng]
    const latlngs: [number, number][] = palitra.geometry.perimeter_linear_ring.map(
      (coord: Coords) => [coord.lat, coord.lng] as [number, number]
    );

    if (latlngs.length < 3) {
      return null; // Need at least 3 points for a polygon
    }

    // Create polygon with styling
    const polygon = L.polygon(latlngs, {
      color: palitra.color_hex,
      fillColor: palitra.color_hex,
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.8
    });

    // Add popup with palitra info
    const pointsCount = palitra.geometry.perimeter_linear_ring.length;
    const centerLat = palitra.geometry.center.lat.toFixed(4);
    const centerLng = palitra.geometry.center.lng.toFixed(4);

    const popupContent = `
      <div style="padding: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span style="display: inline-block; width: 16px; height: 16px; background-color: ${palitra.color_hex}; border: 1px solid #ccc; border-radius: 3px;"></span>
          <strong style="font-size: 14px;">${palitra.name}</strong>
        </div>
        <div style="font-size: 12px; color: #666;">
          <div>Центр: ${centerLat}, ${centerLng}</div>
          <div>Точок периметру: ${pointsCount}</div>
          ${palitra.source_file_name ? `<div>Файл: ${palitra.source_file_name}</div>` : ''}
        </div>
      </div>
    `;

    polygon.bindPopup(popupContent);

    // Add tooltip with name (always visible)
    polygon.bindTooltip(palitra.name, {
      permanent: true,
      direction: 'center',
      className: 'palitra-label'
    });

    return polygon;
  }

  private addMarkerToCluster(
    clusterGroup: L.MarkerClusterGroup,
    palitra: Palitra,
    point: PalitraPoint
  ): void {
    const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
      radius: 6,
      fillColor: palitra.color_hex,
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    });

    const popupContent = `
        <div style="padding: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="display: inline-block; width: 16px; height: 16px; background-color: ${palitra.color_hex}; border: 1px solid #ccc; border-radius: 50%;"></span>
            <strong style="font-size: 14px;">${palitra.name}</strong>
          </div>
          ${point.label ? `<div style="font-size: 13px; margin-bottom: 4px;"><strong>Мітка:</strong> ${point.label}</div>` : ''}
          <div style="font-size: 12px; color: #666;">
            <div>Координати: ${point.coords.lat.toFixed(5)}, ${point.coords.lng.toFixed(5)}</div>
          </div>
        </div>
      `;

    marker.bindPopup(popupContent);

    const tooltipLabel = point.label ?? palitra.name;
    if (tooltipLabel) {
      (marker as L.CircleMarker & { _palitraTooltipLabel?: string })._palitraTooltipLabel =
        tooltipLabel;
    }

    this.pointMarkers.push(marker as L.CircleMarker & { _palitraTooltipLabel?: string });
    clusterGroup.addLayer(marker);
  }

  /** Bind permanent tooltips only for markers in viewport; unbind for those outside. */
  private updatePointLabelVisibility(): void {
    const bounds = this.map.getBounds();
    for (const marker of this.pointMarkers) {
      const label = marker._palitraTooltipLabel;
      if (!label) continue;

      const inView = bounds.contains(marker.getLatLng());
      const hasTooltip = marker.getTooltip();
      const isPermanent = hasTooltip?.options?.permanent === true;

      if (inView && !isPermanent) {
        marker.unbindTooltip();
        marker.bindTooltip(label, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: 'palitra-point-label'
        });
      } else if (!inView && hasTooltip) {
        marker.unbindTooltip();
      }
    }
  }

  private async createPointsCluster(
    palitra: Palitra,
    points: PalitraPoint[]
  ): Promise<L.MarkerClusterGroup | null> {
    if (!points || points.length === 0) {
      return null;
    }

    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      animate: false,
      animateAddingMarkers: false,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: (cluster) => {
        const childCount = cluster.getChildCount();
        return L.divIcon({
          html: `<div style="background-color: ${palitra.color_hex}; border: 2px solid #fff; border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; font-weight: bold; color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                ${childCount}
            </div>`,
          className: 'palitra-point-cluster',
          iconSize: L.point(30, 30)
        });
      }
    });

    for (let i = 0; i < points.length; i += MARKER_ADD_CHUNK_SIZE) {
      const chunk = points.slice(i, i + MARKER_ADD_CHUNK_SIZE);
      chunk.forEach((point) =>
        this.addMarkerToCluster(clusterGroup, palitra, point)
      );
      if (i + MARKER_ADD_CHUNK_SIZE < points.length) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    }

    return clusterGroup;
  }

  private updatePoints(): void {
    // Points are only shown when search is active (via _showSearchResults). When not searching, show only palitra zones (polygons).
    if (!this._searchQuery) {
      this.pointsClusters.forEach((cluster) => this.map.removeLayer(cluster));
      this.pointsClusters.clear();
      this.pointMarkers = [];
      return;
    }
  }

  private updateControlVisibility(): void {
    if (!this.control) {
      return;
    }

    const isControlOnMap = (this.control as any)._map === this.map;
    const hasPalitras = this.palitras.length > 0;
    console.log('[PalitraManager] updateControlVisibility: enabled:', this.enabled, 'isControlOnMap:', isControlOnMap, 'hasPalitras:', hasPalitras);

    // Don't show control if disabled OR no palitras
    if (!this.enabled || !hasPalitras) {
      if (isControlOnMap) {
        this.map.removeControl(this.control);
      }
      return;
    }

    // Show control only if enabled AND has palitras
    if (!isControlOnMap) {
      this.map.addControl(this.control);
    }
  }
}
