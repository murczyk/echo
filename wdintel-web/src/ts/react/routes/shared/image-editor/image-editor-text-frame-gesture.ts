import { reconcileImageEditorAttachedArrows } from './image-editor-attached-arrow';
import { imageEditorPointer, minimumGestureSize } from './image-editor-pointer';

type Point = { x: number; y: number };
type Snapshot = Pick<
  import('fabric').IText,
  'left' | 'top' | 'scaleX' | 'scaleY' | 'width' | 'height' | 'angle' | 'text'
>;

function snapshot(text: import('fabric').IText): Snapshot {
  return {
    left: text.left ?? 0,
    top: text.top ?? 0,
    scaleX: text.scaleX ?? 1,
    scaleY: text.scaleY ?? 1,
    width: text.width ?? 0,
    height: text.height ?? 0,
    angle: text.angle ?? 0,
    text: text.text ?? '',
  };
}

function restore(text: import('fabric').IText, value: Snapshot) {
  text.set(value);
  text.setCoords();
}

function distance(point: Point, start: Point, end: Point) {
  const x = end.x - start.x,
    y = end.y - start.y,
    length = x * x + y * y;
  const ratio = length
    ? Math.max(0, Math.min(1, ((point.x - start.x) * x + (point.y - start.y) * y) / length))
    : 0;
  return Math.hypot(point.x - start.x - x * ratio, point.y - start.y - y * ratio);
}

function hitsFrame(
  canvas: import('fabric').Canvas,
  text: import('fabric').IText,
  event: PointerEvent,
) {
  const padding = text.get('annotationBackgroundEnabled')
    ? Number(text.get('annotationBackgroundPadding') ?? 0)
    : 0;
  const width = (text.width ?? 0) + padding * 2,
    height = (text.height ?? 0) + padding * 2;
  const matrix = text.calcTransformMatrix(),
    viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const screen = (x: number, y: number) => {
    const sceneX = matrix[0] * x + matrix[2] * y + matrix[4],
      sceneY = matrix[1] * x + matrix[3] * y + matrix[5];
    return {
      x:
        rect.left +
        ((viewport[0] * sceneX + viewport[2] * sceneY + viewport[4]) * rect.width) / canvas.width,
      y:
        rect.top +
        ((viewport[1] * sceneX + viewport[3] * sceneY + viewport[5]) * rect.height) / canvas.height,
    };
  };
  const corners = [
    screen(-width / 2, -height / 2),
    screen(width / 2, -height / 2),
    screen(width / 2, height / 2),
    screen(-width / 2, height / 2),
  ];
  return corners.some(
    (corner, index) =>
      distance({ x: event.clientX, y: event.clientY }, corner, corners[(index + 1) % 4]!) <= 10,
  );
}

export function createImageEditorTextFrameGestureController({
  canvas,
  fabric,
  onTextClickAway,
  isInteractionLocked,
  saveHistory,
}: {
  canvas: import('fabric').Canvas;
  fabric: typeof import('fabric');
  onTextClickAway: () => void;
  isInteractionLocked: () => boolean;
  saveHistory: () => void;
}) {
  const element = canvas.upperCanvasEl;
  if (
    typeof element.addEventListener !== 'function' ||
    typeof element.removeEventListener !== 'function'
  )
    return { cancel: () => false, dispose: () => {}, isActive: () => false };
  let disposing = false,
    active: {
      text: import('fabric').IText;
      start: Point;
      initial: Snapshot;
      pointerId: number;
    } | null = null;
  let release = () => {};
  const rollback = () => {
    if (!active) return false;
    restore(active.text, active.initial);
    if (!disposing) {
      reconcileImageEditorAttachedArrows({ canvas, fabric });
      canvas.setActiveObject(active.text);
      canvas.requestRenderAll();
    }
    active = null;
    return true;
  };
  const cancel = () => {
    release();
    return rollback();
  };
  const handlePointerDown = (event: PointerEvent) => {
    const text = canvas.getActiveObject() as import('fabric').IText | undefined,
      start = imageEditorPointer(canvas, event);
    if (disposing || !start || !text?.isEditing || !hitsFrame(canvas, text, event)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    text.exitEditing();
    onTextClickAway();
    canvas.setActiveObject(text);
    active = { text, start, initial: snapshot(text), pointerId: event.pointerId };
    const move = (next: PointerEvent) => {
      if (!active || next.pointerId !== active.pointerId) return;
      next.preventDefault();
      next.stopImmediatePropagation();
      const point = imageEditorPointer(canvas, next);
      if (!point) return;
      active.text.set({
        left: active.initial.left! + point.x - active.start.x,
        top: active.initial.top! + point.y - active.start.y,
      });
      active.text.setCoords();
      reconcileImageEditorAttachedArrows({ canvas, fabric });
    };
    const end = (next: PointerEvent) => {
      if (!active || next.pointerId !== active.pointerId) return;
      next.preventDefault();
      next.stopImmediatePropagation();
      release();
      const completed = active;
      active = null;
      const moved = Math.hypot(
        (completed.text.left ?? 0) - completed.initial.left!,
        (completed.text.top ?? 0) - completed.initial.top!,
      );
      if (isInteractionLocked() || moved < minimumGestureSize(canvas))
        restore(completed.text, completed.initial);
      else saveHistory();
      reconcileImageEditorAttachedArrows({ canvas, fabric });
      canvas.setActiveObject(completed.text);
      canvas.requestRenderAll();
    };
    const abort = (next: PointerEvent) => {
      if (active && next.pointerId === active.pointerId) {
        next.preventDefault();
        next.stopImmediatePropagation();
        cancel();
      }
    };
    release = () => {
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', end, true);
      element.removeEventListener('pointercancel', abort, true);
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
      release = () => {};
    };
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', end, true);
    element.addEventListener('pointercancel', abort, true);
    element.setPointerCapture(event.pointerId);
    return true;
  };
  element.addEventListener('pointerdown', handlePointerDown, true);
  return {
    cancel,
    dispose: () => {
      if (disposing) return;
      disposing = true;
      active = null;
      release();
      element.removeEventListener('pointerdown', handlePointerDown, true);
    },
    isActive: () => active != null,
  };
}
