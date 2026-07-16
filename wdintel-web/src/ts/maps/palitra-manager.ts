import * as L from 'leaflet';

import { PalitraCacheManager } from './palitra-cache-manager';
import { PalitrasControl, PalitrasLoadState } from './controls';
import { PalitraPointClusterRenderer } from './palitra-point-cluster-renderer';
import { PalitraPointsController } from './palitra-points-controller';
import {
  Palitra,
  PalitraDetails,
  PalitraManagerCallbacks,
  PalitraManagerOptions,
} from './palitra-types';
import { createPalitraGeometryLayer, hasRenderableGeometry } from './utils/palitra-map-geometry';

function normalizePalitraIds(ids: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();

  ids.forEach((value) => {
    if (!Number.isInteger(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });

  return result;
}

export class PalitraManager {
  private cacheManager: PalitraCacheManager;
  private layerGroup: L.LayerGroup;
  private pointClustersRenderer: PalitraPointClusterRenderer;
  private pointsController: PalitraPointsController;
  private control: PalitrasControl | null = null;

  private palitras: PalitraDetails[] = [];
  private visibleIds: number[] = [];
  private enabled = true;
  private loadState: PalitrasLoadState = 'idle';
  private interactionDisabled = false;

  constructor(
    private map: L.Map,
    options: PalitraManagerOptions,
    private callbacks: PalitraManagerCallbacks,
  ) {
    this.cacheManager = new PalitraCacheManager(options.cacheTtlMs, options.maxCachedTiles);
    this.layerGroup = L.layerGroup().addTo(map);
    this.pointClustersRenderer = new PalitraPointClusterRenderer(
      map,
      callbacks.onOverlayContextMenu,
    );
    this.pointsController = new PalitraPointsController(
      map,
      options,
      callbacks,
      this.cacheManager,
      this.pointClustersRenderer,
      {
        getPalitras: () => this.palitras,
        getEnabled: () => this.enabled,
      },
      {
        getBufferedBounds: () => this.getBufferedBounds(),
      },
      {
        apiPalitraId: (palitra) => this.apiPalitraId(palitra),
      },
    );
    this.setupEventListeners();
  }

  updatePalitras(palitras: PalitraDetails[]): void {
    this.palitras = palitras;
    this.control?.updatePalitras(palitras, this.visibleIds);
    this.updateControlVisibility();
    this.pointsController.onPalitrasChanged();
    this.updatePolygons();
  }

  updateVisibleIds(ids: number[]): void {
    this.visibleIds = ids;
    this.control?.updatePalitras(this.palitras, ids);
    this.updateControlVisibility();
    this.updatePolygons();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.updateControlVisibility();
    this.updatePolygons();
    this.pointsController.onEnabledChanged();
  }

  fitPalitras(ids: number[]): void {
    if (!this.enabled) {
      return;
    }

    const targetIds = normalizePalitraIds(ids);
    if (targetIds.length === 0) {
      return;
    }

    const visibleIdSet = new Set(this.visibleIds);
    const visibleTargetIds = targetIds.filter((id) => visibleIdSet.has(id));
    if (visibleTargetIds.length === 0) {
      return;
    }

    const geometryLayers = this.getRenderableGeometryLayers(visibleTargetIds);
    if (geometryLayers.length === 0) {
      return;
    }

    const group = L.featureGroup(geometryLayers);
    const bounds = group.getBounds();
    if (!bounds.isValid()) {
      return;
    }

    this.map.fitBounds(bounds, {
      padding: [50, 50],
      maxZoom: 10,
    });
  }

  setControl(control: PalitrasControl): void {
    this.control = control;
    this.control.setLoadState(this.loadState);
    this.control.setInteractionDisabled(this.interactionDisabled);
    this.updateControlVisibility();
    if (this.palitras.length > 0) {
      this.control.updatePalitras(this.palitras, this.visibleIds);
    }
  }

  setLoadState(loadState: PalitrasLoadState): void {
    this.loadState = loadState;
    this.control?.setLoadState(loadState);
    this.updateControlVisibility();
  }

  setInteractionDisabled(disabled: boolean): void {
    this.interactionDisabled = disabled;
    this.control?.setInteractionDisabled(disabled);
  }

  setSearchQuery(query: string): void {
    this.pointsController.setSearchQuery(query);
  }

  destroy(): void {
    this.pointsController.destroy();
    this.layerGroup.clearLayers();
    this.map.removeLayer(this.layerGroup);
    if (this.control) {
      this.map.removeControl(this.control);
    }
    this.cacheManager.clear();
  }

  private setupEventListeners(): void {
    this.map.on('zoomend', () => this.pointsController.onViewportChanged());
    this.map.on('moveend', () => this.pointsController.onViewportChanged());
  }

  private updatePolygons(): void {
    if (!this.enabled) {
      this.layerGroup.clearLayers();
      return;
    }

    this.layerGroup.clearLayers();
    const geometryLayers = this.getRenderableGeometryLayers(this.visibleIds);
    geometryLayers.forEach((layer) => {
      this.layerGroup.addLayer(layer);
    });

    this.pointsController.updatePoints();
  }

  private getRenderableGeometryLayers(ids: number[]): L.Layer[] {
    const idSet = new Set(ids);
    const geometryLayers: L.Layer[] = [];
    this.palitras.forEach((palitraDetails) => {
      if (!idSet.has(palitraDetails.palitra.id) || !hasRenderableGeometry(palitraDetails)) {
        return;
      }

      const layer = createPalitraGeometryLayer(palitraDetails);
      if (!layer) {
        console.log('❌ Palitra geometry creation failed');
        return;
      }
      layer.on('mousedown', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
        if (event.originalEvent?.button !== 2) {
          return;
        }
        event.originalEvent.preventDefault();
        event.originalEvent.stopPropagation();
        this.callbacks.onOverlayContextMenu?.(
          { lat: event.latlng.lat, lng: event.latlng.lng },
          { lat: event.latlng.lat, lng: event.latlng.lng },
        );
      });
      layer.on('contextmenu', (event: L.LeafletMouseEvent & { originalEvent?: MouseEvent }) => {
        event.originalEvent?.preventDefault();
        event.originalEvent?.stopPropagation();
      });
      geometryLayers.push(layer);
    });

    return geometryLayers;
  }

  private getBufferedBounds(): L.LatLngBounds {
    return this.map.getBounds().pad(0.1);
  }

  private apiPalitraId(palitra: Palitra): number {
    return palitra.api_palitra_id ?? palitra.id;
  }

  private updateControlVisibility(): void {
    if (!this.control) {
      return;
    }

    // Leaflet control keeps map link in private `_map` field.
    const isControlOnMap = (this.control as any)._map === this.map;
    const shouldShowControl = shouldShowPalitrasControl({
      enabled: this.enabled,
      loadState: this.loadState,
      palitrasCount: this.palitras.length,
    });

    if (!shouldShowControl) {
      if (isControlOnMap) {
        this.map.removeControl(this.control);
      }
      return;
    }

    if (!isControlOnMap) {
      this.map.addControl(this.control);
    }
  }
}

export function shouldShowPalitrasControl(params: {
  enabled: boolean;
  loadState: PalitrasLoadState;
  palitrasCount: number;
}): boolean {
  return params.enabled && (params.palitrasCount > 0 || params.loadState !== 'idle');
}
