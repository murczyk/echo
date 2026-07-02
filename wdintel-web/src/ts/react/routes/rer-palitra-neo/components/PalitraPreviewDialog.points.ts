import * as L from 'leaflet';
import type { MutableRefObject } from 'react';

import { PalitraCacheManager } from '../../../../maps/palitra-cache-manager';
import { PalitraPointClusterRenderer } from '../../../../maps/palitra-point-cluster-renderer';
import { PalitraPointsController } from '../../../../maps/palitra-points-controller';
import type { PalitraDetails, PalitraManagerCallbacks, PalitraManagerOptions } from '../../../../maps/palitra-types';
import { NOOP_CALLBACKS } from './PalitraPreviewDialog.types';

type OnViewportChangedRef = MutableRefObject<{ onViewportChanged: (() => void) | null }>;

type PreviewPointStackRefs = {
  listenersRef: OnViewportChangedRef;
  stateRef: MutableRefObject<PalitraDetails[]>;
  cacheManagerRef: MutableRefObject<PalitraCacheManager | null>;
  pointClustersRendererRef: MutableRefObject<PalitraPointClusterRenderer | null>;
  pointsControllerRef: MutableRefObject<PalitraPointsController | null>;
};

export function createPreviewPointStack(
  map: L.Map,
  palitras: PalitraDetails[],
  options: PalitraManagerOptions,
  callbacks: PalitraManagerCallbacks,
  refs: PreviewPointStackRefs,
): void {
  const cacheManager = new PalitraCacheManager(options.cacheTtlMs, options.maxCachedTiles);
  const pointClustersRenderer = new PalitraPointClusterRenderer(map);
  const pointsController = new PalitraPointsController(
    map,
    options,
    callbacks ?? NOOP_CALLBACKS,
    cacheManager,
    pointClustersRenderer,
    {
      getPalitras: () => refs.stateRef.current,
      getEnabled: () => true,
    },
    {
      getBufferedBounds: () => map.getBounds().pad(0.1),
    },
    {
      apiPalitraId: (palitra) => palitra.api_palitra_id ?? palitra.id,
    },
  );

  const onViewportChanged = () => {
    pointsController.onViewportChanged();
  };

  refs.stateRef.current = palitras;
  refs.listenersRef.current.onViewportChanged = onViewportChanged;
  map.on('zoomend', onViewportChanged);
  map.on('moveend', onViewportChanged);

  refs.cacheManagerRef.current = cacheManager;
  refs.pointClustersRendererRef.current = pointClustersRenderer;
  refs.pointsControllerRef.current = pointsController;

  pointsController.onPalitrasChanged();
  pointsController.onViewportChanged();
}

export function destroyPreviewPointStack(
  map: L.Map | null,
  refs: PreviewPointStackRefs,
): void {
  if (map && refs.listenersRef.current.onViewportChanged) {
    map.off('zoomend', refs.listenersRef.current.onViewportChanged);
    map.off('moveend', refs.listenersRef.current.onViewportChanged);
  }

  refs.listenersRef.current.onViewportChanged = null;
  refs.pointsControllerRef.current?.destroy();
  refs.pointsControllerRef.current = null;
  refs.pointClustersRendererRef.current?.clear();
  refs.pointClustersRendererRef.current = null;
  refs.cacheManagerRef.current?.clear();
  refs.cacheManagerRef.current = null;
  refs.stateRef.current = [];
}
