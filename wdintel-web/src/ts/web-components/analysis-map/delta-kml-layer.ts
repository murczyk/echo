import { kml } from '@tmcw/togeojson';
import * as L from 'leaflet';

const DELTA_KML_URL = '/api/delta/kml/latest';
const EMPTY_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

export async function loadDeltaKmlLayer(): Promise<L.GeoJSON | null> {
  const response = await fetch(DELTA_KML_URL);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load Delta KML: HTTP ${response.status}`);
  }
  const kmlDocument = new DOMParser().parseFromString(await response.text(), 'text/xml');
  if (kmlDocument.querySelector('parsererror')) {
    throw new Error('Failed to parse Delta KML');
  }
  const geojson = kml(kmlDocument);
  return createDeltaKmlLayer(geojson);
}

function createDeltaKmlLayer(geojson: GeoJSON.GeoJsonObject): L.GeoJSON {
  return L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const icon = feature.properties?.icon;
      return L.marker(latlng, {
        icon: L.icon({
          iconUrl: typeof icon === 'string' && icon ? icon : EMPTY_ICON,
          iconSize: [17, 17],
          iconAnchor: [9, 9],
        }),
      });
    },
    style: (feature) => {
      const properties = feature?.properties ?? {};
      return {
        color: stringProperty(properties, 'stroke'),
        fillColor: stringProperty(properties, 'fill') ?? stringProperty(properties, 'stroke'),
        fillOpacity: numberProperty(properties, 'fill-opacity'),
        opacity: numberProperty(properties, 'stroke-opacity') ?? 0.3,
        weight: numberProperty(properties, 'stroke-width'),
      };
    },
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.name;
      if (typeof name === 'string' && name) {
        const label = document.createElement('b');
        label.textContent = name;
        layer.bindTooltip(label, {
          permanent: true,
          direction: 'center',
        });
      }
    },
  });
}

function stringProperty(properties: GeoJSON.GeoJsonProperties, name: string): string | undefined {
  const value = properties?.[name];
  return typeof value === 'string' && value ? value : undefined;
}

function numberProperty(properties: GeoJSON.GeoJsonProperties, name: string): number | undefined {
  const value = properties?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
