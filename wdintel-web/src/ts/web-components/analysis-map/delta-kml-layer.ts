import { kml } from '@tmcw/togeojson';
import * as L from 'leaflet';

import { HttpRequestError, getJson } from '../../react/services/api/client';

const DELTA_KML_URL = '/api/delta/kml/latest';
const EMPTY_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const DELTA_KML_DETAILS_MIN_ZOOM = 11;
const DELTA_KML_DETAILS_SMALL_MAP_MIN_ZOOM = 10;
const DELTA_KML_SMALL_MAP_MAX_WIDTH = 250;

export async function loadDeltaKmlLayer(): Promise<L.GeoJSON | null> {
  let kmlText: string;
  try {
    kmlText = await getJson<string>(DELTA_KML_URL);
  } catch (error) {
    if (error instanceof HttpRequestError && error.status === 404) return null;
    throw error;
  }
  const kmlDocument = new DOMParser().parseFromString(kmlText, 'text/xml');
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
        opacity: 0,
        icon: L.icon({
          iconUrl: typeof icon === 'string' && icon ? icon : EMPTY_ICON,
          iconSize: [17, 17],
          iconAnchor: [9, 9],
        }),
      });
    },
    style: deltaKmlStyle,
    onEachFeature: (feature, layer) => {
      const name = feature.properties?.name;
      if (typeof name === 'string' && name) {
        const label = document.createElement('b');
        label.textContent = name;
        layer.bindTooltip(label, {
          permanent: true,
          direction: 'center',
          opacity: 0,
        });
      }
    },
  });
}

export function updateDeltaKmlLayerZoom(layer: L.GeoJSON, map: L.Map): void {
  const minZoom =
    map.getSize().x > DELTA_KML_SMALL_MAP_MAX_WIDTH
      ? DELTA_KML_DETAILS_MIN_ZOOM
      : DELTA_KML_DETAILS_SMALL_MAP_MIN_ZOOM;
  const showDetails = map.getZoom() >= minZoom;
  layer.eachLayer((featureLayer) => {
    updateDeltaKmlFeatureDetails(featureLayer, showDetails);
  });
}

function updateDeltaKmlFeatureDetails(layer: L.Layer, showDetails: boolean): void {
  if (layer instanceof L.Marker) {
    layer.setOpacity(showDetails ? 1 : 0);
  }
  layer.getTooltip()?.setOpacity(showDetails ? 0.9 : 0);
  if (layer instanceof L.LayerGroup) {
    layer.eachLayer((childLayer) => updateDeltaKmlFeatureDetails(childLayer, showDetails));
  }
}

function deltaKmlStyle(feature?: GeoJSON.Feature): L.PathOptions {
  const properties = feature?.properties ?? {};
  const style: L.PathOptions = {
    opacity: numberProperty(properties, 'stroke-opacity') ?? 0.3,
  };
  const color = stringProperty(properties, 'stroke');
  const fillColor = stringProperty(properties, 'fill') ?? color;
  const fillOpacity = numberProperty(properties, 'fill-opacity');
  const weight = numberProperty(properties, 'stroke-width');
  if (color !== undefined) style.color = color;
  if (fillColor !== undefined) style.fillColor = fillColor;
  if (fillOpacity !== undefined) style.fillOpacity = fillOpacity;
  if (weight !== undefined) style.weight = weight;
  return style;
}

function stringProperty(properties: GeoJSON.GeoJsonProperties, name: string): string | undefined {
  const value = properties?.[name];
  return typeof value === 'string' && value ? value : undefined;
}

function numberProperty(properties: GeoJSON.GeoJsonProperties, name: string): number | undefined {
  const value = properties?.[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
