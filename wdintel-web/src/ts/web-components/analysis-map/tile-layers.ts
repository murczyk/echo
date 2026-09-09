import * as L from 'leaflet';
import { BaseLayerId } from '../../maps/base-layers';

export type TileLayers = Record<BaseLayerId, L.Layer>;

export function getTileLayers(options?: L.TileLayerOptions): TileLayers {
  const deltaMaxZoom = (options?.maxZoom ?? 17) + (L.Browser.retina ? 1 : 0);

  const openStreetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    ...options,
  });

  const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
    maxZoom: 17,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    ...options,
  });

  const deltaImagery = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      ...options,
      maxZoom: deltaMaxZoom,
      detectRetina: true,
      zIndex: 0,
    },
  );
  const deltaReference = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    {
      ...options,
      maxZoom: deltaMaxZoom,
      detectRetina: true,
      zIndex: 1,
    },
  );
  const delta = L.layerGroup([deltaImagery, deltaReference]);

  return {
    [BaseLayerId.Delta]: delta,
    [BaseLayerId.Google]: googleHybrid,
    [BaseLayerId.OpenStreetMap]: openStreetMap,
  };
}
