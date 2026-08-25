type FabricModule = typeof import('fabric');
type FabricObject = import('fabric').FabricObject;

export type ImageEditorObjectStyle = {
  stroke: string;
  fill?: string;
  strokeWidth: number;
  dash: boolean;
};

const FALLBACK_EDITOR_COLOR = '#ef4444';
const HEX_COLOR = /^#([\da-f]{6})(?:[\da-f]{2})?$/i;
const SHORT_HEX_COLOR = /^#([\da-f]{3})(?:[\da-f])?$/i;

export function normalizeEditorColor(value: unknown) {
  if (typeof value !== 'string') return FALLBACK_EDITOR_COLOR;
  const hex = value.match(HEX_COLOR);
  if (hex) return `#${hex[1]}`;
  const shortHex = value.match(SHORT_HEX_COLOR);
  if (shortHex)
    return `#${shortHex[1]
      .split('')
      .map((character) => character.repeat(2))
      .join('')}`;
  return FALLBACK_EDITOR_COLOR;
}

export function withHighlightAlpha(baseColor: string) {
  return `${normalizeEditorColor(baseColor)}88`;
}

function dashEnabled(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function arrowParts(selected: FabricObject, fabric: FabricModule) {
  if (!(selected instanceof fabric.Group)) return undefined;
  const objects = selected.getObjects();
  const shaft = objects.find(
    (object) => object instanceof fabric.Line || object.type === 'Line' || object.type === 'line',
  );
  const head = objects.find(
    (object) =>
      object instanceof fabric.Triangle || object.type === 'Triangle' || object.type === 'triangle',
  );
  return shaft ? { shaft, head } : undefined;
}

export function editorObjectRole(selected: FabricObject, fabric: FabricModule) {
  const role = selected.get('editorRole');
  if (typeof role === 'string') return role;
  const parts = arrowParts(selected, fabric);
  if (parts?.head) return 'arrow';
  return typeof selected.stroke === 'string' && /^#[\da-f]{6}88$/i.test(selected.stroke)
    ? 'highlight'
    : undefined;
}

export function readImageEditorObjectStyle(
  selected: FabricObject,
  fabric: FabricModule,
): ImageEditorObjectStyle | undefined {
  const role = editorObjectRole(selected, fabric);
  if (role === 'arrow') {
    const parts = arrowParts(selected, fabric);
    if (!parts) return undefined;
    return {
      stroke: normalizeEditorColor(parts.shaft.stroke),
      strokeWidth: parts.shaft.strokeWidth ?? 1,
      dash: dashEnabled(parts.shaft.strokeDashArray),
    };
  }
  if (!role || !['rectangle', 'ellipse', 'line', 'brush', 'highlight'].includes(role))
    return undefined;
  return {
    stroke: normalizeEditorColor(selected.stroke),
    fill: typeof selected.fill === 'string' ? selected.fill : undefined,
    strokeWidth: selected.strokeWidth ?? 1,
    dash: dashEnabled(selected.strokeDashArray),
  };
}

export function applyArrowStyle({
  selected,
  fabric,
  stroke,
  strokeWidth,
  dash,
}: {
  selected: FabricObject;
  fabric: FabricModule;
  stroke: string;
  strokeWidth: number;
  dash: boolean;
}) {
  const parts = arrowParts(selected, fabric);
  if (!parts) return false;
  const strokeDashArray = dash ? [strokeWidth * 2, strokeWidth * 2] : undefined;
  if (
    parts.shaft.stroke === stroke &&
    parts.shaft.strokeWidth === strokeWidth &&
    JSON.stringify(parts.shaft.strokeDashArray ?? undefined) === JSON.stringify(strokeDashArray) &&
    (!parts.head || parts.head.fill === stroke)
  )
    return false;
  parts.shaft.set({ stroke, strokeWidth, strokeDashArray });
  if (parts.head) parts.head.set({ fill: stroke });
  selected.set({ dirty: true });
  selected.setCoords();
  return true;
}
