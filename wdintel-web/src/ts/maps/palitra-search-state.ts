import { PalitraCacheManager } from './palitra-cache-manager';
import { Palitra, PalitraDetails, PalitraManagerCallbacks, PalitraPoint } from './palitra-types';
import { labelMatchesTerm, parseSearchQuery, termToApiString } from './palitra-search';

type SearchPointsResult = { palitra_id: number; points: PalitraPoint[] };
type SetSearchQueryParams = {
  query: string;
  palitras: PalitraDetails[];
  apiPalitraId: (palitra: Palitra) => number;
  cacheManager: PalitraCacheManager;
  callbacks: PalitraManagerCallbacks;
  onSearchResults: (data: SearchPointsResult[]) => Promise<void>;
  onSearchCleared: () => void;
};

export class PalitraSearchState {
  private searchQuery = '';
  private lastSearchResult: { palitra_id: number; points: PalitraPoint[] }[] | null = null;
  private renderGeneration = 0;

  hasActiveSearch(): boolean {
    return this.searchQuery !== '';
  }

  getLastSearchResult(): { palitra_id: number; points: PalitraPoint[] }[] | null {
    return this.lastSearchResult;
  }

  nextRenderGeneration(): number {
    this.renderGeneration += 1;
    return this.renderGeneration;
  }

  isCurrentRenderGeneration(value: number): boolean {
    return value === this.renderGeneration;
  }

  matchesActiveSearch(query: string): boolean {
    return this.searchQuery === query;
  }

  async setSearchQuery(params: SetSearchQueryParams): Promise<void> {
    const { query, palitras, apiPalitraId, cacheManager, callbacks, onSearchResults, onSearchCleared } = params;
    const q = (query ?? '').trim();
    if (q === '') {
      this.searchQuery = '';
      this.lastSearchResult = null;
      this.nextRenderGeneration();
      callbacks.onSearchLoadingChanged(false);
      callbacks.onSearchResultsCountChanged(null);
      onSearchCleared();
      return;
    }

    this.searchQuery = q;
    const palitraIds = Array.from(new Set(palitras.map((entry) => apiPalitraId(entry.palitra))));
    if (palitraIds.length === 0) {
      callbacks.onSearchLoadingChanged(false);
      await onSearchResults([]);
      return;
    }

    callbacks.onSearchLoadingChanged(true);
    const searchTerms = parseSearchQuery(q);

    // Phase 1: show instant cached matches (if any).
    const fromCache = cacheManager.getCachedPointsForPalitras(palitraIds);
    const filteredFromCache = fromCache.map(({ palitra_id, points }) => ({
      palitra_id,
      points: points.filter(
        (point) => point.label && searchTerms.some((term) => labelMatchesTerm(point.label!.toLowerCase(), term)),
      ),
    }));
    await onSearchResults(filteredFromCache);

    const termsForApi = [...new Set(searchTerms.map(termToApiString))];
    // Phase 2: request backend search and merge with cached points.
    cacheManager
      .fetchSearchPoints(palitraIds, termsForApi)
      .then((backendData) => {
        if (!this.matchesActiveSearch(q)) return;
        const merged = this.mergeSearchResults(filteredFromCache, backendData);
        this.lastSearchResult = merged;
        return onSearchResults(merged);
      })
      .catch((error) => {
        console.error('[PalitraManager] Search failed:', error);
      })
      .finally(() => {
        if (!this.matchesActiveSearch(q)) return;
        callbacks.onSearchLoadingChanged(false);
      });
  }

  setLastSearchResult(data: SearchPointsResult[] | null): void {
    this.lastSearchResult = data;
  }

  private mergeSearchResults(
    cacheData: SearchPointsResult[],
    backendData: SearchPointsResult[],
  ): SearchPointsResult[] {
    const byPalitra = new Map<number, Map<string, PalitraPoint>>();
    const addPoints = (palitraId: number, points: PalitraPoint[]) => {
      let byKey = byPalitra.get(palitraId);
      if (!byKey) {
        byKey = new Map();
        byPalitra.set(palitraId, byKey);
      }
      points.forEach((point) => {
        byKey!.set(PalitraCacheManager.pointKey(point), point);
      });
    };

    cacheData.forEach(({ palitra_id, points }) => addPoints(palitra_id, points));
    backendData.forEach(({ palitra_id, points }) => addPoints(palitra_id, points));

    return Array.from(byPalitra.entries()).map(([palitra_id, byKey]) => ({
      palitra_id,
      points: Array.from(byKey.values()),
    }));
  }
}
