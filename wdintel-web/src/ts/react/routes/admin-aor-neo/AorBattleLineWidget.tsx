import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AorBattleLineBoundariesUpdate,
  BattleLineCoordinate,
  BattleLineFeature,
  BattleLineState,
  AreaOfResponsibility,
} from '../../../../Bindings';
import { L } from '../../../maps/leaflet-markercluster';
import { getTileLayers } from '../../../web-components/analysis-map/tile-layers';
import { PowerAlert } from '../../components/PowerAlert';
import { updateAorBattleLineBoundaries } from '../../services/api/aor';
import { aorColor } from '../admin-battle-line/BattleLineMap';

type BoundaryPair = {
  left: BattleLineCoordinate;
  right: BattleLineCoordinate;
};

type BoundaryDrafts = Map<number, BoundaryPair>;

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
  } else if (positions.length >= 2) {
    L.polyline(positions, { color, weight }).addTo(layer);
  }
}

function fitMapToLayer(map: L.Map, layer: L.LayerGroup) {
  const bounds = L.featureGroup(layer.getLayers()).getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.08), { maxZoom: 12 });
  window.requestAnimationFrame(() => map.invalidateSize());
}

function createMap(host: HTMLDivElement): L.Map {
  const map = L.map(host, { attributionControl: false }).setView([48.5, 35], 7);
  getTileLayers().googleHybrid.addTo(map);
  return map;
}

function boundaryPair(aor: AreaOfResponsibility): BoundaryPair | null {
  if (!aor.leftCoordinates || !aor.rightCoordinates) return null;
  return {
    left: { lat: aor.leftCoordinates.latitude, lon: aor.leftCoordinates.longitude },
    right: { lat: aor.rightCoordinates.latitude, lon: aor.rightCoordinates.longitude },
  };
}

export function initialBoundaryDrafts(aors: AreaOfResponsibility[]): BoundaryDrafts {
  return new Map(
    aors.flatMap((aor) => {
      const pair = boundaryPair(aor);
      return pair ? ([[aor.id, pair]] as const) : [];
    }),
  );
}

function coordinatesEqual(left: BattleLineCoordinate, right: BattleLineCoordinate): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

export function buildBoundaryUpdates(
  aors: AreaOfResponsibility[],
  drafts: BoundaryDrafts,
): AorBattleLineBoundariesUpdate[] {
  return aors.flatMap((aor) => {
    const draft = drafts.get(aor.id);
    if (!draft) return [];
    const saved = boundaryPair(aor);
    if (
      saved &&
      coordinatesEqual(saved.left, draft.left) &&
      coordinatesEqual(saved.right, draft.right)
    ) {
      return [];
    }
    return [
      {
        id: aor.id,
        leftCoordinates: {
          latitude: draft.left.lat,
          longitude: draft.left.lon,
          settlement: null,
        },
        rightCoordinates: {
          latitude: draft.right.lat,
          longitude: draft.right.lon,
          settlement: null,
        },
      },
    ];
  });
}

function boundaryPairAtMapCenter(map: L.Map): BoundaryPair {
  const center = map.getCenter();
  const bounds = map.getBounds();
  const offset = Math.max(Math.abs(bounds.getEast() - bounds.getWest()) * 0.015, 0.001);
  return {
    left: { lat: center.lat, lon: center.lng - offset },
    right: { lat: center.lat, lon: center.lng },
  };
}

type LegendProps = {
  aors: AreaOfResponsibility[];
  boundaryIds: ReadonlySet<number>;
  visibleAorIds?: ReadonlySet<number>;
  onAdd: (aorId: number) => void;
  onToggle?: (aorId: number) => void;
};

function AorLegend(props: LegendProps) {
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
      {props.aors.map((aor) => (
        <Stack key={aor.id} direction="row" spacing={0} alignItems="center">
          {props.visibleAorIds && props.onToggle ? (
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={props.visibleAorIds.has(aor.id)}
                  onChange={() => props.onToggle?.(aor.id)}
                  sx={{
                    color: aorColor(aor.id),
                    '&.Mui-checked': { color: aorColor(aor.id) },
                  }}
                />
              }
              label={<Typography variant="body2">{aor.name}</Typography>}
              sx={{ mr: 0 }}
            />
          ) : (
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ px: 1 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: aorColor(aor.id) }} />
              <Typography variant="body2">{aor.name}</Typography>
            </Stack>
          )}
          {!props.boundaryIds.has(aor.id) ? (
            <Tooltip title="Додати межі AOR">
              <IconButton
                size="small"
                aria-label={`Додати межі ${aor.name}`}
                onClick={() => props.onAdd(aor.id)}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

type SegmentMapProps = {
  aors: AreaOfResponsibility[];
  state: BattleLineState;
  visibleAorIds: ReadonlySet<number>;
};

function addReadOnlyBoundaryMarkers(layer: L.LayerGroup, aors: AreaOfResponsibility[]) {
  for (const aor of aors) {
    const pair = boundaryPair(aor);
    if (!pair) continue;
    for (const side of ['left', 'right'] as const) {
      const coordinate = pair[side];
      L.marker([coordinate.lat, coordinate.lon], {
        icon: boundaryIcon(aorColor(aor.id), side === 'left' ? 'L' : 'R'),
      }).addTo(layer);
    }
  }
}

function SegmentMap({ aors, state, visibleAorIds }: SegmentMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = createMap(host);
    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (state.activeVersion) {
      for (const feature of state.activeFeatures) addFeature(layer, feature, '#455a64', 2);
      for (const geometry of state.aorGeometries) {
        if (!visibleAorIds.has(geometry.aorId)) continue;
        for (const feature of geometry.features) {
          addFeature(layer, feature, aorColor(geometry.aorId), 5);
        }
      }
    } else {
      addReadOnlyBoundaryMarkers(
        layer,
        aors.filter((aor) => visibleAorIds.has(aor.id)),
      );
    }
    fitMapToLayer(map, layer);
  }, [aors, state.activeFeatures, state.activeVersion, state.aorGeometries, visibleAorIds]);

  return <Box ref={hostRef} sx={{ height: 300, borderRadius: 1, overflow: 'hidden' }} />;
}

function boundaryIcon(color: string, label: 'L' | 'R'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:2px solid white;border-radius:50%;background:${color};color:white;font:bold 13px sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.65)">${label}</span>`,
    iconAnchor: [13, 13],
    iconSize: [26, 26],
  });
}

type BoundaryEditorMapProps = {
  drafts: BoundaryDrafts;
  state: BattleLineState;
  onMapReady: (map: L.Map) => void;
  onMove: (aorId: number, side: 'left' | 'right', coordinate: BattleLineCoordinate) => void;
};

function BoundaryEditorMap(props: BoundaryEditorMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const lineLayerRef = useRef<L.LayerGroup | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedBoundaryMarkersRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = createMap(host);
    mapRef.current = map;
    lineLayerRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    props.onMapReady(map);
    return () => {
      map.remove();
      mapRef.current = null;
      lineLayerRef.current = null;
      markerLayerRef.current = null;
    };
  }, [props.onMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = lineLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const feature of props.state.activeFeatures) addFeature(layer, feature, '#455a64', 4);
    fitMapToLayer(map, layer);
  }, [props.state.activeFeatures]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const [aorId, pair] of props.drafts) {
      const color = aorColor(aorId);
      for (const side of ['left', 'right'] as const) {
        const coordinate = pair[side];
        const marker = L.marker([coordinate.lat, coordinate.lon], {
          draggable: true,
          icon: boundaryIcon(color, side === 'left' ? 'L' : 'R'),
        }).addTo(layer);
        marker.on('dragend', () => {
          const position = marker.getLatLng();
          props.onMove(aorId, side, { lat: position.lat, lon: position.lng });
        });
      }
    }
    if (
      !props.state.activeVersion &&
      !fittedBoundaryMarkersRef.current &&
      layer.getLayers().length > 0
    ) {
      fitMapToLayer(map, layer);
      fittedBoundaryMarkersRef.current = true;
    }
  }, [props.drafts, props.onMove, props.state.activeVersion]);

  return <Box ref={hostRef} sx={{ width: '100%', height: '100%', minHeight: 0 }} />;
}

type Props = {
  aors: AreaOfResponsibility[];
  state: BattleLineState;
  reload: () => Promise<void>;
};

type PreviewProps = {
  aors: AreaOfResponsibility[];
  boundaryIds: ReadonlySet<number>;
  state: BattleLineState;
  visibleAorIds: ReadonlySet<number>;
  onAdd: (aorId: number) => void;
  onEdit: () => void;
  onHideAll: () => void;
  onShowAll: () => void;
  onToggle: (aorId: number) => void;
};

function AorBattleLinePreview(props: PreviewProps) {
  return (
    <Paper variant="outlined" sx={{ p: 2, flexShrink: 0 }}>
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6">ЛБЗ за смугами відповідальності</Typography>
          <Button startIcon={<EditIcon />} onClick={props.onEdit}>
            Редагувати межі
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
          <Button size="small" onClick={props.onShowAll}>
            Показати всі
          </Button>
          <Button size="small" onClick={props.onHideAll}>
            Сховати всі
          </Button>
          <AorLegend
            aors={props.aors}
            boundaryIds={props.boundaryIds}
            visibleAorIds={props.visibleAorIds}
            onAdd={props.onAdd}
            onToggle={props.onToggle}
          />
        </Stack>
        <SegmentMap aors={props.aors} state={props.state} visibleAorIds={props.visibleAorIds} />
      </Stack>
    </Paper>
  );
}

type EditorDialogProps = {
  aors: AreaOfResponsibility[];
  drafts: BoundaryDrafts;
  error: string | null;
  open: boolean;
  saving: boolean;
  state: BattleLineState;
  onAdd: (aorId: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onMapReady: (map: L.Map) => void;
  onMove: (aorId: number, side: 'left' | 'right', coordinate: BattleLineCoordinate) => void;
};

function BoundaryEditorDialog(props: EditorDialogProps) {
  return (
    <Dialog fullScreen open={props.open} onClose={props.onCancel}>
      <DialogTitle>Межі AOR на ЛБЗ</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
        <AorLegend
          aors={props.aors}
          boundaryIds={new Set(props.drafts.keys())}
          onAdd={props.onAdd}
        />
        {props.error ? <PowerAlert severity="error">{props.error}</PowerAlert> : null}
        {props.saving ? (
          <Box>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {props.state.activeVersion
                ? 'Збереження меж і перерахунок сегментів ЛБЗ…'
                : 'Збереження меж…'}
            </Typography>
            <LinearProgress />
          </Box>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0, borderRadius: 1, overflow: 'hidden' }}>
          <BoundaryEditorMap
            drafts={props.drafts}
            state={props.state}
            onMapReady={props.onMapReady}
            onMove={props.onMove}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onCancel} disabled={props.saving}>
          Скасувати
        </Button>
        <Button variant="contained" onClick={props.onConfirm} disabled={props.saving}>
          Підтвердити
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AorBattleLineWidget({ aors, state, reload }: Props) {
  const initialVisibleIds = useMemo(() => new Set(aors.map((aor) => aor.id)), [aors]);
  const [visibleAorIds, setVisibleAorIds] = useState(initialVisibleIds);
  const [editorOpen, setEditorOpen] = useState(false);
  const [drafts, setDrafts] = useState<BoundaryDrafts>(() => initialBoundaryDrafts(aors));
  const [editorMap, setEditorMap] = useState<L.Map | null>(null);
  const [pendingAddAorId, setPendingAddAorId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setVisibleAorIds(initialVisibleIds), [initialVisibleIds]);

  const moveBoundary = useCallback(
    (aorId: number, side: 'left' | 'right', coordinate: BattleLineCoordinate) => {
      setDrafts((current) => {
        const pair = current.get(aorId);
        if (!pair) return current;
        return new Map(current).set(aorId, { ...pair, [side]: coordinate });
      });
    },
    [],
  );

  const openEditor = (addAorId?: number) => {
    setDrafts(initialBoundaryDrafts(aors));
    setPendingAddAorId(addAorId ?? null);
    setError(null);
    setEditorOpen(true);
  };

  useEffect(() => {
    if (!editorMap || pendingAddAorId == null || drafts.has(pendingAddAorId)) return;
    setDrafts((current) =>
      new Map(current).set(pendingAddAorId, boundaryPairAtMapCenter(editorMap)),
    );
    setPendingAddAorId(null);
  }, [drafts, editorMap, pendingAddAorId]);

  const addBoundaryPair = (aorId: number) => {
    if (!editorOpen) {
      openEditor(aorId);
      return;
    }
    if (!editorMap) {
      setPendingAddAorId(aorId);
      return;
    }
    setDrafts((current) => new Map(current).set(aorId, boundaryPairAtMapCenter(editorMap)));
  };

  const closeEditor = () => {
    if (saving) return;
    setEditorOpen(false);
    setEditorMap(null);
    setPendingAddAorId(null);
    setError(null);
  };

  const confirmBoundaries = async () => {
    const items = buildBoundaryUpdates(aors, drafts);
    if (items.length === 0) {
      closeEditor();
      return;
    }
    setSaving(true);
    setError(null);
    setRefreshError(null);
    try {
      await updateAorBattleLineBoundaries({ items });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setSaving(false);
      return;
    }

    setEditorOpen(false);
    setEditorMap(null);
    try {
      await reload();
      setSaved(true);
    } catch (reloadError) {
      const message = reloadError instanceof Error ? reloadError.message : String(reloadError);
      setRefreshError(`Межі збережено, але не вдалося оновити дані: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const boundaryIds = new Set(aors.filter((aor) => boundaryPair(aor) != null).map((aor) => aor.id));

  return (
    <>
      <AorBattleLinePreview
        aors={aors}
        boundaryIds={boundaryIds}
        state={state}
        visibleAorIds={visibleAorIds}
        onAdd={addBoundaryPair}
        onEdit={() => openEditor()}
        onHideAll={() => setVisibleAorIds(new Set())}
        onShowAll={() => setVisibleAorIds(initialVisibleIds)}
        onToggle={(aorId) =>
          setVisibleAorIds((current) => {
            const next = new Set(current);
            if (next.has(aorId)) next.delete(aorId);
            else next.add(aorId);
            return next;
          })
        }
      />
      <BoundaryEditorDialog
        aors={aors}
        drafts={drafts}
        error={error}
        open={editorOpen}
        saving={saving}
        state={state}
        onAdd={addBoundaryPair}
        onCancel={closeEditor}
        onConfirm={() => void confirmBoundaries()}
        onMapReady={setEditorMap}
        onMove={moveBoundary}
      />

      <Snackbar open={saved} autoHideDuration={5000} onClose={() => setSaved(false)}>
        <Alert severity="success" onClose={() => setSaved(false)}>
          {state.activeVersion ? 'Межі збережено, сегменти ЛБЗ перераховано' : 'Межі збережено'}
        </Alert>
      </Snackbar>
      <Snackbar
        open={refreshError != null}
        autoHideDuration={8000}
        onClose={() => setRefreshError(null)}
      >
        <Alert severity="error" onClose={() => setRefreshError(null)}>
          {refreshError}
        </Alert>
      </Snackbar>
    </>
  );
}
