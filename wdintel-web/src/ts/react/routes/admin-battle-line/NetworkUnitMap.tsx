import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useRef } from 'react';

import type { BattleLineNetworkUnitMap } from '../../../../Bindings';
import { L } from '../../../maps/leaflet-markercluster';
import { getTileLayers } from '../../../web-components/analysis-map/tile-layers';

function addPoints(
  layer: L.LayerGroup,
  points: BattleLineNetworkUnitMap['settlementPoints'],
  color: string,
  label: string,
) {
  for (const point of points) {
    L.circleMarker([point.lat, point.lon], {
      color: '#ffffff',
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
    getTileLayers().googleHybrid.addTo(map);
    const layer = L.layerGroup().addTo(map);
    addPoints(layer, item.settlementPoints, '#2196f3', 'Населений пункт');
    addPoints(layer, item.pelengPoints, '#f44336', 'Пеленг');
    fitMap(map, layer);
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      window.cancelAnimationFrame(frame);
      map.remove();
    };
  }, [item]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
        >
          <Typography variant="h6">{item.unitName || `#${item.unitId}`}</Typography>
          <Stack direction="row" spacing={1}>
            <Chip
              size="small"
              label={`Населені пункти: ${item.settlementPoints.length}`}
              sx={{ bgcolor: '#2196f3', color: '#fff' }}
            />
            <Chip
              size="small"
              label={`Пеленги: ${item.pelengPoints.length}`}
              sx={{ bgcolor: '#f44336', color: '#fff' }}
            />
          </Stack>
        </Stack>
        <Box
          ref={hostRef}
          aria-label={`Карта мереж підрозділу ${item.unitName || item.unitId}`}
          sx={{ height: 240, overflow: 'hidden', borderRadius: 1, bgcolor: 'grey.900' }}
        />
      </Stack>
    </Paper>
  );
}
