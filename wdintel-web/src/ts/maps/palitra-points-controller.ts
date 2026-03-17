import * as L from 'leaflet';

import { PalitraCacheManager } from './palitra-cache-manager';
import { PalitraPointClusterRenderer } from './palitra-point-cluster-renderer';
import { Palitra, PalitraDetails, PalitraManagerCallbacks, PalitraManagerOptions, PalitraPoint } from './palitra-types';
import { PalitraPointsLoader } from './palitra-points-loader';
import { PalitraSearchState } from './palitra-search-state';
import { splitEntriesByGeometry } from './utils/palitra-point-assignment';
import { boundsOfSearchResults } from './utils/palitra-map-geometry';
import { truncateToMaxRendered, cullSearchResultsToViewport } from './utils/palitra-render-utils';

/** When search returns more than this many points, only markers in the current viewport are drawn. */
const SEARCH_RESULTS_VIEWPORT_CULL_THRESHOLD = 1000;

/** Never render more than this many point markers (viewport-culled or not) to avoid lockup. */
const MAX_RENDERED_POINTS = 1000;

/** When computing fitBounds, sample at most this many points to avoid O(n) with huge result sets. */
const BOUNDS_SAMPLE_SIZE = 2000;

/** Debounce moveend before re-rendering viewport chunk (avoids work during pan). */
const RENDER_VIEWPORT_DEBOUNCE_MS = 100;
type SearchPointsResult = { palitra_id: number; points: PalitraPoint[] };

type StateAccessor = {
  getPalitras: () => PalitraDetails[];
  getEnabled: () => boolean;
};

type MapAccessor = {
  getBufferedBounds: () => L.LatLngBounds;
};

type ApiAccessor = {
  apiPalitraId: (palitra: Palitra) => number;
};

export class PalitraPointsController {
  private pointsLoader: PalitraPointsLoader;
  private searchState: PalitraSearchState;
  private renderViewportTimer: number | null = null;

  constructor(
    private map: L.Map,
    private options: PalitraManagerOptions,
    private callbacks: PalitraManagerCallbacks,
    private cacheManager: PalitraCacheManager,
    private pointClustersRenderer: PalitraPointClusterRenderer,
    private stateAccessor: StateAccessor,
    private mapAccessor: MapAccessor,
    private apiAccessor: ApiAccessor,
  ) {
    this.searchState = new PalitraSearchState();
    this.pointsLoader = new PalitraPointsLoader(
      map,
      options,
      callbacks,
      cacheManager,
      stateAccessor,
      {
        getBufferedBounds: () => this.mapAccessor.getBufferedBounds(),
        shouldRenderPointsAtCurrentZoom: () => this.shouldRenderPointsAtCurrentZoom(),
      },
      apiAccessor,
      () => this.updatePoints(),
      () => {
        void this.renderVisiblePointsFromCache();
      },
    );
  }

  onViewportChanged(): void {
    this.updatePoints();
    this.scheduleRenderPointsInViewport();
    this.pointClustersRenderer.updatePointLabelVisibility();
  }

  onPalitrasChanged(): void {
    this.pointsLoader.onPalitrasChanged();
    this.updatePoints();
  }

  onEnabledChanged(): void {
    if (!this.stateAccessor.getEnabled()) {
      this.pointClustersRenderer.clear();
      return;
    }

    if (this.searchState.hasActiveSearch()) {
      void this.renderPointsInViewport();
      return;
    }

    this.updatePoints();
  }

  setSearchQuery(query: string): void {
    void this.searchState.setSearchQuery({
      query,
      palitras: this.stateAccessor.getPalitras(),
      apiPalitraId: (palitra) => this.apiAccessor.apiPalitraId(palitra),
      cacheManager: this.cacheManager,
      callbacks: this.callbacks,
      onSearchResults: async (data) => {
        // Keep the full BE result in memory, then render only viewport chunk.
        this.searchState.setLastSearchResult(data);
        await this.showSearchResults(data);
      },
      onSearchCleared: () => this.updatePoints(),
    });
  }

  destroy(): void {
    this.pointsLoader.destroy();
    if (this.renderViewportTimer !== null) {
      window.clearTimeout(this.renderViewportTimer);
      this.renderViewportTimer = null;
    }
    this.pointClustersRenderer.clear();
  }

  updatePoints(): void {
    if (!this.searchState.hasActiveSearch()) {
      this.pointsLoader.schedulePointsRequest();
      void this.renderVisiblePointsFromCache();
    }
  }

  private buildPalitrasByApiId(): Map<number, Palitra[]> {
    const palitrasByApiId = new Map<number, Palitra[]>();
    this.stateAccessor.getPalitras().forEach((entry) => {
      const apiId = this.apiAccessor.apiPalitraId(entry.palitra);
      const current = palitrasByApiId.get(apiId) ?? [];
      current.push(entry.palitra);
      palitrasByApiId.set(apiId, current);
    });
    return palitrasByApiId;
  }

  private scheduleRenderPointsInViewport(): void {
    if (this.renderViewportTimer !== null) {
      window.clearTimeout(this.renderViewportTimer);
    }
    this.renderViewportTimer = window.setTimeout(() => {
      this.renderViewportTimer = null;
      void this.renderPointsInViewport();
    }, RENDER_VIEWPORT_DEBOUNCE_MS);
  }

  private async showSearchResults(data: SearchPointsResult[]): Promise<void> {
    const resultsCount = data.reduce((acc, item) => acc + item.points.length, 0);
    this.callbacks.onSearchResultsCountChanged(resultsCount);

    this.pointClustersRenderer.clear();

    if (!this.stateAccessor.getEnabled()) {
      return;
    }

    this.searchState.setLastSearchResult(data);

    if (resultsCount > MAX_RENDERED_POINTS) {
      this.callbacks.onSearchResultsTruncated?.(MAX_RENDERED_POINTS, resultsCount);
    }

    // Reframe to search results once; subsequent move/zoom uses viewport rendering only.
    // Search markers are intentionally allowed at any zoom level.
    const fullBounds = boundsOfSearchResults(data, BOUNDS_SAMPLE_SIZE);
    if (fullBounds) {
      this.map.fitBounds(fullBounds, {
        padding: [40, 40],
      });
    }

    await this.renderPointsInViewport();
  }

  private async renderPointsInViewport(): Promise<void> {
    const searchResult = this.searchState.getLastSearchResult();
    if (!this.searchState.hasActiveSearch() || !this.stateAccessor.getEnabled() || !searchResult) {
      return;
    }
    const currentGen = this.searchState.nextRenderGeneration();
    const data = searchResult;
    const resultsCount = data.reduce((acc, item) => acc + item.points.length, 0);

    // For huge search sets, render only viewport chunk; otherwise render full result.
    let entriesToRender =
      resultsCount > SEARCH_RESULTS_VIEWPORT_CULL_THRESHOLD
        ? cullSearchResultsToViewport(data, this.mapAccessor.getBufferedBounds())
        : data;

    const totalInView = entriesToRender.reduce((acc, item) => acc + item.points.length, 0);
    if (totalInView > MAX_RENDERED_POINTS) {
      entriesToRender = truncateToMaxRendered(entriesToRender, MAX_RENDERED_POINTS);
    }

    const splitEntries = splitEntriesByGeometry(
      entriesToRender.filter(({ points }) => points.length > 0),
      this.buildPalitrasByApiId(),
      // Intentionally do not pass visible palette IDs:
      // search points must stay independent from palette/color selection.
      // Visibility toggles affect contour polygons only.
    );

    const nextPointMarkers: (L.CircleMarker & { _palitraTooltipLabel?: string })[] = [];
    const clusters = await Promise.all(
      splitEntries.map(async ({ palitra, points }) => {
        const cluster = await this.pointClustersRenderer.createPointsCluster(palitra, points, nextPointMarkers);
        return { palitraId: palitra.id, cluster };
      }),
    );

    // Async guard: a newer render may have started while clusters were being built.
    if (!this.searchState.isCurrentRenderGeneration(currentGen)) {
      return;
    }
    if (!this.stateAccessor.getEnabled() || !this.searchState.hasActiveSearch() || !this.searchState.getLastSearchResult()) {
      return;
    }

    this.pointClustersRenderer.replace(clusters, nextPointMarkers);
    this.pointClustersRenderer.updatePointLabelVisibility();
  }

  private shouldRenderPointsAtCurrentZoom(): boolean {
    const currentZoom = this.map.getZoom();
    return currentZoom >= this.getPointsVisibleFromZoom();
  }

  private getPointsVisibleFromZoom(): number {
    const maxZoom = this.map.getMaxZoom();
    if (Number.isFinite(maxZoom)) {
      return Math.max(0, maxZoom - 1);
    }
    return this.options.minZoomForPoints;
  }

  private async renderVisiblePointsFromCache(): Promise<void> {
    if (!this.stateAccessor.getEnabled()) {
      this.pointClustersRenderer.clear();
      return;
    }

    if (!this.shouldRenderPointsAtCurrentZoom()) {
      this.pointClustersRenderer.clear();
      return;
    }

    const currentGen = this.searchState.nextRenderGeneration();
    const bounds = this.mapAccessor.getBufferedBounds();
    // Non-search mode: render from already cached tiles only.
    const pointsByApiId = new Map<number, PalitraPoint[]>();

    this.stateAccessor.getPalitras().forEach((palitraDetails) => {
      // Intentionally iterate all palitras:
      // point rendering is independent from selected contour visibility.
      const apiId = this.apiAccessor.apiPalitraId(palitraDetails.palitra);
      const points = this.cacheManager.getPointsForBounds(apiId, bounds);
      if (points.length > 0) {
        pointsByApiId.set(apiId, points);
      }
    });

    if (pointsByApiId.size === 0) {
      const palitraIds = this.stateAccessor
        .getPalitras()
        .map((palitraDetails) => this.apiAccessor.apiPalitraId(palitraDetails.palitra));
      const hasPendingCoverage = this.cacheManager.hasPendingCoverage(palitraIds, bounds, this.map.getZoom());
      if (hasPendingCoverage) {
        return;
      }
      this.pointClustersRenderer.replace([], []);
      return;
    }

    const splitEntries = splitEntriesByGeometry(
      Array.from(pointsByApiId.entries()).map(([palitra_id, points]) => ({ palitra_id, points })),
      this.buildPalitrasByApiId(),
    );
    const cappedSplitEntries = this.truncateSplitEntriesToMaxRendered(splitEntries, MAX_RENDERED_POINTS);

    const nextPointMarkers: (L.CircleMarker & { _palitraTooltipLabel?: string })[] = [];
    const clusters = await Promise.all(
      cappedSplitEntries.map(async ({ palitra, points }) => {
        const cluster = await this.pointClustersRenderer.createPointsCluster(palitra, points, nextPointMarkers);
        return { palitraId: palitra.id, cluster };
      }),
    );

    // Async guard: skip stale non-search render result.
    if (!this.searchState.isCurrentRenderGeneration(currentGen) || this.searchState.hasActiveSearch()) {
      return;
    }

    this.pointClustersRenderer.replace(clusters, nextPointMarkers);
    this.pointClustersRenderer.updatePointLabelVisibility();
  }

  private truncateSplitEntriesToMaxRendered(
    entries: Array<{ palitra: Palitra; points: PalitraPoint[] }>,
    maxPoints: number,
  ): Array<{ palitra: Palitra; points: PalitraPoint[] }> {
    let remaining = maxPoints;
    const result: Array<{ palitra: Palitra; points: PalitraPoint[] }> = [];

    for (const entry of entries) {
      if (remaining <= 0) {
        break;
      }
      const take = Math.min(entry.points.length, remaining);
      if (take <= 0) {
        continue;
      }
      result.push({ palitra: entry.palitra, points: entry.points.slice(0, take) });
      remaining -= take;
    }

    return result;
  }
}
