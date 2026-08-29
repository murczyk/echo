import { Box, Button, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type {
  BattleLineCoordinate,
  BattleLineFeature,
  BattleLineState,
} from '../../../../Bindings';
import { L } from '../../../maps/leaflet-markercluster';
import { DEFAULT_BASE_LAYER_ID } from '../../../maps/base-layers';
import { getTileLayers } from '../../../web-components/analysis-map/tile-layers';

type SelectedSettlement = BattleLineCoordinate & { id: number; label: string };

export function aorColor(aorId: number): string {
  return `hsl(${Math.abs(aorId * 137.508) % 360} 70% 42%)`;
}

export function reconcileVisibleAorIds(
  current: ReadonlySet<number>,
  known: ReadonlySet<number>,
  nextIds: number[],
): Set<number> {
  return new Set(nextIds.filter((id) => !known.has(id) || current.has(id)));
}

function addFeature(
  layer: L.LayerGroup,
  feature: BattleLineFeature,
  color: string,
  weight: number,
) {
  const positions = feature.coordinates.map(
    (coordinate) => [coordinate.lat, coordinate.lon] as L.LatLngTuple,
  );
  if (feature.kind === 'Point') {
    const position = positions[0];
    if (position) {
      L.circleMarker(position, { color, fillColor: color, fillOpacity: 0.9, radius: 5 }).addTo(
        layer,
      );
    }
    return;
  }
  if (positions.length >= 2) L.polyline(positions, { color, weight }).addTo(layer);
}

type Props = {
  state: BattleLineState;
  selectedSettlements?: SelectedSettlement[];
};

export function BattleLineMap({ state, selectedSettlements = [] }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const geometryLayerRef = useRef<L.LayerGroup | null>(null);
  const knownAorIdsRef = useRef<Set<number>>(new Set());
  const [visibleAorIds, setVisibleAorIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const ids = state.aorGeometries.map((geometry) => geometry.aorId);
    setVisibleAorIds((current) => {
      return reconcileVisibleAorIds(current, knownAorIdsRef.current, ids);
    });
    knownAorIdsRef.current = new Set(ids);
  }, [state.aorGeometries]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;
    const map = L.map(host, { attributionControl: false }).setView([48.5, 35], 7);
    getTileLayers()[DEFAULT_BASE_LAYER_ID].addTo(map);
    mapRef.current = map;
    geometryLayerRef.current = L.layerGroup().addTo(map);
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      window.cancelAnimationFrame(frame);
      map.remove();
      mapRef.current = null;
      geometryLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = geometryLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const feature of state.activeFeatures) addFeature(layer, feature, '#455a64', 2);
    for (const geometry of state.aorGeometries) {
      if (!visibleAorIds.has(geometry.aorId)) continue;
      const color = aorColor(geometry.aorId);
      for (const feature of geometry.features) addFeature(layer, feature, color, 5);
    }
    for (const settlement of selectedSettlements) {
      L.circleMarker([settlement.lat, settlement.lon], {
        color: '#0d47a1',
        fillColor: '#2196f3',
        fillOpacity: 1,
        radius: 8,
        weight: 2,
      })
        .bindTooltip(settlement.label)
        .addTo(layer);
    }
    const bounds = L.featureGroup(layer.getLayers()).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.08), { maxZoom: 12 });
    window.requestAnimationFrame(() => map.invalidateSize());
  }, [selectedSettlements, state.activeFeatures, state.aorGeometries, visibleAorIds]);

  const allIds = state.aorGeometries.map((geometry) => geometry.aorId);
  return (
    <Stack spacing={1} sx={{ minHeight: 0 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
        <Button size="small" onClick={() => setVisibleAorIds(new Set(allIds))}>
          Показати всі
        </Button>
        <Button size="small" onClick={() => setVisibleAorIds(new Set())}>
          Сховати всі
        </Button>
        {state.aorGeometries.map((geometry) => (
          <FormControlLabel
            key={geometry.aorId}
            control={
              <Checkbox
                size="small"
                checked={visibleAorIds.has(geometry.aorId)}
                onChange={() =>
                  setVisibleAorIds((current) => {
                    const next = new Set(current);
                    if (next.has(geometry.aorId)) next.delete(geometry.aorId);
                    else next.add(geometry.aorId);
                    return next;
                  })
                }
                sx={{
                  color: aorColor(geometry.aorId),
                  '&.Mui-checked': { color: aorColor(geometry.aorId) },
                }}
              />
            }
            label={<Typography variant="body2">{geometry.aorName}</Typography>}
          />
        ))}
      </Stack>
      <Box
        ref={hostRef}
        sx={{ minHeight: 430, height: '55vh', borderRadius: 1, overflow: 'hidden' }}
      />
    </Stack>
  );
}
