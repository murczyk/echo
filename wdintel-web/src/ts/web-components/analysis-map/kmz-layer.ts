import * as L from 'leaflet';

import { loadKmzData } from '../../maps/maps';
import { KMZLayer, kmzLayerFactory } from '../../maps/leaflet-kmz';

export async function loadKmzLayer(params: {
  map: L.Map | null;
  kmzEnabled: boolean;
  kmzLayer: KMZLayer | null;
  kmzLoading: Promise<void> | null;
  setKmzLayer: (kmzLayer: KMZLayer | null) => void;
  setKmzLoading: (kmzLoading: Promise<void> | null) => void;
}): Promise<void> {
  const { map, kmzEnabled, kmzLayer, kmzLoading, setKmzLayer, setKmzLoading } = params;
  if (!map || !kmzEnabled) {
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

      if (map && kmzEnabled) {
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
  kmzEnabled: boolean;
  kmzLayer: KMZLayer | null;
  loadKmzLayer: () => Promise<void>;
}): void {
  const { map, kmzEnabled, kmzLayer, loadKmzLayer } = params;
  if (!map) {
    return;
  }

  if (!kmzEnabled) {
    if (kmzLayer) {
      map.removeLayer(kmzLayer);
    }
    return;
  }

  void loadKmzLayer();
}
