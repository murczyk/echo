import { polygonHull } from 'd3';
import * as L from 'leaflet';

import type { NetworkSettlement } from '../../../../../Bindings';

const NETWORK_SETTLEMENT_COLOR = '#dc2626';

export function createNetworkSettlementLayer(settlements: NetworkSettlement[]): L.LayerGroup {
  const layer = L.layerGroup();
  const unique = new Map<string, NetworkSettlement>();
  for (const settlement of settlements) {
    if (
      !Number.isFinite(settlement.lat) ||
      !Number.isFinite(settlement.lng) ||
      Math.abs(settlement.lat) > 90 ||
      Math.abs(settlement.lng) > 180
    )
      continue;
    unique.set(`${settlement.lat},${settlement.lng}`, settlement);
  }
  const points = [...unique.values()];
  const coordinates = points.map(({ lng, lat }): [number, number] => [lng, lat]);
  const hull = polygonHull(coordinates);
  const style: L.PathOptions = {
    color: NETWORK_SETTLEMENT_COLOR,
    fillColor: NETWORK_SETTLEMENT_COLOR,
    fillOpacity: 0.15,
    weight: 2,
    renderer: L.svg(),
    className: 'network-settlement-polygon',
  };
  if (hull && hull.length >= 3) {
    L.polygon(
      hull.map(([lng, lat]): L.LatLngTuple => [lat, lng]),
      style,
    )
      .bindTooltip('Локації мережі')
      .addTo(layer);
  } else if (points.length > 1) {
    const sorted = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
    L.polyline(
      sorted.map(({ lat, lng }): L.LatLngTuple => [lat, lng]),
      style,
    ).addTo(layer);
  }
  for (const point of points) {
    const label = document.createElement('span');
    label.textContent = point.name;
    L.circleMarker([point.lat, point.lng], {
      ...style,
      className: 'network-settlement-point',
      radius: 5,
      fillOpacity: 0.9,
    })
      .bindTooltip(label)
      .addTo(layer);
  }
  return layer;
}
