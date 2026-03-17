import * as L from 'leaflet';

import { PalitraCacheManager } from './palitra-cache-manager';
import { Palitra, PalitraDetails, PalitraManagerCallbacks, PalitraManagerOptions } from './palitra-types';
import { filterPalitraApiIdsByBounds } from './utils/palitra-map-geometry';

const BACKGROUND_PRELOAD_ZOOM = 13;
const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));

type StateAccessor = {
  getPalitras: () => PalitraDetails[];
  getEnabled: () => boolean;
};

type MapAccessor = {
  getBufferedBounds: () => L.LatLngBounds;
  shouldRenderPointsAtCurrentZoom: () => boolean;
};

type ApiAccessor = {
  apiPalitraId: (palitra: Palitra) => number;
};

export class PalitraPointsLoader {
  private requestTimer: number | null = null;
  private backgroundPreloadKey: string | null = null;
  private backgroundPreloadRequestedKey: string | null = null;
  private backgroundPreloadInFlight = false;

  constructor(
    private map: L.Map,
    private options: PalitraManagerOptions,
    private callbacks: PalitraManagerCallbacks,
    private cacheManager: PalitraCacheManager,
    private stateAccessor: StateAccessor,
    private mapAccessor: MapAccessor,
    private apiAccessor: ApiAccessor,
    private onPointsUpdated: () => void,
    private onViewportRequestSettled: () => void,
  ) {}

  onPalitrasChanged(): void {
    // Warm up cache in background for faster first zoom-in render.
    this.scheduleBackgroundPointsPreload();
    this.schedulePointsRequest();
  }

  schedulePointsRequest(): void {
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
    }
    this.requestTimer = window.setTimeout(() => {
      this.requestTimer = null;
      void this.requestPoints();
    }, this.options.requestDelayMs);
  }

  destroy(): void {
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
  }

  private scheduleBackgroundPointsPreload(): void {
    const palitraIds = this.getAllApiPalitraIds();

    if (palitraIds.length === 0) {
      this.backgroundPreloadKey = null;
      this.backgroundPreloadRequestedKey = null;
      this.setBackgroundPointsLoading(false);
      return;
    }

    const preloadKey = palitraIds.join(',');
    this.backgroundPreloadRequestedKey = preloadKey;
    if (this.backgroundPreloadInFlight || this.backgroundPreloadKey === preloadKey) {
      return;
    }

    this.backgroundPreloadKey = preloadKey;
    void this.preloadAllPoints(palitraIds, preloadKey).catch((error) => {
      console.error('[PalitraManager] Background points preload failed:', error);
    });
  }

  private async preloadAllPoints(palitraIds: number[], preloadKey: string): Promise<void> {
    this.backgroundPreloadInFlight = true;
    this.setBackgroundPointsLoading(true);

    try {
      const data = await this.cacheManager.fetchPointsForBounds(palitraIds, WORLD_BOUNDS);
      this.cacheManager.storePointsByGrid(data, BACKGROUND_PRELOAD_ZOOM);
      this.onPointsUpdated();
    } finally {
      this.backgroundPreloadInFlight = false;
      this.setBackgroundPointsLoading(false);
      this.onPointsUpdated();
      if (this.backgroundPreloadRequestedKey !== preloadKey) {
        this.scheduleBackgroundPointsPreload();
      }
    }
  }

  private setBackgroundPointsLoading(isLoading: boolean): void {
    this.callbacks.onBackgroundPointsLoadingChanged?.(isLoading);
  }

  private async requestPoints(): Promise<void> {
    if (!this.stateAccessor.getEnabled()) {
      return;
    }
    const palitras = this.stateAccessor.getPalitras();
    if (palitras.length === 0) {
      return;
    }
    if (!this.mapAccessor.shouldRenderPointsAtCurrentZoom()) {
      return;
    }

    const currentZoom = this.map.getZoom();
    const bounds = this.mapAccessor.getBufferedBounds();
    const palitraIds = filterPalitraApiIdsByBounds(
      palitras,
      bounds,
      (palitra) => this.apiAccessor.apiPalitraId(palitra),
    );
    if (palitraIds.length === 0) {
      return;
    }

    const requestPalitraIds = this.cacheManager.filterByCache(palitraIds, bounds, currentZoom);
    if (requestPalitraIds.length === 0) {
      return;
    }

    const tileKey = this.cacheManager.buildTileKey(bounds, currentZoom);
    const filteredIds = requestPalitraIds.filter((id) => !this.cacheManager.hasPendingRequest(id, tileKey));
    if (filteredIds.length === 0) {
      return;
    }

    this.cacheManager.markPending(filteredIds, tileKey);
    this.cacheManager.markRequested(filteredIds, tileKey);
    try {
      await this.cacheManager.fetchPoints(filteredIds, bounds, tileKey, () => {
        this.onPointsUpdated();
      });
    } finally {
      this.cacheManager.clearPending(filteredIds, tileKey);
      this.onViewportRequestSettled();
    }
  }

  private getAllApiPalitraIds(): number[] {
    return Array.from(
      new Set(this.stateAccessor.getPalitras().map((entry) => this.apiAccessor.apiPalitraId(entry.palitra))),
    ).sort((left, right) => left - right);
  }
}
