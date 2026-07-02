import * as L from 'leaflet';

import { PalitraCacheManager } from './palitra-cache-manager';
import { Palitra, PalitraDetails, PalitraManagerOptions } from './palitra-types';
import { filterPalitraApiIdsByBounds } from './utils/palitra-map-geometry';

type StateAccessor = {
  getPalitras: () => PalitraDetails[];
  getEnabled: () => boolean;
};

type MapAccessor = {
  getBufferedBounds: () => L.LatLngBounds;
  shouldLoadViewportPointsAtCurrentZoom: () => boolean;
};

type ApiAccessor = {
  apiPalitraId: (palitra: Palitra) => number;
};

export class PalitraPointsLoader {
  private requestTimer: number | null = null;

  constructor(
    private map: L.Map,
    private options: PalitraManagerOptions,
    private cacheManager: PalitraCacheManager,
    private stateAccessor: StateAccessor,
    private mapAccessor: MapAccessor,
    private apiAccessor: ApiAccessor,
    private onPointsUpdated: () => void,
    private onViewportRequestSettled: () => void,
  ) {}

  onPalitrasChanged(): void {
    this.schedulePointsRequest();
  }

  schedulePointsRequest(): void {
    if (!this.shouldLoadViewportPointsAtCurrentZoom()) {
      this.clearRequestTimer();
      return;
    }

    this.clearRequestTimer();
    this.requestTimer = window.setTimeout(() => {
      this.requestTimer = null;
      void this.requestPoints();
    }, this.options.requestDelayMs);
  }

  destroy(): void {
    this.clearRequestTimer();
  }

  private clearRequestTimer(): void {
    if (this.requestTimer !== null) {
      window.clearTimeout(this.requestTimer);
      this.requestTimer = null;
    }
  }

  private async requestPoints(): Promise<void> {
    if (!this.stateAccessor.getEnabled()) {
      return;
    }
    const palitras = this.stateAccessor.getPalitras();
    if (palitras.length === 0) {
      return;
    }
    if (!this.shouldLoadViewportPointsAtCurrentZoom()) {
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
        if (!this.stateAccessor.getEnabled()) {
          return;
        }
        this.onPointsUpdated();
      });
    } finally {
      this.cacheManager.clearPending(filteredIds, tileKey);
      if (!this.stateAccessor.getEnabled()) {
        return;
      }
      this.onViewportRequestSettled();
    }
  }

  private shouldLoadViewportPointsAtCurrentZoom(): boolean {
    return this.mapAccessor.shouldLoadViewportPointsAtCurrentZoom();
  }
}
