import * as L from 'leaflet';
import { PalitraPoint } from './palitra-types';

export class PalitraCacheManager {
  private cache: Map<string, number> = new Map();
  private tiles: Map<number, Map<string, PalitraPoint[]>> = new Map();
  private pendingRequests: Set<string> = new Set();

  constructor(
    private ttlMs: number,
    private maxTiles: number
  ) {}

  hasPendingRequest(palitraId: number, tileKey: string): boolean {
    return this.pendingRequests.has(`${palitraId}:${tileKey}`);
  }

  markPending(palitraIds: number[], tileKey: string): void {
    palitraIds.forEach(id => {
      this.pendingRequests.add(`${id}:${tileKey}`);
    });
  }

  clearPending(palitraIds: number[], tileKey: string): void {
    palitraIds.forEach(id => {
      this.pendingRequests.delete(`${id}:${tileKey}`);
    });
  }

  filterByCache(
    palitraIds: number[],
    bounds: L.LatLngBounds,
    zoom: number
  ): number[] {
    const now = Date.now();
    const tileKey = this.buildTileKey(bounds, zoom);
    let expiredCount = 0;
    let cachedCount = 0;
    
    const filtered = palitraIds.filter(palitraId => {
      const cacheKey = `${palitraId}:${tileKey}`;
      const cachedAt = this.cache.get(cacheKey);
      if (cachedAt === undefined) {
        return true;
      }
      if (now - cachedAt > this.ttlMs) {
        this.cache.delete(cacheKey);
        expiredCount++;
        return true;
      }
      cachedCount++;
      return false;
    });
    
    if (expiredCount > 0) {
      console.log(`[Palitra Cache] Expired ${expiredCount} tiles due to TTL`);
    }
    if (cachedCount > 0) {
      console.log(`[Palitra Cache] Using cached data for ${cachedCount} palitras in tile ${tileKey}`);
    }
    
    return filtered;
  }

  markRequested(palitraIds: number[], tileKey: string): void {
    const now = Date.now();
    palitraIds.forEach(palitraId => {
      this.cache.set(`${palitraId}:${tileKey}`, now);
    });
  }

  async fetchPoints(
    palitraIds: number[],
    bounds: L.LatLngBounds,
    tileKey: string,
    onUpdate: () => void
  ): Promise<void> {
    console.log(`[Palitra Cache] Fetching points for tile ${tileKey}, palitras: [${palitraIds.join(', ')}]`);
    try {
      const response = await fetch('/api/palitra/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palitra_ids: palitraIds,
          viewport_bounds: {
            min_lat: bounds.getSouth(),
            min_lng: bounds.getWest(),
            max_lat: bounds.getNorth(),
            max_lng: bounds.getEast()
          }
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      this.storePoints(data, tileKey);
      onUpdate();
    } catch (error) {
      console.error('[Palitra Cache] Failed to fetch palitra points:', error);
      // Remove from cache to allow retry
      palitraIds.forEach(id => {
        this.cache.delete(`${id}:${tileKey}`);
      });
    }
  }

  /** All cached points for given palitras (from all tiles), deduped, for local search */
  getCachedPointsForPalitras(palitraIds: number[]): { palitra_id: number; points: PalitraPoint[] }[] {
    const result: { palitra_id: number; points: PalitraPoint[] }[] = [];
    for (const palitraId of palitraIds) {
      const tiles = this.tiles.get(palitraId);
      if (!tiles) {
        result.push({ palitra_id: palitraId, points: [] });
        continue;
      }
      const seen = new Set<string>();
      const points: PalitraPoint[] = [];
      tiles.forEach((tilePoints) => {
        for (const p of tilePoints) {
          const key = PalitraCacheManager.pointKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          points.push(p);
        }
      });
      result.push({ palitra_id: palitraId, points });
    }
    return result;
  }

  /** Key for point deduplication (label + coords). */
  static pointKey(p: PalitraPoint): string {
    return `${p.label ?? ''}:${p.coords.lat},${p.coords.lng}`;
  }

  /** Fetch points by label search (exact match). Does not use tile cache. */
  async fetchSearchPoints(
    palitraIds: number[],
    pointLabels: string[]
  ): Promise<{ palitra_id: number; points: PalitraPoint[] }[]> {
    if (palitraIds.length === 0 || pointLabels.length === 0) {
      return [];
    }
    const response = await fetch('/api/palitra/points/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        palitra_ids: palitraIds,
        point_labels: pointLabels
      })
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  /** Store points in the cache 
   * @param data - The data to store
   * @param tileKey - The tile key
   * Seen is a set of keys for deduplication bc same point can be in multiple tiles
  */
  storePoints(data: { palitra_id: number; points: PalitraPoint[] }[], tileKey: string): void {
    let totalNewPoints = 0;
    data.forEach(item => {
      if (item && typeof item.palitra_id === 'number') {
        let tiles = this.tiles.get(item.palitra_id);
        if (!tiles) {
          tiles = new Map();
          this.tiles.set(item.palitra_id, tiles);
        }
        const raw = item.points || [];
        const seen = new Set<string>();
        const points: PalitraPoint[] = [];
        for (const p of raw) {
          const key = PalitraCacheManager.pointKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          points.push(p);
        }
        tiles.set(tileKey, points);
        totalNewPoints += points.length;
      }
    });

    console.log(`[Palitra Cache] Stored ${totalNewPoints} points for tile ${tileKey}`);
    this.logStats();
    
    // Evict old entries if needed
    this.evict();
  }

  evict(): void {
    const entries = Array.from(this.cache.entries());
    if (entries.length <= this.maxTiles) {
      return;
    }
    
    const beforeEviction = entries.length;
    const beforePoints = this.getTotalPoints();
    
    // Sort by timestamp, keep newest
    entries.sort((a, b) => b[1] - a[1]);
    const toKeep = entries.slice(0, this.maxTiles);
    this.cache.clear();
    toKeep.forEach(([key, timestamp]) => {
      this.cache.set(key, timestamp);
    });
    
    // Clean corresponding tiles
    this.cleanOrphaned();
    
    const afterPoints = this.getTotalPoints();
    console.log(`[Palitra Cache] EVICTION: Removed ${beforeEviction - this.maxTiles} tiles, freed ${beforePoints - afterPoints} points`);
    this.logStats();
  }

  cleanOrphaned(): void {
    this.tiles.forEach((tiles, palitraId) => {
      tiles.forEach((_, tileKey) => {
        const cacheKey = `${palitraId}:${tileKey}`;
        if (!this.cache.has(cacheKey)) {
          tiles.delete(tileKey);
        }
      });
    });
  }

  getTotalPoints(): number {
    let total = 0;
    this.tiles.forEach((tiles) => {
      tiles.forEach((points) => {
        total += points.length;
      });
    });
    return total;
  }

  logStats(): void {
    const totalTiles = this.cache.size;
    const totalPoints = this.getTotalPoints();
    const palitrasWithData = this.tiles.size;
    
    // Estimate memory usage (rough calculation)
    const estimatedMemoryMB = (totalPoints * 70) / (1024 * 1024); // ~70 bytes per point
    const avgPointsPerTile = totalTiles > 0 ? Math.round(totalPoints / totalTiles) : 0;
    
    console.log(`[Palitra Cache Stats] Tiles: ${totalTiles}/${this.maxTiles}, Points: ${totalPoints}, ~${estimatedMemoryMB.toFixed(1)} MB, Avg: ${avgPointsPerTile} points/tile, Palitras: ${palitrasWithData}`);
    
    // Detailed breakdown per palitra
    const breakdown: string[] = [];
    this.tiles.forEach((tiles, palitraId) => {
      let pointsCount = 0;
      tiles.forEach((points) => {
        pointsCount += points.length;
      });
      breakdown.push(`  Palitra ${palitraId}: ${tiles.size} tiles, ${pointsCount} points`);
    });
    if (breakdown.length > 0) {
      console.log(breakdown.join('\n'));
    }
  }

  /**
   * Merge points from all tiles that intersect the current view and return
   * them for display on the map. This is the single place where points from
   * multiple tiles are combined; deduplication by (lat, lng) ensures the
   * same point from overlapping tiles appears only once.
   */
  getPointsForBounds(palitraId: number, bounds: L.LatLngBounds): PalitraPoint[] {
    const tiles = this.tiles.get(palitraId);
    if (!tiles) {
      return [];
    }
    const seen = new Set<string>();
    const points: PalitraPoint[] = [];
    tiles.forEach((tilePoints, tileKey) => {
      const tileBounds = this.parseTileKeyBounds(tileKey);
      if (!tileBounds) {
        return;
      }
      if (bounds.intersects(tileBounds)) {
        for (const p of tilePoints) {
          const key = PalitraCacheManager.pointKey(p);
          if (seen.has(key)) continue;
          seen.add(key);
          points.push(p);
        }
      }
    });
    return points;
  }

  buildTileKey(bounds: L.LatLngBounds, zoom: number): string {
    const precision = this.getPrecision(zoom);
    const zoomBucket = this.getZoomBucket(zoom);
    const minLat = this.roundCoord(bounds.getSouth(), precision);
    const minLng = this.roundCoord(bounds.getWest(), precision);
    const maxLat = this.roundCoord(bounds.getNorth(), precision);
    const maxLng = this.roundCoord(bounds.getEast(), precision);
    return `${zoomBucket}:${minLat},${minLng},${maxLat},${maxLng}`;
  }

  private getPrecision(zoom: number): number {
    if (zoom >= 17) {
      return 3;
    }
    if (zoom >= 15) {
      return 2;
    }
    return 1;
  }

  private getZoomBucket(zoom: number): number {
    if (zoom >= 17) {
      return 17;
    }
    if (zoom >= 15) {
      return 15;
    }
    return 13;
  }

  private roundCoord(value: number, precision: number): string {
    const factor = Math.pow(10, precision);
    const rounded = Math.round(value * factor) / factor;
    return rounded.toFixed(precision);
  }

  private parseTileKeyBounds(tileKey: string): L.LatLngBounds | null {
    const parts = tileKey.split(':');
    if (parts.length !== 2) {
      return null;
    }
    const coords = parts[1].split(',').map(value => Number(value));
    if (coords.length !== 4) {
      return null;
    }
    const [minLat, minLng, maxLat, maxLng] = coords;
    if ([minLat, minLng, maxLat, maxLng].some(value => Number.isNaN(value))) {
      return null;
    }
    return L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
  }

  clear(): void {
    this.cache.clear();
    this.tiles.clear();
    this.pendingRequests.clear();
  }
}
