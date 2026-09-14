import { useEffect, useRef, type MutableRefObject } from 'react';

import { addTextAnnotation } from './image-editor-actions';
import { installImageEditorAttachedArrowControl } from './image-editor-attached-arrow';
import { createArrow } from './image-editor-arrow';
import { createImageEditorTextFrameGestureController } from './image-editor-text-frame-gesture';
import { imageEditorBounds, imageEditorPointer, minimumGestureSize } from './image-editor-pointer';
import type { ImageEditorBounds } from './image-editor-pointer';
import { ConcealMode, ImageEditorObjectRole, ImageEditorTool } from './image-editor.types';

type Point = { x: number; y: number };
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
      kind: ImageEditorGestureSessionKind.Shape;
      tool: ImageEditorGestureTool;
      start: Point;
      object: import('fabric').FabricObject;
      config: Config;
    };

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
  onTextClickAway: (preserveSelection: boolean) => void;
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
    const textFrameController = createImageEditorTextFrameGestureController({
      canvas,
      fabric,
      isInteractionLocked: () => operationsRef.current.isInteractionLocked(),
      onTextClickAway: () => operationsRef.current.onTextClickAway(true),
      saveHistory: () => operationsRef.current.saveHistory(),
    });
    let tearingDown = false;
    let session: Session = { kind: ImageEditorGestureSessionKind.Idle };
    let textFrame: number | null = null;
    let finalBounds: ImageEditorBounds | null = null;
    let editingTransitionHandled = false;
    const reset = () => {
      const textFrameConsumed = textFrameController.cancel();
      const consumed =
        session.kind !== ImageEditorGestureSessionKind.Idle ||
        textFrame != null ||
        textFrameConsumed;
      const cancelled = cancelGestureSession(session);
      if (tearingDown) {
        session = cancelled.next;
        if (textFrame != null) cancelAnimationFrame(textFrame);
        textFrame = null;
        return consumed;
      }
      if (cancelled.transient) canvas.remove(cancelled.transient);
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
      const preserveSelection = !event.target;
      if (preserveSelection) canvas.setActiveObject(activeText);
      operationsRef.current.onTextClickAway(preserveSelection);
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
      const finalized = finalizeGestureSession(session);
      const completed = finalized.completed;
      session = finalized.next;
      if (completed.kind === ImageEditorGestureSessionKind.Idle) return;
      canvas.skipTargetFind = false;
      if (operationsRef.current.isInteractionLocked()) {
        if (completed.kind === ImageEditorGestureSessionKind.Shape) canvas.remove(completed.object);
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
    canvas.on('mouse:down:before', beforeDown);
    canvas.on('mouse:down', down);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', up);
    return () => {
      tearingDown = true;
      textFrameController.dispose();
      reset();
      cancelGestureRef.current = () => false;
      canvas.off('mouse:down:before', beforeDown);
      canvas.off('mouse:down', down);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', up);
    };
  }, [canvasReady, canvasRef, fabricRef, cancelGestureRef, hiddenTextareaContainer]);
}
