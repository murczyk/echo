import { useTheme } from '@mui/material/styles';
import { useEffect, useRef } from 'react';

import type { BattleLineNetworkUnitMap } from '../../../../Bindings';
import { PowerChip } from '../../components/PowerChip';
import { L } from '../../../maps/leaflet-markercluster';
import { DEFAULT_BASE_LAYER_ID } from '../../../maps/base-layers';
import { getTileLayers } from '../../../web-components/analysis-map/tile-layers';

function addPoints(
  layer: L.LayerGroup,
  points: BattleLineNetworkUnitMap['settlementPoints'],
  color: string,
  borderColor: string,
  label: string,
) {
  for (const point of points) {
    L.circleMarker([point.lat, point.lon], {
      color: borderColor,
      fillColor: color,
      fillOpacity: 1,
      radius: 6,
      weight: 1.5,
    })
      .bindTooltip(label)
      .addTo(layer);
  }
}

function fitMap(map: L.Map, layer: L.LayerGroup) {
  const bounds = L.featureGroup(layer.getLayers()).getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 13, padding: [28, 28] });
  else map.setView([48.5, 35], 7);
}

export function NetworkUnitMap({ item }: { item: BattleLineNetworkUnitMap }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const theme = useTheme();
  const colors = theme.echo.color[theme.palette.mode];

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = L.map(host, {
      attributionControl: false,
      boxZoom: false,
      doubleClickZoom: false,
      dragging: false,
      keyboard: false,
      scrollWheelZoom: false,
      touchZoom: false,
      zoomControl: false,
    });
    getTileLayers()[DEFAULT_BASE_LAYER_ID].addTo(map);
    const layer = L.layerGroup().addTo(map);
    addPoints(layer, item.settlementPoints, colors.info, colors.surfaceRaised, 'Населений пункт');
    addPoints(layer, item.pelengPoints, colors.error, colors.surfaceRaised, 'Пеленг');
    fitMap(map, layer);
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      window.cancelAnimationFrame(frame);
      map.remove();
    };
  }, [colors.error, colors.info, colors.surfaceRaised, item]);

  const unitLabel = item.unitName || `#${item.unitId}`;
  const headingId = `network-unit-map-${item.unitId}`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-echo-lg border border-echo-border bg-echo-surface-raised p-echo-lg"
    >
      <div className="flex flex-col gap-echo-md">
        <header className="flex flex-col items-start justify-between gap-echo-sm echo-sm:flex-row echo-sm:items-center">
          <h2 id={headingId} className="m-0 text-echo-lg font-semibold text-echo-text">
            {unitLabel}
          </h2>
          <div className="flex flex-wrap gap-echo-sm">
            <PowerChip
              color="info"
              selected
              label={`Населені пункти: ${item.settlementPoints.length}`}
            />
            <PowerChip color="error" selected label={`Пеленги: ${item.pelengPoints.length}`} />
          </div>
        </header>
        <div
          ref={hostRef}
          role="img"
          aria-label={`Карта мереж підрозділу ${unitLabel}: населених пунктів ${item.settlementPoints.length}, пеленгів ${item.pelengPoints.length}`}
          className="h-60 overflow-hidden rounded-echo-md bg-neutral-900"
        />
      </div>
    </article>
  );
}
