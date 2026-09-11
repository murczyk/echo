import { useEffect, useRef, type MutableRefObject } from 'react';

import { addTextAnnotation } from './image-editor-actions';
import {
  installImageEditorAttachedArrowControl,
  reconcileImageEditorAttachedArrows,
} from './image-editor-attached-arrow';
import { createArrow } from './image-editor-arrow';
import { imageEditorBounds, imageEditorPointer, minimumGestureSize } from './image-editor-pointer';
import type { ImageEditorBounds } from './image-editor-pointer';
import { ConcealMode, ImageEditorObjectRole, ImageEditorTool } from './image-editor.types';

type Point = { x: number; y: number };
type TextMoveSnapshot = {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  angle: number;
  text: string;
};
enum ImageEditorGestureSessionKind {
  Idle = 'idle',
  Text = 'text',
  Shape = 'shape',
}
type ImageEditorGestureTool =
  | ImageEditorTool.Rectangle
  | ImageEditorTool.Ellipse
  | ImageEditorTool.Line
  | ImageEditorTool.Arrow
  | ImageEditorTool.Conceal;
const GESTURE_TOOLS = new Set<ImageEditorTool>([
  ImageEditorTool.Rectangle,
  ImageEditorTool.Ellipse,
  ImageEditorTool.Line,
  ImageEditorTool.Arrow,
  ImageEditorTool.Conceal,
]);

function isImageEditorGestureTool(tool: ImageEditorTool): tool is ImageEditorGestureTool {
  return GESTURE_TOOLS.has(tool);
}

const OBJECT_ROLE_BY_GESTURE_TOOL = {
  [ImageEditorTool.Rectangle]: ImageEditorObjectRole.Rectangle,
  [ImageEditorTool.Ellipse]: ImageEditorObjectRole.Ellipse,
  [ImageEditorTool.Line]: ImageEditorObjectRole.Line,
  [ImageEditorTool.Arrow]: ImageEditorObjectRole.Arrow,
  [ImageEditorTool.Conceal]: ImageEditorObjectRole.ConcealmentDraft,
} satisfies Record<ImageEditorGestureTool, ImageEditorObjectRole>;
type Config = {
  tool: ImageEditorTool;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  textBackgroundColor: string;
  textBackgroundEnabled: boolean;
  textBackgroundPadding: number;
  concealMode: ConcealMode;
  concealmentMarquee: { stroke: string; fill: string };
};
type Session =
  | { kind: ImageEditorGestureSessionKind.Idle }
  | { kind: ImageEditorGestureSessionKind.Text; point: Point; config: Config }
  | {
      kind: 'textMove';
      text: import('fabric').IText;
      start: Point;
      initial: TextMoveSnapshot;
    }
  | {
      kind: ImageEditorGestureSessionKind.Shape;
      tool: ImageEditorGestureTool;
      start: Point;
      object: import('fabric').FabricObject;
      config: Config;
    };

function textMoveSnapshot(text: import('fabric').IText): TextMoveSnapshot {
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

function restoreTextMoveSnapshot(text: import('fabric').IText, initial: TextMoveSnapshot) {
  text.set(initial);
  text.setCoords();
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const x = end.x - start.x;
  const y = end.y - start.y;
  const lengthSquared = x * x + y * y;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * x + (point.y - start.y) * y) / lengthSquared),
  );
  return Math.hypot(point.x - (start.x + x * ratio), point.y - (start.y + y * ratio));
}

function textFrameHitTest(
  canvas: import('fabric').Canvas,
  text: import('fabric').IText,
  event: PointerEvent,
) {
  const padding = text.get('annotationBackgroundEnabled')
    ? Number(text.get('annotationBackgroundPadding') ?? 0)
    : 0;
  const width = (text.width ?? 0) + padding * 2;
  const height = (text.height ?? 0) + padding * 2;
  const matrix = text.calcTransformMatrix();
  const viewport = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const screenPoint = (x: number, y: number) => {
    const sceneX = matrix[0] * x + matrix[2] * y + matrix[4];
    const sceneY = matrix[1] * x + matrix[3] * y + matrix[5];
    const viewportX = viewport[0] * sceneX + viewport[2] * sceneY + viewport[4];
    const viewportY = viewport[1] * sceneX + viewport[3] * sceneY + viewport[5];
    return {
      x: rect.left + (viewportX * rect.width) / canvas.width,
      y: rect.top + (viewportY * rect.height) / canvas.height,
    };
  };
  const corners = [
    screenPoint(-width / 2, -height / 2),
    screenPoint(width / 2, -height / 2),
    screenPoint(width / 2, height / 2),
    screenPoint(-width / 2, height / 2),
  ];
  const pointer = { x: event.clientX, y: event.clientY };
  return corners.some(
    (corner, index) => distanceToSegment(pointer, corner, corners[(index + 1) % 4]!) <= 10,
  );
}

function finalizeGestureSession(session: Session) {
  return { completed: session, next: { kind: ImageEditorGestureSessionKind.Idle } as Session };
}

function cancelGestureSession(session: Session) {
  return {
    next: { kind: ImageEditorGestureSessionKind.Idle } as Session,
    transient: session.kind === ImageEditorGestureSessionKind.Shape ? session.object : null,
  };
}

export function useImageEditorDrawingGestures({
  canvasRef,
  fabricRef,
  canvasReady,
  tool,
  toolRef,
  stroke,
  fill,
  strokeWidth,
  dash,
  fontSize,
  bold,
  textBackgroundColor,
  textBackgroundEnabled,
  textBackgroundPadding,
  concealMode,
  isInteractionLocked,
  saveHistory,
  replaceConcealmentArea,
  concealmentMarquee,
  cancelGestureRef,
  setError,
  hiddenTextareaContainer,
  onTextClickAway,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
  tool: ImageEditorTool;
  toolRef: MutableRefObject<ImageEditorTool>;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  textBackgroundColor: string;
  textBackgroundEnabled: boolean;
  textBackgroundPadding: number;
  concealMode: ConcealMode;
  isInteractionLocked: () => boolean;
  saveHistory: () => void;
  replaceConcealmentArea: (bounds: ImageEditorBounds, mode: ConcealMode) => Promise<void>;
  concealmentMarquee: { stroke: string; fill: string };
  cancelGestureRef: MutableRefObject<() => boolean>;
  setError: (error: string) => void;
  hiddenTextareaContainer: MutableRefObject<HTMLElement | null>;
  onTextClickAway: () => void;
}) {
  const configRef = useRef<Config>({
    tool,
    stroke,
    fill,
    strokeWidth,
    dash,
    fontSize,
    bold,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
    concealMode,
    concealmentMarquee,
  });
  const operationsRef = useRef({
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    setError,
    onTextClickAway,
  });
  configRef.current = {
    tool,
    stroke,
    fill,
    strokeWidth,
    dash,
    fontSize,
    bold,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
    concealMode,
    concealmentMarquee,
  };
  operationsRef.current = {
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    setError,
    onTextClickAway,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvasReady || !canvas || !fabric) return;
    const canvasElement = canvas.upperCanvasEl;
    let tearingDown = false;
    let session: Session = { kind: ImageEditorGestureSessionKind.Idle };
    let textFrame: number | null = null;
    let finalBounds: ImageEditorBounds | null = null;
    let editingTransitionHandled = false;
    let releaseTextFramePointer = () => {};
    const reset = () => {
      const consumed = session.kind !== ImageEditorGestureSessionKind.Idle || textFrame != null;
      const cancelled = cancelGestureSession(session);
      releaseTextFramePointer();
      if (tearingDown) {
        session = cancelled.next;
        if (textFrame != null) cancelAnimationFrame(textFrame);
        textFrame = null;
        return consumed;
      }
      if (cancelled.transient) canvas.remove(cancelled.transient);
      if (session.kind === 'textMove') {
        restoreTextMoveSnapshot(session.text, session.initial);
        reconcileImageEditorAttachedArrows({ canvas, fabric });
        canvas.setActiveObject(session.text);
      }
      canvas.skipTargetFind = false;
      session = cancelled.next;
      finalBounds = null;
      if (textFrame != null) cancelAnimationFrame(textFrame);
      textFrame = null;
      canvas.requestRenderAll();
      return consumed;
    };
    cancelGestureRef.current = reset;
    const pointer = (event: { e?: unknown }) => {
      const source = event.e as { clientX?: number; clientY?: number } | undefined;
      return source?.clientX == null || source.clientY == null
        ? null
        : imageEditorPointer(canvas, source as { clientX: number; clientY: number });
    };
    const moveTextFrame = (point: Point) => {
      if (session.kind !== 'textMove') return;
      session.text.set({
        left: session.initial.left + point.x - session.start.x,
        top: session.initial.top + point.y - session.start.y,
      });
      session.text.setCoords();
      reconcileImageEditorAttachedArrows({ canvas, fabric });
    };
    const completeTextFrameMove = () => {
      if (session.kind !== 'textMove') return false;
      const completed = session;
      session = { kind: ImageEditorGestureSessionKind.Idle };
      canvas.skipTargetFind = false;
      if (operationsRef.current.isInteractionLocked()) {
        restoreTextMoveSnapshot(completed.text, completed.initial);
        reconcileImageEditorAttachedArrows({ canvas, fabric });
        return true;
      }
      const moved = Math.hypot(
        (completed.text.left ?? 0) - completed.initial.left,
        (completed.text.top ?? 0) - completed.initial.top,
      );
      if (moved < minimumGestureSize(canvas)) {
        restoreTextMoveSnapshot(completed.text, completed.initial);
        reconcileImageEditorAttachedArrows({ canvas, fabric });
      } else {
        reconcileImageEditorAttachedArrows({ canvas, fabric });
        operationsRef.current.saveHistory();
      }
      canvas.setActiveObject(completed.text);
      canvas.requestRenderAll();
      return true;
    };
    const textFramePointerDown = (event: PointerEvent) => {
      const activeText = canvas.getActiveObject() as import('fabric').IText | undefined;
      const start = imageEditorPointer(canvas, event);
      if (!start || !activeText?.isEditing || !textFrameHitTest(canvas, activeText, event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const initial = textMoveSnapshot(activeText);
      activeText.exitEditing();
      operationsRef.current.onTextClickAway();
      canvas.setActiveObject(activeText);
      session = { kind: 'textMove', text: activeText, start, initial };
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        moveEvent.preventDefault();
        moveEvent.stopImmediatePropagation();
        const point = imageEditorPointer(canvas, moveEvent);
        if (point) moveTextFrame(point);
      };
      const onEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== event.pointerId) return;
        endEvent.preventDefault();
        endEvent.stopImmediatePropagation();
        releaseTextFramePointer();
        completeTextFrameMove();
      };
      const onCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== event.pointerId) return;
        cancelEvent.preventDefault();
        cancelEvent.stopImmediatePropagation();
        releaseTextFramePointer();
        reset();
      };
      releaseTextFramePointer = () => {
        canvasElement.removeEventListener('pointermove', onMove, true);
        canvasElement.removeEventListener('pointerup', onEnd, true);
        canvasElement.removeEventListener('pointercancel', onCancel, true);
        if (canvasElement.hasPointerCapture(event.pointerId))
          canvasElement.releasePointerCapture(event.pointerId);
        releaseTextFramePointer = () => {};
      };
      canvasElement.addEventListener('pointermove', onMove, true);
      canvasElement.addEventListener('pointerup', onEnd, true);
      canvasElement.addEventListener('pointercancel', onCancel, true);
      canvasElement.setPointerCapture(event.pointerId);
    };
    const beforeDown = (event: { e?: unknown; target?: import('fabric').FabricObject }) => {
      editingTransitionHandled = false;
      const point = pointer(event);
      const activeText = canvas.getActiveObject?.() as import('fabric').IText | undefined;
      if (!point || !activeText?.isEditing) return;
      if (event.target === activeText) {
        const bounds = activeText.getBoundingRect();
        const edge = Math.min(
          Math.abs(point.x - bounds.left),
          Math.abs(point.x - (bounds.left + bounds.width)),
          Math.abs(point.y - bounds.top),
          Math.abs(point.y - (bounds.top + bounds.height)),
        );
        if (edge > 12) return;
        return;
      }
      activeText.exitEditing();
      if (!event.target) canvas.setActiveObject(activeText);
      operationsRef.current.onTextClickAway();
      editingTransitionHandled = true;
      canvas.requestRenderAll();
    };
    const down = (event: { e?: unknown; target?: import('fabric').FabricObject }) => {
      const config = configRef.current;
      if (
        session.kind !== ImageEditorGestureSessionKind.Idle ||
        operationsRef.current.isInteractionLocked()
      )
        return;
      const point = pointer(event);
      if (!point) return;
      if (editingTransitionHandled) return;
      if (config.tool === ImageEditorTool.Text) {
        if (event.target instanceof fabric.IText) return;
        session = { kind: ImageEditorGestureSessionKind.Text, point, config };
        return;
      }
      if (!isImageEditorGestureTool(config.tool)) return;
      const tool = config.tool;
      const common = {
        originX: 'left' as const,
        originY: 'top' as const,
        selectable: false,
        evented: false,
        editorRole: OBJECT_ROLE_BY_GESTURE_TOOL[tool],
      };
      const object =
        tool === ImageEditorTool.Ellipse
          ? new fabric.Ellipse({
              ...common,
              left: point.x,
              top: point.y,
              rx: 1,
              ry: 1,
              stroke: config.stroke,
              strokeWidth: config.strokeWidth,
              strokeDashArray: config.dash
                ? [config.strokeWidth * 2, config.strokeWidth * 2]
                : undefined,
              fill: config.fill,
            })
          : tool === ImageEditorTool.Line || tool === ImageEditorTool.Arrow
            ? new fabric.Line([point.x, point.y, point.x, point.y], {
                stroke: config.stroke,
                strokeWidth: config.strokeWidth,
                strokeDashArray: config.dash
                  ? [config.strokeWidth * 2, config.strokeWidth * 2]
                  : undefined,
                selectable: false,
                evented: false,
                editorRole: OBJECT_ROLE_BY_GESTURE_TOOL[tool],
              })
            : new fabric.Rect({
                ...common,
                left: point.x,
                top: point.y,
                width: 1,
                height: 1,
                stroke:
                  tool === ImageEditorTool.Conceal
                    ? config.concealmentMarquee.stroke
                    : config.stroke,
                strokeWidth: tool === ImageEditorTool.Conceal ? 1 : config.strokeWidth,
                strokeDashArray:
                  tool === ImageEditorTool.Conceal
                    ? undefined
                    : config.dash
                      ? [config.strokeWidth * 2, config.strokeWidth * 2]
                      : undefined,
                fill:
                  tool === ImageEditorTool.Conceal ? config.concealmentMarquee.fill : config.fill,
                excludeFromExport: tool === ImageEditorTool.Conceal,
              });
      canvas.add(object);
      finalBounds = null;
      session = { kind: ImageEditorGestureSessionKind.Shape, tool, start: point, object, config };
    };
    const move = (event: { e?: unknown }) => {
      if (operationsRef.current.isInteractionLocked()) return reset();
      if (session.kind === 'textMove') {
        const point = pointer(event);
        if (!point) return;
        moveTextFrame(point);
        return;
      }
      if (session.kind !== ImageEditorGestureSessionKind.Shape) return;
      const point = pointer(event);
      if (!point) return;
      const square = Boolean((event.e as { shiftKey?: boolean })?.shiftKey);
      const bounds = imageEditorBounds(session.start, point, square, canvas);
      finalBounds = bounds;
      if (session.object instanceof fabric.Line) session.object.set({ x2: point.x, y2: point.y });
      else if (session.object instanceof fabric.Ellipse)
        session.object.set({
          left: bounds.left,
          top: bounds.top,
          rx: bounds.width / 2,
          ry: bounds.height / 2,
        });
      else session.object.set(bounds);
      session.object.setCoords();
      canvas.requestRenderAll();
    };
    const up = (event: { e?: unknown }) => {
      if (completeTextFrameMove()) return;
      const finalized = finalizeGestureSession(session);
      const completed = finalized.completed;
      session = finalized.next;
      if (completed.kind === ImageEditorGestureSessionKind.Idle) return;
      canvas.skipTargetFind = false;
      if (operationsRef.current.isInteractionLocked()) {
        if (completed.kind === ImageEditorGestureSessionKind.Shape) canvas.remove(completed.object);
        if (completed.kind === 'textMove') {
          restoreTextMoveSnapshot(completed.text, completed.initial);
          reconcileImageEditorAttachedArrows({ canvas, fabric });
        }
        return;
      }
      if (completed.kind === ImageEditorGestureSessionKind.Text) {
        const text = addTextAnnotation({
          canvas,
          fabric,
          stroke: completed.config.stroke,
          fontSize: completed.config.fontSize,
          bold: completed.config.bold,
          backgroundColor: completed.config.textBackgroundColor,
          backgroundEnabled: completed.config.textBackgroundEnabled,
          backgroundPadding: completed.config.textBackgroundPadding,
          left: completed.point.x,
          top: completed.point.y,
          hiddenTextareaContainer: hiddenTextareaContainer.current,
        });
        installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: saveHistory });
        textFrame = requestAnimationFrame(() => {
          textFrame = null;
          if (operationsRef.current.isInteractionLocked()) return canvas.remove(text);
          canvas.setActiveObject(text);
          text.enterEditing();
          const textarea = text.hiddenTextarea;
          const container = hiddenTextareaContainer.current;
          if (!textarea?.isConnected || !container?.contains(textarea)) {
            operationsRef.current.setError('Не вдалося активувати текстове поле');
            return;
          }
          textarea.focus();
          if (document.activeElement !== textarea) {
            operationsRef.current.setError('Не вдалося сфокусувати текстове поле');
            return;
          }
          text.selectAll();
          canvas.requestRenderAll();
        });
        return;
      }
      if (completed.kind !== ImageEditorGestureSessionKind.Shape) return;
      const point = pointer(event);
      const bounds = finalBounds;
      finalBounds = null;
      const threshold = minimumGestureSize(canvas);
      try {
        if (completed.tool === ImageEditorTool.Conceal) {
          canvas.remove(completed.object);
          if (bounds && bounds.width >= threshold && bounds.height >= threshold)
            void operationsRef.current
              .replaceConcealmentArea(bounds, completed.config.concealMode)
              .catch((cause) =>
                operationsRef.current.setError(
                  cause instanceof Error ? cause.message : 'Не вдалося застосувати розмиття',
                ),
              );
        } else if (completed.tool === ImageEditorTool.Arrow && point) {
          const arrow = createArrow({
            fabric,
            start: completed.start,
            end: point,
            stroke: completed.config.stroke,
            strokeWidth: completed.config.strokeWidth,
            dash: completed.config.dash,
          });
          canvas.remove(completed.object);
          if (arrow) {
            canvas.add(arrow);
            operationsRef.current.saveHistory();
          }
        } else if (
          completed.object instanceof fabric.Line
            ? point &&
              Math.hypot(point.x - completed.start.x, point.y - completed.start.y) >= threshold
            : bounds && bounds.width >= threshold && bounds.height >= threshold
        ) {
          completed.object.setCoords();
          operationsRef.current.saveHistory();
        } else canvas.remove(completed.object);
      } finally {
        canvas.requestRenderAll();
      }
    };
    const supportsTextFramePointer =
      typeof canvasElement.addEventListener === 'function' &&
      typeof canvasElement.removeEventListener === 'function';
    if (supportsTextFramePointer)
      canvasElement.addEventListener('pointerdown', textFramePointerDown, true);
    canvas.on('mouse:down:before', beforeDown);
    canvas.on('mouse:down', down);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', up);
    return () => {
      tearingDown = true;
      reset();
      if (supportsTextFramePointer)
        canvasElement.removeEventListener('pointerdown', textFramePointerDown, true);
      cancelGestureRef.current = () => false;
      canvas.off('mouse:down:before', beforeDown);
      canvas.off('mouse:down', down);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', up);
    };
  }, [canvasReady, canvasRef, fabricRef, cancelGestureRef, hiddenTextareaContainer]);
}
