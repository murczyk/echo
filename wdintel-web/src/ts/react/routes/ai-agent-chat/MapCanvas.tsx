import * as L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import type { AiAgentMapRecord } from '../../../../Bindings';
import type { BaseLayerId } from '../../../maps/base-layers';
import { MessageCardMapPreview } from '../shared/message-card/MessageCardMapPreview';
import { markerSignature, planMarkerSync } from './map-markers';
import { symbolImage } from './map-symbol';

const SYMBOL_SIZE = 26;
const FAN_RADIUS_PX = 16;

type MarkerEntry = { marker: L.Marker; signature: string };

export type MapCanvasProps = {
  fitKey: string;
  records: AiAgentMapRecord[];
  selectedIds: ReadonlySet<string>;
  pulseIds: ReadonlySet<string>;
  baseLayerId: BaseLayerId;
  focusId: string | null;
  onSelect: (id: string, additive: boolean) => void;
  onBoxSelect: (ids: string[], additive: boolean) => void;
  onClearSelection: () => void;
};

export default function MapCanvas(props: MapCanvasProps) {
  const { fitKey, records, selectedIds, pulseIds, baseLayerId, focusId } = props;
  const [map, setMap] = useState<L.Map | null>(null);
  const markersRef = useRef(new Map<string, MarkerEntry>());
  const fittedRef = useRef<string | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;

  useEffect(() => {
    if (!map) return;
    const desired = markerModels(records, selectedIds, pulseIds);
    const existing = new Map([...markersRef.current].map(([id, entry]) => [id, entry.signature]));
    const plan = planMarkerSync(
      existing,
      [...desired].map(([id, model]) => ({ id, signature: model.signature })),
    );
    for (const id of plan.remove) {
      markersRef.current.get(id)?.marker.remove();
      markersRef.current.delete(id);
    }
    for (const id of plan.update) updateMarker(markersRef.current.get(id), desired.get(id)!);
    for (const id of plan.add) {
      markersRef.current.set(id, addMarker(map, desired.get(id)!, handlersRef));
    }
    if (fittedRef.current !== fitKey) {
      fitAll(map, records);
      fittedRef.current = fitKey;
    }
  }, [map, fitKey, records, selectedIds, pulseIds]);

  useEffect(() => {
    if (!map || !focusId) return;
    const marker = markersRef.current.get(focusId)?.marker;
    if (marker && !map.getBounds().contains(marker.getLatLng())) {
      map.panTo(marker.getLatLng(), { animate: true });
    }
  }, [map, focusId]);

  useEffect(() => {
    if (!map) return;
    return installBoxSelection(map, markersRef.current, handlersRef);
  }, [map]);

  return (
    <MessageCardMapPreview
      baseLayerId={baseLayerId}
      dataAttributes={{ 'data-testid': 'ai-map-canvas' }}
      onMapReady={(instance) => {
        setMap(instance);
        return () => {
          markersRef.current.forEach((entry) => entry.marker.remove());
          markersRef.current.clear();
          fittedRef.current = null;
        };
      }}
    />
  );
}

type MarkerModel = {
  id: string;
  signature: string;
  latitude: number;
  longitude: number;
  name: string;
  sidc: string;
  className: string;
  offset: [number, number];
};

/** Records sharing exact coordinates are fanned out in a small circle so each
 * stays visible and clickable. */
function fanOffsets(records: AiAgentMapRecord[]): Map<string, [number, number]> {
  const groups = new Map<string, string[]>();
  for (const record of records) {
    if (record.latitude == null || record.longitude == null) continue;
    const key = `${record.latitude.toFixed(6)},${record.longitude.toFixed(6)}`;
    groups.set(key, [...(groups.get(key) ?? []), record.id]);
  }
  const offsets = new Map<string, [number, number]>();
  for (const ids of groups.values()) {
    ids.forEach((id, index) => {
      if (ids.length === 1) {
        offsets.set(id, [0, 0]);
        return;
      }
      const angle = (2 * Math.PI * index) / ids.length - Math.PI / 2;
      const radius = FAN_RADIUS_PX + ids.length;
      offsets.set(id, [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)]);
    });
  }
  return offsets;
}

function markerModels(
  records: AiAgentMapRecord[],
  selectedIds: ReadonlySet<string>,
  pulseIds: ReadonlySet<string>,
): Map<string, MarkerModel> {
  const offsets = fanOffsets(records);
  const models = new Map<string, MarkerModel>();
  for (const record of records) {
    if (record.latitude == null || record.longitude == null) continue;
    const selected = selectedIds.has(record.id);
    const pulse = pulseIds.has(record.id);
    const offset = offsets.get(record.id) ?? [0, 0];
    models.set(record.id, {
      id: record.id,
      signature: markerSignature([
        record.sidc,
        record.latitude,
        record.longitude,
        record.name,
        selected,
        pulse,
        offset.join(','),
      ]),
      latitude: record.latitude,
      longitude: record.longitude,
      name: record.name,
      sidc: record.sidc,
      className: ['ai-map-symbol', selected ? 'is-selected' : '', pulse ? 'is-changed' : '']
        .filter(Boolean)
        .join(' '),
      offset,
    });
  }
  return models;
}

function markerIcon(model: MarkerModel): L.Icon {
  const image = symbolImage(model.sidc, SYMBOL_SIZE);
  return L.icon({
    iconUrl: image.url,
    iconSize: [image.width, image.height],
    iconAnchor: [image.anchorX - model.offset[0], image.anchorY - model.offset[1]],
    className: model.className,
  });
}

function addMarker(
  map: L.Map,
  model: MarkerModel,
  handlersRef: { current: MapCanvasProps },
): MarkerEntry {
  const marker = L.marker([model.latitude, model.longitude], {
    icon: markerIcon(model),
    title: model.name,
    alt: model.name,
    keyboard: true,
    riseOnHover: true,
  }).addTo(map);
  marker.on('click', (event) => {
    const mouse = event.originalEvent;
    L.DomEvent.stop(event);
    handlersRef.current.onSelect(model.id, mouse.ctrlKey || mouse.metaKey || mouse.shiftKey);
  });
  marker.on('keydown', (event) => {
    const keyboard = event.originalEvent;
    if (keyboard.key !== 'Enter' && keyboard.key !== ' ') return;
    keyboard.preventDefault();
    handlersRef.current.onSelect(model.id, keyboard.ctrlKey || keyboard.metaKey);
  });
  return { marker, signature: model.signature };
}

function updateMarker(entry: MarkerEntry | undefined, model: MarkerModel) {
  if (!entry) return;
  entry.marker.setLatLng([model.latitude, model.longitude]);
  entry.marker.setIcon(markerIcon(model));
  entry.marker.options.title = model.name;
  entry.signature = model.signature;
}

function fitAll(map: L.Map, records: AiAgentMapRecord[]) {
  const points = records.flatMap((record) =>
    record.latitude != null && record.longitude != null
      ? [L.latLng(record.latitude, record.longitude)]
      : [],
  );
  if (points.length) {
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 14, animate: false });
  } else {
    map.setView([48, 31], 6);
  }
}

/** Shift-drag draws a selection box (instead of Leaflet's box zoom); a plain
 * click on the map clears the selection. */
function installBoxSelection(
  map: L.Map,
  markers: Map<string, MarkerEntry>,
  handlersRef: { current: MapCanvasProps },
): () => void {
  map.boxZoom.disable();
  let start: L.LatLng | null = null;
  let box: L.Rectangle | null = null;
  const onDown = (event: L.LeafletMouseEvent) => {
    if (!event.originalEvent.shiftKey) return;
    start = event.latlng;
    map.dragging.disable();
  };
  const onMove = (event: L.LeafletMouseEvent) => {
    if (!start) return;
    const bounds = L.latLngBounds(start, event.latlng);
    if (box) box.setBounds(bounds);
    else box = L.rectangle(bounds, { weight: 1, dashArray: '4', interactive: false }).addTo(map);
  };
  const onUp = (event: L.LeafletMouseEvent) => {
    if (!start) return;
    const bounds = L.latLngBounds(start, event.latlng);
    const ids = [...markers.entries()]
      .filter(([, entry]) => bounds.contains(entry.marker.getLatLng()))
      .map(([id]) => id);
    box?.remove();
    box = null;
    start = null;
    map.dragging.enable();
    handlersRef.current.onBoxSelect(
      ids,
      event.originalEvent.ctrlKey || event.originalEvent.metaKey,
    );
  };
  const onClick = (event: L.LeafletMouseEvent) => {
    if (!event.originalEvent.shiftKey) handlersRef.current.onClearSelection();
  };
  map.on('mousedown', onDown);
  map.on('mousemove', onMove);
  map.on('mouseup', onUp);
  map.on('click', onClick);
  return () => {
    map.off('mousedown', onDown);
    map.off('mousemove', onMove);
    map.off('mouseup', onUp);
    map.off('click', onClick);
    box?.remove();
    map.dragging.enable();
  };
}
