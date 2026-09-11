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
  id: symbol;
  text: AnnotatedText;
  previous: Point | null;
  fabric: typeof import('fabric');
  start: Point;
  latest: Point;
  startScreen: Point;
  latestScreen: Point;
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
  preview,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  preview?: { text: AnnotatedText; target: Point | null };
}) {
  removeImageEditorDerivedArrows(canvas);
  canvas.getObjects().forEach((object) => {
    if (
      !(object instanceof fabric.IText) ||
      object.get('editorRole') !== ImageEditorObjectRole.Text
    )
      return;
    const target = preview?.text === object ? preview.target : targetFor(object as AnnotatedText);
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
  text.setCoords();
}
export function removeImageEditorAttachedArrow(
  canvas: import('fabric').Canvas,
  text: AnnotatedText,
) {
  text.set({ [TARGET_X]: undefined, [TARGET_Y]: undefined });
  text.setCoords();
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
  attachedArrowGestures.delete(canvas);
  reconcileImageEditorAttachedArrows({ canvas, fabric: gesture.fabric });
  return true;
}

export function installImageEditorAttachedArrowControl({
  canvas,
  fabric,
  text,
  onComplete,
  onChange,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  text: AnnotatedText;
  onComplete: () => void;
  onChange?: () => void;
}) {
  const controls = text.controls as Record<string, import('fabric').Control>;
  if (controls[IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]) return;
  let gestureId: symbol | null = null;
  const activeGesture = () => {
    const gesture = attachedArrowGestures.get(canvas);
    return gesture?.id === gestureId ? gesture : null;
  };
  const begin = (event: Event, owner: AnnotatedText) => {
    const start = { x: owner.left ?? 0, y: owner.top ?? 0 };
    gestureId = Symbol('attached-arrow-gesture');
    attachedArrowGestures.set(canvas, {
      id: gestureId,
      text: owner,
      previous: targetFor(owner),
      fabric,
      start,
      latest: start,
      startScreen: {
        x: event instanceof MouseEvent ? event.clientX : 0,
        y: event instanceof MouseEvent ? event.clientY : 0,
      },
      latestScreen: {
        x: event instanceof MouseEvent ? event.clientX : 0,
        y: event instanceof MouseEvent ? event.clientY : 0,
      },
    });
    return true;
  };
  const update = (event: Event, owner: AnnotatedText, x: number, y: number) => {
    const gesture = activeGesture();
    if (!gesture || gesture.text !== owner) return false;
    const target = { x, y };
    gesture.latest = target;
    if (event instanceof MouseEvent) gesture.latestScreen = { x: event.clientX, y: event.clientY };
    const valid =
      Math.hypot(target.x - (owner.left ?? 0), target.y - (owner.top ?? 0)) >= 3 &&
      imageEditorAttachedArrowGeometry(owner, target) != null;
    reconcileImageEditorAttachedArrows({
      canvas,
      fabric,
      preview: { text: owner, target: valid ? target : null },
    });
    return false;
  };
  const complete = (event: Event, _transform: import('fabric').Transform, x: number, y: number) => {
    const gesture = activeGesture();
    if (!gesture) return false;
    gesture.latest = { x, y };
    if (event instanceof MouseEvent) gesture.latestScreen = { x: event.clientX, y: event.clientY };
    attachedArrowGestures.delete(canvas);
    const moved =
      Math.hypot(
        gesture.latestScreen.x - gesture.startScreen.x,
        gesture.latestScreen.y - gesture.startScreen.y,
      ) >= 3;
    const valid =
      moved &&
      Math.hypot(
        gesture.latest.x - (gesture.text.left ?? 0),
        gesture.latest.y - (gesture.text.top ?? 0),
      ) >= 3 &&
      imageEditorAttachedArrowGeometry(gesture.text, gesture.latest) != null;
    if (valid) setImageEditorAttachedArrowTarget(gesture.text, gesture.latest);
    reconcileImageEditorAttachedArrows({ canvas, fabric });
    if (valid) onComplete();
    (canvas as import('fabric').Canvas & { fire: (eventName: string) => void }).fire(
      'image-editor:attached-arrow-changed',
    );
    onChange?.();
    return valid;
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
      mouseDownHandler: (event, transform) => begin(event, transform.target as AnnotatedText),
      actionHandler: (event, transform, x, y) =>
        update(event, transform.target as AnnotatedText, x, y),
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
      mouseDownHandler: (event, transform) => begin(event, transform.target as AnnotatedText),
      actionHandler: (event, transform, x, y) =>
        update(event, transform.target as AnnotatedText, x, y),
      mouseUpHandler: complete,
    }),
  };
}

export function installImageEditorAttachedArrowControls({
  canvas,
  fabric,
  onComplete,
  onChange,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  onComplete: () => void;
  onChange?: () => void;
}) {
  canvas.getObjects().forEach((object) => {
    if (object instanceof fabric.IText)
      installImageEditorAttachedArrowControl({
        canvas,
        fabric,
        text: object as AnnotatedText,
        onComplete,
        onChange,
      });
  });
  reconcileImageEditorAttachedArrows({ canvas, fabric });
}
