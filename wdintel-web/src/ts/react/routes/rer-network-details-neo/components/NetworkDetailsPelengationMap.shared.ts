import type { NetworkPoint } from '../../../../../Bindings';
import { NO_DATA_LABEL, sortFrequenciesNumerically } from '../../../utils/misc';

export const SATELLITE_TILE_URL = 'https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk';
export const SATELLITE_TILE_SUBDOMAINS = ['mt0', 'mt1', 'mt2', 'mt3'];
export const BASE_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const PELENG_TOOLTIP_ARROW_COLOR = '#000000';
export const PELENG_HEATMAP_MAX_ALPHA = 0.58;
export const PELENG_HEATMAP_MIN_ALPHA = 0.38;
export const PELENG_HEATMAP_MIN_RADIUS = 72;
export const PELENG_HEATMAP_MAX_RADIUS = 100;

export function normalizePelengationFrequency(freq: string): string {
  const trimmed = freq.trim();
  return trimmed === '' ? NO_DATA_LABEL : trimmed;
}

export function getPelengationFrequencies(points: NetworkPoint[]): string[] {
  return sortFrequenciesNumerically([
    ...new Set(points.map((point) => normalizePelengationFrequency(point.freq))),
  ]);
}

export function filterPelengationPoints(
  points: NetworkPoint[],
  search: string,
  enabledFreqs: string[],
): NetworkPoint[] {
  const normalizedSearch = search.trim().toLocaleUpperCase('uk-UA');
  const enabledFreqSet = new Set(enabledFreqs.map(normalizePelengationFrequency));

  return points.filter((point) => {
    const freq = normalizePelengationFrequency(point.freq);
    if (!enabledFreqSet.has(freq)) return false;
    if (normalizedSearch === '') return true;
    return freq.toLocaleUpperCase('uk-UA').includes(normalizedSearch);
  });
}

export type PelengationLabelGroup = {
  freq: string;
  label: string;
  lat: number;
  lng: number;
  points: NetworkPoint[];
};

export function buildPelengationLabelGroups(
  points: NetworkPoint[],
  projectPoint: (point: NetworkPoint) => { x: number; y: number },
  maxDistancePx: number = 44,
): PelengationLabelGroup[] {
  const groupedByFreq = new Map<string, Array<{ point: NetworkPoint; x: number; y: number }>>();

  for (const point of points) {
    const freq = normalizePelengationFrequency(point.freq);
    const projected = projectPoint(point);
    const group = groupedByFreq.get(freq) ?? [];
    group.push({ point, ...projected });
    groupedByFreq.set(freq, group);
  }

  const groups: PelengationLabelGroup[] = [];

  for (const [freq, freqPoints] of groupedByFreq.entries()) {
    const visited = new Set<number>();

    for (let index = 0; index < freqPoints.length; index += 1) {
      if (visited.has(index)) continue;

      const queue = [index];
      const componentIndexes: number[] = [];
      visited.add(index);

      while (queue.length > 0) {
        const currentIndex = queue.pop();
        if (currentIndex === undefined) continue;
        componentIndexes.push(currentIndex);
        const currentPoint = freqPoints[currentIndex];

        for (let otherIndex = 0; otherIndex < freqPoints.length; otherIndex += 1) {
          if (visited.has(otherIndex)) continue;
          const otherPoint = freqPoints[otherIndex];
          const dx = currentPoint.x - otherPoint.x;
          const dy = currentPoint.y - otherPoint.y;
          if (Math.hypot(dx, dy) <= maxDistancePx) {
            visited.add(otherIndex);
            queue.push(otherIndex);
          }
        }
      }

      const componentPoints = componentIndexes.map((itemIndex) => freqPoints[itemIndex].point);
      const centroid = componentPoints.reduce(
        (accumulator, point) => ({
          lat: accumulator.lat + point.lat / componentPoints.length,
          lng: accumulator.lng + point.lng / componentPoints.length,
        }),
        { lat: 0, lng: 0 },
      );
      const label = componentPoints.length > 1 ? `${freq} · ${componentPoints.length}` : freq;

      groups.push({
        freq,
        label,
        lat: centroid.lat,
        lng: centroid.lng,
        points: componentPoints,
      });
    }
  }

  return groups;
}

export function getPelengationHeatmapRadius(zoom: number): number {
  const normalizedZoom = Math.max(2, Math.min(19, zoom));
  const radius = 100 - (normalizedZoom - 2) * 2;
  return Math.max(
    PELENG_HEATMAP_MIN_RADIUS,
    Math.min(PELENG_HEATMAP_MAX_RADIUS, Math.round(radius)),
  );
}

export function getPelengationHeatmapAlpha(pointCount: number): number {
  const normalizedCount = Math.max(1, pointCount);
  const densityBoost = Math.log1p(normalizedCount - 1) / Math.log(12);
  return Math.min(PELENG_HEATMAP_MAX_ALPHA, PELENG_HEATMAP_MIN_ALPHA + densityBoost * 0.14);
}

export function createPelengationPopupContent(point: NetworkPoint, label: string) {
  const content = document.createElement('div');
  content.style.minWidth = '180px';
  content.style.maxWidth = '260px';
  content.style.display = 'flex';
  content.style.flexDirection = 'column';
  content.style.gap = '6px';

  const title = document.createElement('div');
  title.textContent = label;
  title.style.fontWeight = '700';
  title.style.fontSize = '14px';
  title.style.lineHeight = '1.2';

  const freq = document.createElement('div');
  freq.textContent = `Частота: ${normalizePelengationFrequency(point.freq)}`;
  freq.style.fontSize = '13px';
  freq.style.lineHeight = '1.35';

  const body = document.createElement('div');
  body.textContent = point.body?.trim() === '' ? 'Без тексту' : point.body;
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontSize = '13px';
  body.style.lineHeight = '1.45';

  const coords = document.createElement('div');
  coords.textContent = `Координати: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  coords.style.fontSize = '12px';
  coords.style.opacity = '0.8';

  content.append(title, freq, body, coords);
  return content;
}

export function applyPelengationMapStyles() {
  const styleId = 'peleng-point-label-tooltip-styles';
  const existingStyle = document.getElementById(styleId);
  const style = existingStyle ?? document.createElement('style');
  const createdStyle = existingStyle === null;

  style.id = styleId;
  style.textContent = `
    .leaflet-popup.peleng-point-popup .leaflet-popup-content-wrapper {
      background: rgba(18, 20, 18, 0.95) !important;
      color: #ffffff !important;
    }
    .leaflet-popup.peleng-point-popup .leaflet-popup-tip {
      background: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
      box-shadow: none !important;
    }
    .peleng-label-anchor {
      width: 1px;
      height: 1px;
      pointer-events: none;
      background: transparent;
      border: 0;
    }
    .leaflet-tooltip.peleng-point-label {
      background: #11110f !important;
      border: 1px solid #000000 !important;
      box-shadow: none !important;
      color: #fff7ea !important;
      font-weight: 800 !important;
      font-size: 12px !important;
      letter-spacing: 0.04em !important;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9) !important;
      padding: 3px 8px !important;
      border-radius: 999px !important;
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:before,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:before,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:before,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:before {
      display: none !important;
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:after,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:after,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:after,
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:after {
      position: absolute;
      width: 0;
      height: 0;
      border: 6px solid transparent;
      pointer-events: none;
      content: "";
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-top:after {
      left: 50% !important;
      bottom: 0 !important;
      margin-bottom: -12px !important;
      transform: translateX(-50%);
      border-top-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-bottom:after {
      left: 50% !important;
      top: 0 !important;
      margin-top: -12px !important;
      transform: translateX(-50%);
      border-bottom-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-left:after {
      top: 50% !important;
      right: 0 !important;
      margin-top: -6px !important;
      margin-right: -12px !important;
      border-left-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
    }
    .leaflet-tooltip.peleng-point-label.leaflet-tooltip-right:after {
      top: 50% !important;
      left: 0 !important;
      margin-top: -6px !important;
      margin-left: -12px !important;
      border-right-color: ${PELENG_TOOLTIP_ARROW_COLOR} !important;
    }
  `;

  if (createdStyle) {
    document.head.appendChild(style);
  }

  return () => {
    if (createdStyle) {
      style.remove();
    }
  };
}
