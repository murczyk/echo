import * as L from 'leaflet';

import { loadKmzData } from '../../maps/maps';
import { KMZLayer, kmzLayerFactory } from '../../maps/leaflet-kmz';

export async function loadKmzLayer(params: {
  map: L.Map | null;
  isKmzEnabled: () => boolean;
  kmzLayer: KMZLayer | null;
  kmzLoading: Promise<void> | null;
  setKmzLayer: (kmzLayer: KMZLayer | null) => void;
  setKmzLoading: (kmzLoading: Promise<void> | null) => void;
}): Promise<void> {
  const { map, isKmzEnabled, kmzLayer, kmzLoading, setKmzLayer, setKmzLoading } = params;
  if (!map || !isKmzEnabled()) {
    return;
  }

  if (kmzLayer) {
    kmzLayer.addTo(map);
    return;
  }

  if (kmzLoading) {
    await kmzLoading;
    return;
  }

  const nextKmzLoading = (async () => {
    try {
      const kmzData = await loadKmzData();
      if (!kmzData) {
        return;
      }

      const nextKmzLayer = kmzLayerFactory(null, {
        bindTooltip: true,
        bindPopup: false,
        permanentTooltip: true,
      });
      setKmzLayer(nextKmzLayer);

      if (map && isKmzEnabled()) {
        nextKmzLayer.addTo(map);
        nextKmzLayer.parse(kmzData, {});
      }
    } catch (error) {
      console.error('Failed to load KMZ data', error);
    } finally {
      setKmzLoading(null);
    }
  })();

  setKmzLoading(nextKmzLoading);
  await nextKmzLoading;
}

export function applyKmzVisibility(params: {
  map: L.Map | null;
  isKmzEnabled: () => boolean;
  kmzLayer: KMZLayer | null;
  loadKmzLayer: () => Promise<void>;
}): void {
  const { map, isKmzEnabled, kmzLayer, loadKmzLayer } = params;
  if (!map) {
    return;
  }

  if (!isKmzEnabled()) {
    if (kmzLayer) {
      map.removeLayer(kmzLayer);
    }
    return;
  }

  void loadKmzLayer();
}
