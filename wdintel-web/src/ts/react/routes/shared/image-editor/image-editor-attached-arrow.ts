import { createArrow } from './image-editor-arrow';
import { ImageEditorObjectRole } from './image-editor.types';

export const IMAGE_EDITOR_ATTACHED_ARROW_CONTROL = 'attachedArrow';
export const IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL = 'attachedArrowEndpoint';
const TARGET_X = 'attachedArrowTargetX';
const TARGET_Y = 'attachedArrowTargetY';
type Point = { x: number; y: number };
type AnnotatedText = import('fabric').IText & {
  attachedArrowTargetX?: number;
  attachedArrowTargetY?: number;
};
type AttachedArrowGesture = {
  text: AnnotatedText;
  previous: Point | null;
  fabric: typeof import('fabric');
};
const attachedArrowGestures = new WeakMap<import('fabric').Canvas, AttachedArrowGesture>();

function targetFor(text: AnnotatedText): Point | null {
  const x = Number(text.get(TARGET_X));
  const y = Number(text.get(TARGET_Y));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function hasImageEditorAttachedArrow(text: AnnotatedText) {
  return targetFor(text) != null;
}

function transformPoint(matrix: import('fabric').TMat2D, x: number, y: number): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function boundary(text: AnnotatedText) {
  const padding = text.get('annotationBackgroundEnabled')
    ? Number(text.get('annotationBackgroundPadding') ?? 0)
    : 0;
  const width = (text.width ?? 0) + padding * 2;
  const height = (text.height ?? 0) + padding * 2;
  const matrix = text.calcTransformMatrix();
  return [
    transformPoint(matrix, -width / 2, -height / 2),
    transformPoint(matrix, width / 2, -height / 2),
    transformPoint(matrix, width / 2, height / 2),
    transformPoint(matrix, -width / 2, height / 2),
  ];
}

function intersection(origin: Point, target: Point, first: Point, second: Point): Point | null {
  const rayX = target.x - origin.x,
    rayY = target.y - origin.y,
    edgeX = second.x - first.x,
    edgeY = second.y - first.y;
  const denominator = rayX * edgeY - rayY * edgeX;
  if (Math.abs(denominator) < 0.000001) return null;
  const startX = first.x - origin.x,
    startY = first.y - origin.y;
  const ray = (startX * edgeY - startY * edgeX) / denominator;
  const edge = (startX * rayY - startY * rayX) / denominator;
  return ray >= 0 && ray <= 1 && edge >= 0 && edge <= 1
    ? { x: origin.x + rayX * ray, y: origin.y + rayY * ray }
    : null;
}

export function imageEditorAttachedArrowGeometry(text: AnnotatedText, target: Point) {
  const polygon = boundary(text);
  const origin = polygon.reduce(
    (total, point) => ({ x: total.x + point.x / 4, y: total.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const start = polygon
    .map((point, index) =>
      intersection(origin, target, point, polygon[(index + 1) % polygon.length]!),
    )
    .find((point): point is Point => point != null);
  return start && Math.hypot(target.x - start.x, target.y - start.y) >= 3
    ? { start, end: target }
    : null;
}

export function removeImageEditorDerivedArrows(canvas: import('fabric').Canvas) {
  canvas
    .getObjects()
    .filter((object) => object.get('editorRole') === ImageEditorObjectRole.DerivedArrow)
    .forEach((arrow) => canvas.remove(arrow));
}

export function reconcileImageEditorAttachedArrows({
  canvas,
  fabric,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
}) {
  removeImageEditorDerivedArrows(canvas);
  canvas.getObjects().forEach((object) => {
    if (
      !(object instanceof fabric.IText) ||
      object.get('editorRole') !== ImageEditorObjectRole.Text
    )
      return;
    const target = targetFor(object as AnnotatedText);
    if (!target) return;
    const geometry = imageEditorAttachedArrowGeometry(object as AnnotatedText, target);
    if (!geometry) return;
    const arrow = createArrow({
      fabric,
      start: geometry.start,
      end: geometry.end,
      stroke: typeof object.fill === 'string' ? object.fill : '#ef4444',
      strokeWidth: 4,
      dash: false,
    });
    if (!arrow) return;
    arrow.set({
      editorRole: ImageEditorObjectRole.DerivedArrow,
      selectable: false,
      evented: false,
      excludeFromExport: false,
    });
    canvas.add(arrow);
    canvas.moveObjectTo(arrow, Math.max(0, canvas.getObjects().indexOf(object)));
  });
  canvas.requestRenderAll();
}

export function setImageEditorAttachedArrowTarget(text: AnnotatedText, target: Point) {
  text.set({ [TARGET_X]: target.x, [TARGET_Y]: target.y });
}
export function removeImageEditorAttachedArrow(
  canvas: import('fabric').Canvas,
  text: AnnotatedText,
) {
  text.set({ [TARGET_X]: undefined, [TARGET_Y]: undefined });
  removeImageEditorDerivedArrows(canvas);
}
export function translateImageEditorAttachedArrowTarget(text: AnnotatedText, x: number, y: number) {
  const target = targetFor(text);
  if (target) setImageEditorAttachedArrowTarget(text, { x: target.x - x, y: target.y - y });
}

function renderControl(context: CanvasRenderingContext2D, left: number, top: number) {
  context.save();
  context.translate(left, top);
  context.fillStyle = '#ef4444';
  context.beginPath();
  context.moveTo(-7, -5);
  context.lineTo(2, -5);
  context.lineTo(2, -9);
  context.lineTo(9, 0);
  context.lineTo(2, 9);
  context.lineTo(2, 5);
  context.lineTo(-7, 5);
  context.closePath();
  context.fill();
  context.restore();
}

function renderEndpointControl(context: CanvasRenderingContext2D, left: number, top: number) {
  context.save();
  context.translate(left, top);
  context.fillStyle = '#ffffff';
  context.strokeStyle = '#ef4444';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, 0, 7, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

export function cancelImageEditorAttachedArrowGesture(canvas: import('fabric').Canvas) {
  const gesture = attachedArrowGestures.get(canvas);
  if (!gesture) return false;
  if (gesture.previous) setImageEditorAttachedArrowTarget(gesture.text, gesture.previous);
  else removeImageEditorAttachedArrow(canvas, gesture.text);
  attachedArrowGestures.delete(canvas);
  reconcileImageEditorAttachedArrows({ canvas, fabric: gesture.fabric });
  return true;
}

export function installImageEditorAttachedArrowControl({
  canvas,
  fabric,
  text,
  onComplete,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  text: AnnotatedText;
  onComplete: () => void;
}) {
  const controls = text.controls as Record<string, import('fabric').Control>;
  if (controls[IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]) return;
  let changed = false;
  let previous = targetFor(text);
  const begin = (owner: AnnotatedText) => {
    previous = targetFor(owner);
    changed = false;
    attachedArrowGestures.set(canvas, { text: owner, previous, fabric });
    return true;
  };
  const update = (owner: AnnotatedText, x: number, y: number) => {
    const target = { x, y };
    if (
      Math.hypot(target.x - (owner.left ?? 0), target.y - (owner.top ?? 0)) < 3 ||
      !imageEditorAttachedArrowGeometry(owner, target)
    )
      return false;
    setImageEditorAttachedArrowTarget(owner, target);
    reconcileImageEditorAttachedArrows({ canvas, fabric });
    changed = true;
    return true;
  };
  const complete = () => {
    attachedArrowGestures.delete(canvas);
    if (changed) onComplete();
    else if (previous) setImageEditorAttachedArrowTarget(text, previous);
    else removeImageEditorAttachedArrow(canvas, text);
    reconcileImageEditorAttachedArrows({ canvas, fabric });
    return changed;
  };
  text.controls = {
    ...controls,
    [IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]: new fabric.Control({
      x: 0.5,
      y: 0,
      offsetX: 24,
      cursorStyle: 'crosshair',
      sizeX: 16,
      sizeY: 16,
      actionName: 'attachedArrow',
      render: renderControl,
      mouseDownHandler: (_event, transform) => begin(transform.target as AnnotatedText),
      actionHandler: (_event, transform, x, y) => update(transform.target as AnnotatedText, x, y),
      mouseUpHandler: complete,
    }),
    [IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL]: new fabric.Control({
      cursorStyle: 'crosshair',
      sizeX: 16,
      sizeY: 16,
      actionName: 'attachedArrowEndpoint',
      render: renderEndpointControl,
      getVisibility: () => targetFor(text) != null,
      positionHandler: () => {
        const target = targetFor(text) ?? { x: -1000, y: -1000 };
        return new fabric.Point(target.x, target.y);
      },
      mouseDownHandler: (_event, transform) => begin(transform.target as AnnotatedText),
      actionHandler: (_event, transform, x, y) => update(transform.target as AnnotatedText, x, y),
      mouseUpHandler: complete,
    }),
  };
}

export function installImageEditorAttachedArrowControls({
  canvas,
  fabric,
  onComplete,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  onComplete: () => void;
}) {
  canvas.getObjects().forEach((object) => {
    if (object instanceof fabric.IText)
      installImageEditorAttachedArrowControl({
        canvas,
        fabric,
        text: object as AnnotatedText,
        onComplete,
      });
  });
  reconcileImageEditorAttachedArrows({ canvas, fabric });
}
